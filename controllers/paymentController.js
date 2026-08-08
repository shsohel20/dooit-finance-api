// controllers/paymentController.js
//
// Payments and refunds against invoices.
//
// Access:
//   dooit  — record settlement, retry a failure, issue refunds, see everything
//   client — read its own payment history
//
// Writes are dooit-only until a gateway exists: without one, a client-initiated
// "Pay now" would be recording money movement that never happened. When a
// gateway lands, its webhook becomes the writer and this stays the manual path.
//
// Reference: docs/billingmodule/mongoose-schema.md §C.7, §G.7, §G.10

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Payment = require("../models/Payment");
const Invoice = require("../models/Invoice");
const { toDecimal, toNumber } = require("../utils/money");
const {
  assertActingAs,
  isDooit,
  actorId,
  USER_TYPE_DOOIT,
} = require("../services/billing/assertUserType");
const {
  reconcileInvoice,
  refundedTotalFor,
} = require("../services/billing/paymentService");
const { logEvent } = require("../utils/audit");

const scopeFor = (req) => (isDooit(req) ? {} : { user: actorId(req) });

/**
 * Did this write fail because the gateway transaction was already recorded?
 *
 * Two mechanisms can raise it and they look nothing alike: the DB's sparse
 * unique index raises E11000 on insert, while mongoose-unique-validator raises a
 * ValidationError BEFORE the insert (and wins the race in practice, since it
 * runs first). Checking only the Mongo code silently misses every replay.
 */
const isDuplicateTransaction = (err) =>
  err?.code === 11000 ||
  (err?.name === "ValidationError" && !!err.errors?.transactionId);

// ─────────────────────────────────────────────────────────────────────────────

// @desc   List payments
// @route  GET /api/v1/payment
// @access dooit → all; client → own only
exports.getPayments = asyncHandler(async (req, res) => {
  const { invoice, status, type, page = 1, limit = 50 } = req.query;

  const filter = { ...scopeFor(req) };
  if (invoice) filter.invoice = invoice;
  if (status && status !== "all") filter.status = status;
  if (type && type !== "all") filter.type = type;

  const result = await Payment.paginate(filter, {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(200, Math.max(1, parseInt(limit, 10) || 50)),
    sort: { createdAt: -1 },
    populate: [
      { path: "user", select: "name email" },
      { path: "invoice", select: "invoiceNumber periodKey total status" },
    ],
  });

  res.status(200).json({
    success: true,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.totalDocs,
      totalPages: result.totalPages,
    },
    data: result.docs,
  });
});

// @desc   Get one payment
// @route  GET /api/v1/payment/:id
// @access dooit → any; client → own only
exports.getPayment = asyncHandler(async (req, res, next) => {
  const payment = await Payment.findOne({ _id: req.params.id, ...scopeFor(req) })
    .populate("invoice", "invoiceNumber periodKey total status")
    .populate("user", "name email");
  if (!payment) return next(new ErrorResponse("Payment not found", 404));
  res.status(200).json({ success: true, data: payment });
});

// @desc   Record a payment against an invoice
// @route  POST /api/v1/payment
// @access dooit only
exports.recordPayment = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const {
    invoice: invoiceId,
    amount,
    method,
    methodLabel = null,
    transactionId,
    gateway = null,
    status = "paid",
    failureCode = null,
    failureReason = null,
  } = req.body;

  if (!invoiceId) return next(new ErrorResponse("invoice is required", 400));
  if (!method) return next(new ErrorResponse("method is required", 400));

  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));
  if (invoice.status === "void") {
    return next(new ErrorResponse("A void invoice cannot be paid", 409));
  }
  if (invoice.status === "draft") {
    return next(
      new ErrorResponse("Issue the invoice before recording a payment against it", 409)
    );
  }

  // Default to settling the balance, which is the common case.
  const value = amount == null ? toNumber(invoice.amountDue) : Number(amount);
  if (!(value > 0)) return next(new ErrorResponse("amount must be greater than zero", 400));

  // Overpayment is refused rather than silently absorbed: a credit balance has
  // no home in this schema, so accepting it would lose the money.
  if (status === "paid" && value > toNumber(invoice.amountDue) + 0.005) {
    return next(
      new ErrorResponse(
        `Amount ${value.toFixed(2)} exceeds the ${toNumber(invoice.amountDue).toFixed(2)} outstanding`,
        409
      )
    );
  }

  let payment;
  try {
    payment = await Payment.create({
      user: invoice.user,
      client: invoice.client,
      invoice: invoice._id,
      type: "payment",
      amount: toDecimal(value.toFixed(2)),
      currency: invoice.currency,
      method,
      methodLabel,
      transactionId: transactionId || undefined,
      gateway,
      status,
      failureCode,
      failureReason,
      createdBy: actorId(req),
    });
  } catch (err) {
    // A replayed gateway webhook must not double-post.
    if (transactionId && isDuplicateTransaction(err)) {
      const existing = await Payment.findOne({ transactionId });
      return res.status(200).json({
        success: true,
        data: existing,
        meta: { duplicate: true, note: "This transaction was already recorded." },
      });
    }
    throw err;
  }

  logEvent({
    req,
    service: "billing",
    action: "payment_recorded",
    user: invoice.user,
    ...(invoice.client ? { client: invoice.client } : {}),
    target: String(payment._id),
    afterValue: { amount: value, invoice: String(invoice._id) },
  });

  // A failed payment leaves the invoice untouched — it is still owed.
  const reconciled =
    status === "paid" ? await reconcileInvoice(invoice) : null;

  res.status(201).json({
    success: true,
    data: payment,
    meta: reconciled
      ? { invoiceStatus: invoice.status, amountDue: toNumber(invoice.amountDue) }
      : { invoiceStatus: invoice.status, note: "Payment failed — the invoice is still open." },
  });
});

// @desc   Retry a failed payment
// @route  POST /api/v1/payment/:id/retry
// @access dooit only
exports.retryPayment = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const failed = await Payment.findById(req.params.id);
  if (!failed) return next(new ErrorResponse("Payment not found", 404));
  if (failed.status !== "failed") {
    return next(new ErrorResponse(`Only a failed payment can be retried`, 409));
  }

  const invoice = await Invoice.findById(failed.invoice);
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));
  if (invoice.status === "void") {
    return next(new ErrorResponse("A void invoice cannot be paid", 409));
  }

  const { status = "paid", transactionId, failureReason = null } = req.body;

  // A retry is a NEW document. Editing the failed one would erase the fact that
  // it was ever attempted, and the dunning history is exactly what matters here.
  const retry = await Payment.create({
    user: failed.user,
    client: failed.client,
    invoice: failed.invoice,
    type: "payment",
    amount: failed.amount,
    currency: failed.currency,
    method: req.body.method || failed.method,
    methodLabel: req.body.methodLabel ?? failed.methodLabel,
    transactionId: transactionId || undefined,
    gateway: failed.gateway,
    status,
    failureReason: status === "failed" ? failureReason : null,
    retryOf: failed._id,
    retryCount: (failed.retryCount || 0) + 1,
    createdBy: actorId(req),
  });

  if (status === "paid") await reconcileInvoice(invoice);

  logEvent({
    req,
    service: "billing",
    action: "payment_retried",
    user: retry.user,
    ...(retry.client ? { client: retry.client } : {}),
    target: String(retry._id),
    afterValue: {
      amount: toNumber(retry.amount),
      originalPayment: String(failed._id),
      status,
    },
  });

  res.status(201).json({
    success: true,
    data: retry,
    meta: {
      attempt: retry.retryCount + 1,
      invoiceStatus: invoice.status,
      amountDue: toNumber(invoice.amountDue),
    },
  });
});

// @desc   Refund a payment (full or partial)
// @route  POST /api/v1/payment/:id/refund
// @access dooit only
exports.refundPayment = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const original = await Payment.findById(req.params.id);
  if (!original) return next(new ErrorResponse("Payment not found", 404));
  if (original.type === "refund") {
    return next(new ErrorResponse("A refund cannot itself be refunded", 409));
  }
  if (!["paid", "refunded"].includes(original.status)) {
    return next(
      new ErrorResponse(`Only a settled payment can be refunded (this one is ${original.status})`, 409)
    );
  }

  const collected = toNumber(original.amount);
  const alreadyRefunded = await refundedTotalFor(original._id);
  const remaining = +(collected - alreadyRefunded).toFixed(2);

  const value = req.body.amount == null ? remaining : Number(req.body.amount);
  if (!(value > 0)) return next(new ErrorResponse("amount must be greater than zero", 400));
  if (value > remaining + 0.005) {
    return next(
      new ErrorResponse(
        `Cannot refund ${value.toFixed(2)} — only ${remaining.toFixed(2)} of this payment remains unrefunded`,
        409
      )
    );
  }

  const refund = await Payment.create({
    user: original.user,
    client: original.client,
    invoice: original.invoice,
    type: "refund",
    // Positive: `type` carries the direction, so "collected" stays answerable.
    amount: toDecimal(value.toFixed(2)),
    currency: original.currency,
    method: req.body.method || original.method,
    methodLabel: original.methodLabel,
    status: "paid",
    refundOf: original._id,
    refundReason: req.body.reason || "Refund",
    createdBy: actorId(req),
  });

  // Mark the original refunded only when nothing is left to refund.
  const nowRefunded = +(alreadyRefunded + value).toFixed(2);
  if (nowRefunded >= collected - 0.005) {
    original.status = "refunded";
    original.refundedAt = new Date();
    await original.save();
  }

  const invoice = await Invoice.findById(original.invoice);
  const reconciled = invoice ? await reconcileInvoice(invoice) : null;

  logEvent({
    req,
    service: "billing",
    action: "payment_refunded",
    user: refund.user,
    ...(refund.client ? { client: refund.client } : {}),
    target: String(refund._id),
    afterValue: { amount: value, originalPayment: String(original._id) },
  });

  res.status(201).json({
    success: true,
    data: refund,
    meta: {
      partial: nowRefunded < collected - 0.005,
      refundedToDate: nowRefunded,
      originalAmount: collected,
      invoiceStatus: invoice?.status,
      amountDue: reconciled?.due,
    },
  });
});

// @desc   Payment summary for an invoice
// @route  GET /api/v1/payment/for-invoice/:invoiceId
// @access dooit → any; client → own
exports.getInvoicePayments = asyncHandler(async (req, res, next) => {
  const invoice = await Invoice.findOne({
    _id: req.params.invoiceId,
    ...scopeFor(req),
  });
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));

  const payments = await Payment.find({ invoice: invoice._id }).sort({ createdAt: 1 });

  const collected = payments
    .filter((p) => p.type === "payment" && ["paid", "refunded"].includes(p.status))
    .reduce((s, p) => s + toNumber(p.amount), 0);
  const refunded = payments
    .filter((p) => p.type === "refund" && p.status === "paid")
    .reduce((s, p) => s + toNumber(p.amount), 0);

  res.status(200).json({
    success: true,
    data: payments,
    meta: {
      collected: +collected.toFixed(2),
      refunded: +refunded.toFixed(2),
      net: +(collected - refunded).toFixed(2),
      amountDue: toNumber(invoice.amountDue),
      attempts: payments.filter((p) => p.type === "payment").length,
      failures: payments.filter((p) => p.status === "failed").length,
    },
  });
});
