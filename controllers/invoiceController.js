// controllers/invoiceController.js
//
// Invoices — period statements produced by the close job.
//
// Access:
//   dooit  — close periods, issue, void, reissue, see every account
//   client — read its own invoices only
//
// An issued invoice is never edited. A correction is void + reissue, and both
// documents persist.
//
// Reference: docs/billingmodule/schema-design.md §11, §G.8

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Invoice = require("../models/Invoice");
const Subscription = require("../models/Subscription");
const UsageRecord = require("../models/UsageRecord");
const { toDecimal, serializeDecimals } = require("../utils/money");
const {
  assertActingAs,
  isDooit,
  actorId,
  USER_TYPE_DOOIT,
} = require("../services/billing/assertUserType");
const {
  buildInvoiceDraft,
  periodBounds,
  closeSubscriptionPeriod,
  issueInvoiceDoc,
  sweepOverdueInvoices,
} = require("../services/billing/invoiceService");
const {
  renderInvoiceHtml,
  renderInvoicePdf,
  isBrowserUnavailable,
} = require("../services/billing/invoiceDocument");
const { deliverInvoiceEmail } = require("../services/billing/invoiceMailer");

const scopeFor = (req) => (isDooit(req) ? {} : { user: actorId(req) });

// ─────────────────────────────────────────────────────────────────────────────

// @desc   List invoices
// @route  GET /api/v1/invoice
// @access dooit → all; client → own only
exports.getInvoices = asyncHandler(async (req, res) => {
  const { status, subscription, periodKey, page = 1, limit = 50 } = req.query;

  const filter = { ...scopeFor(req) };
  if (status && status !== "all") filter.status = status;
  if (subscription) filter.subscription = subscription;
  if (periodKey) filter.periodKey = periodKey;

  const result = await Invoice.paginate(filter, {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(200, Math.max(1, parseInt(limit, 10) || 50)),
    sort: { periodKey: -1, createdAt: -1 },
    populate: [{ path: "user", select: "name email" }],
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

// @desc   Get one invoice
// @route  GET /api/v1/invoice/:id
// @access dooit → any; client → own only
exports.getInvoice = asyncHandler(async (req, res, next) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, ...scopeFor(req) }).populate(
    "user",
    "name email"
  );
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));
  res.status(200).json({ success: true, data: invoice });
});

// @desc   Preview what a period would invoice — writes nothing
// @route  GET /api/v1/invoice/preview
// @access dooit → any (?subscription=); client → own
exports.previewInvoice = asyncHandler(async (req, res, next) => {
  const { subscription: subId, periodKey } = req.query;
  if (!subId || !periodKey) {
    return next(new ErrorResponse("subscription and periodKey are required", 400));
  }

  const sub = await Subscription.findOne({ _id: subId, ...scopeFor(req) });
  if (!sub) return next(new ErrorResponse("Subscription not found", 404));

  const draft = await buildInvoiceDraft(sub, periodKey, {
    taxRatePercent: Number(req.query.taxRatePercent) || 0,
  });
  const { _usageIds, ...preview } = draft;

  // A preview is a plain object, not a Mongoose document, so the schema's
  // toJSON transform never runs — without this the endpoint leaks
  // {"$numberDecimal":"1900.00"} where every other endpoint returns a number.
  res.status(200).json({
    success: true,
    data: serializeDecimals({ ...preview, periodKey, ...periodBounds(periodKey) }),
    meta: { usageRecords: _usageIds.length, persisted: false },
  });
});

// @desc   Close a period and produce a DRAFT invoice
// @route  POST /api/v1/invoice/close
// @access dooit only
exports.closePeriod = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const { subscription: subId, periodKey, taxRatePercent = 0 } = req.body;
  if (!subId || !periodKey) {
    return next(new ErrorResponse("subscription and periodKey are required", 400));
  }

  const sub = await Subscription.findById(subId);
  if (!sub) return next(new ErrorResponse("Subscription not found", 404));

  // Shared with the renewal sweep (services/billing/billingCycleJob.js) so a
  // period closes identically whether a human or the job closed it.
  const { invoice, usageBilled, alreadyClosed } = await closeSubscriptionPeriod(
    sub,
    periodKey,
    { taxRatePercent, closedBy: actorId(req) }
  );

  if (alreadyClosed) {
    return next(
      new ErrorResponse(
        `Period ${periodKey} is already invoiced (${invoice.invoiceNumber || invoice._id}, ${invoice.status})`,
        409
      )
    );
  }

  res.status(201).json({
    success: true,
    data: invoice,
    meta: { usageRecordsBilled: usageBilled },
  });
});

// @desc   Issue a draft — allocates the invoice number
// @route  POST /api/v1/invoice/:id/issue
// @access dooit only
exports.issueInvoice = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));
  if (invoice.status !== "draft") {
    return next(new ErrorResponse(`A ${invoice.status} invoice cannot be issued`, 409));
  }

  await issueInvoiceDoc(invoice, { dueDays: req.body.dueDays });

  res.status(200).json({ success: true, data: invoice });
});

// @desc   Void an invoice and release its usage
// @route  POST /api/v1/invoice/:id/void
// @access dooit only
exports.voidInvoice = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));
  if (invoice.status === "void") {
    return next(new ErrorResponse("Already void", 409));
  }
  if (invoice.status === "paid") {
    return next(
      new ErrorResponse("A paid invoice cannot be voided — issue a refund instead", 409)
    );
  }

  invoice.status = "void";
  invoice.voidedAt = new Date();
  invoice.voidReason = req.body.reason || "Voided";
  await invoice.save();

  // Release the usage so it can be re-invoiced. Without this the work would be
  // billed to nothing and silently disappear from revenue.
  const released = await UsageRecord.updateMany(
    { invoice: invoice._id },
    { $set: { status: "recorded", invoice: null, billedAt: null } }
  );

  res.status(200).json({
    success: true,
    data: invoice,
    meta: {
      usageReleased: released.modifiedCount ?? 0,
      note: "Usage has been released and can be re-invoiced for this period.",
    },
  });
});

// @desc   Mark an invoice paid (payments land properly in step 6)
// @route  POST /api/v1/invoice/:id/mark-paid
// @access dooit only
exports.markPaid = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));
  if (!["open", "overdue"].includes(invoice.status)) {
    return next(new ErrorResponse(`A ${invoice.status} invoice cannot be paid`, 409));
  }

  invoice.amountPaid = invoice.total;
  invoice.amountDue = toDecimal(0);
  invoice.status = "paid";
  invoice.paidAt = new Date();
  await invoice.save();

  res.status(200).json({ success: true, data: invoice });
});

// @desc   Flag open invoices past their due date
// @route  POST /api/v1/invoice/sweep-overdue
// @access dooit only
// @desc   Email an issued invoice to the account it bills
// @route  POST /api/v1/invoice/:id/send
// @access dooit only
exports.sendInvoice = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));

  // A draft has no invoice number and is still being assembled — sending one would
  // put a document in a customer's inbox that the platform does not consider
  // issued, and whose number would differ once it was. Void is self-evident.
  if (invoice.status === "draft") {
    return next(
      new ErrorResponse("Issue the invoice before sending it — a draft has no number", 409)
    );
  }
  if (invoice.status === "void") {
    return next(new ErrorResponse("A void invoice cannot be sent", 409));
  }

  if (!process.env.SMTP_EMAIL) {
    return next(
      new ErrorResponse("Email is not configured on this deployment (SMTP_EMAIL)", 503)
    );
  }

  // `to` may override the account address for a one-off (an accounts-payable
  // mailbox). It never changes where the invoice is addressed, only where this
  // copy is delivered — so the invoice's own billed-to details are untouched.
  const override = typeof req.body.to === "string" ? req.body.to.trim() : null;
  if (override && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(override)) {
    return next(new ErrorResponse(`"${override}" is not a valid email address`, 400));
  }

  let delivery;
  try {
    // Shared with the overdue reminders in invoiceDunning.js, so a chased
    // invoice renders identically to the one it is chasing.
    delivery = await deliverInvoiceEmail(invoice, {
      to: override,
      subject: `Invoice ${invoice.invoiceNumber} from ${process.env.FROM_NAME || "dooit.ai"}`,
    });
  } catch (err) {
    // Do NOT stamp sentAt when delivery failed — the record would then claim
    // the customer was invoiced when nothing left the building.
    return next(
      new ErrorResponse(
        err.statusCode === 422 ? err.message : `Could not send the invoice: ${err.message}`,
        err.statusCode || 502
      )
    );
  }

  invoice.sentAt = new Date();
  invoice.sentCount = (invoice.sentCount || 0) + 1;
  invoice.lastSentTo = delivery.maskedTo;
  await invoice.save();

  res.status(200).json({
    success: true,
    data: invoice,
    meta: {
      // Masked: the caller's role may not be entitled to read the address, and
      // this endpoint is not the place to hand it over.
      sentTo: delivery.maskedTo,
      pdfAttached: delivery.pdfAttached,
      resend: invoice.sentCount > 1,
    },
  });
});

// @desc   Download an invoice as a PDF
// @route  GET /api/v1/invoice/:id/pdf
// @access dooit → any; client → own only
exports.downloadInvoicePdf = asyncHandler(async (req, res, next) => {
  const invoice = await Invoice.findOne({
    _id: req.params.id,
    ...scopeFor(req),
  }).populate("user", "name email");
  if (!invoice) return next(new ErrorResponse("Invoice not found", 404));

  const html = renderInvoiceHtml(invoice, { accountName: invoice.user?.name });

  let pdf;
  try {
    pdf = await renderInvoicePdf(html);
  } catch (err) {
    // Carry the cause. This previously collapsed every failure into one opaque
    // message with nothing logged, so a deployment that never downloaded its
    // headless browser looked exactly like a corrupt invoice — and neither was
    // diagnosable from the response.
    console.error(`[billing] invoice PDF render failed for ${invoice._id}:`, err);
    return next(
      isBrowserUnavailable(err)
        ? new ErrorResponse(
            "PDF rendering is unavailable on this deployment: the headless browser is not " +
              "installed. Run `npx puppeteer browsers install chrome` on the API host. The " +
              "invoice itself is intact and can still be viewed or emailed.",
            503
          )
        : new ErrorResponse(`Could not render the invoice PDF: ${err.message}`, 500)
    );
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${invoice.invoiceNumber || `invoice-${invoice._id}`}.pdf`
  );
  res.send(pdf);
});

// Also runs hourly from the billing cycle sweep; this stays as the manual path.
exports.sweepOverdue = asyncHandler(async (req, res) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const markedOverdue = await sweepOverdueInvoices();

  res.status(200).json({ success: true, data: { markedOverdue } });
});
