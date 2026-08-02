// controllers/usageController.js
//
// Metered usage — the append-only record of what a customer consumed.
//
// Access model:
//   WRITE  — dooit / internal meter producers only. A client never self-reports
//            usage; the platform meters it when the customer consumes a service.
//   READ   — dooit sees everything, a client sees its own.
//
// Nothing here mutates a usage record. Corrections append a reversing record so
// every historical invoice stays reproducible.
//
// Reference: docs/billingmodule/schema-design.md §15.1–§15.4

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const UsageRecord = require("../models/UsageRecord");
const Subscription = require("../models/Subscription");
const Product = require("../models/Product");
const { toNumber } = require("../utils/money");
const {
  assertActingAs,
  isDooit,
  actorId,
  USER_TYPE_DOOIT,
} = require("../services/billing/assertUserType");
const {
  periodKeysFor,
  composeIdempotencyKey,
  resolveUnitPrice,
  lineAmount,
  isLateArrival,
} = require("../services/billing/usageService");

const scopeFor = (req) => (isDooit(req) ? {} : { user: actorId(req) });

/** Build (but do not save) a usage record from a raw meter event. */
const buildRecord = async (event, { actor }) => {
  const {
    subscription: subscriptionId,
    productCode,
    quantity = 1,
    usageDate,
    applicantKey = null,
    source = {},
    externalId,
    ordinal = 1,
    metadata = {},
  } = event;

  if (!subscriptionId) throw new ErrorResponse("subscription is required", 400);
  if (!productCode) throw new ErrorResponse("productCode is required", 400);

  const sub = await Subscription.findById(subscriptionId);
  if (!sub) throw new ErrorResponse(`Subscription not found: ${subscriptionId}`, 404);
  if (["cancelled", "expired"].includes(sub.status)) {
    // Still recorded — the work happened and the cost was incurred. Flagged so
    // the close job can decide, rather than dropped here.
    // (falls through)
  }

  const product = await Product.findOne({ code: String(productCode).toLowerCase() });
  if (!product) throw new ErrorResponse(`Unknown product: ${productCode}`, 400);

  const when = usageDate ? new Date(usageDate) : new Date();
  if (Number.isNaN(when.getTime())) throw new ErrorResponse("usageDate is invalid", 400);

  const { periodKey, dayKey } = periodKeysFor(when);
  const { unitPrice, priceSource, entitled } = resolveUnitPrice(sub, product);

  const idempotencyKey = composeIdempotencyKey({
    system: source.system || "internal",
    externalId: externalId || source.externalId,
    productCode: product.code,
    ordinal,
  });

  return {
    user: sub.user,
    client: sub.client,
    subscription: sub._id,
    plan: sub.plan,

    product: product._id,
    productCode: product.code,
    productName: product.name,
    category: product.category,
    unit: product.unit,

    quantity: Number(quantity),
    unitPrice,
    amount: lineAmount(quantity, unitPrice),
    currency: sub.priceSnapshot?.currency || "AUD",
    priceSource,

    usageDate: when,
    periodKey,
    dayKey,
    applicantKey: applicantKey ? String(applicantKey) : null,
    idempotencyKey,

    source: {
      system: source.system || "internal",
      refType: source.refType || null,
      refId: source.refId || null,
      externalId: externalId || source.externalId || null,
    },

    // A product the plan does not entitle is recorded and priced, then excluded
    // from billing — never dropped. Usage that was not sold still has to be
    // answerable.
    status: entitled ? "recorded" : "excluded",
    exclusionReason: entitled
      ? null
      : `Product "${product.code}" is not entitled by plan ${sub.planCode} v${sub.planVersion}`,

    isLate: isLateArrival(periodKey, sub),
    metadata: { ...metadata, recordedBy: String(actor) },
  };
};

// ─────────────────────────────────────────────────────────────────────────────

// @desc   Record a billable event
// @route  POST /api/v1/usage
// @access dooit only (internal meter producers)
exports.recordUsage = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  let doc;
  try {
    doc = await buildRecord(req.body, { actor: actorId(req) });
  } catch (err) {
    return next(err instanceof ErrorResponse ? err : new ErrorResponse(err.message, 400));
  }

  try {
    const created = await UsageRecord.create(doc);
    return res.status(201).json({ success: true, data: created });
  } catch (err) {
    // A replayed webhook is a NO-OP, not an error. Return the record that
    // already exists with 200 so the producer stops retrying.
    if (err.code === 11000) {
      const existing = await UsageRecord.findOne({ idempotencyKey: doc.idempotencyKey });
      return res.status(200).json({
        success: true,
        data: existing,
        meta: { duplicate: true, note: "Already recorded — returned the existing record." },
      });
    }
    throw err;
  }
});

// @desc   Record many events in one call
// @route  POST /api/v1/usage/bulk
// @access dooit only
exports.recordUsageBulk = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const events = Array.isArray(req.body) ? req.body : req.body?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return next(new ErrorResponse("Body must be an array of events, or { events: [] }", 400));
  }
  if (events.length > 1000) {
    return next(new ErrorResponse("Bulk ingestion is limited to 1000 events", 400));
  }

  const results = { recorded: 0, duplicates: 0, excluded: 0, failed: [] };

  // Sequential rather than insertMany: one bad row must not abort the batch, and
  // a duplicate is a success (already recorded), not a failure.
  for (const [i, event] of events.entries()) {
    try {
      const doc = await buildRecord(event, { actor: actorId(req) });
      try {
        const created = await UsageRecord.create(doc);
        results.recorded += 1;
        if (created.status === "excluded") results.excluded += 1;
      } catch (err) {
        if (err.code === 11000) results.duplicates += 1;
        else throw err;
      }
    } catch (err) {
      results.failed.push({ index: i, error: err.message });
    }
  }

  res.status(200).json({ success: results.failed.length === 0, data: results });
});

// @desc   Records a manual usage entry can be attributed to
// @route  GET /api/v1/usage/references?subscription=<id>&refType=Customer&search=
// @access dooit only
//
// Backfilling a lost meter event means naming WHO it was for. Without this the
// operator had to paste a raw ObjectId into two free-text boxes and hope, which
// is how `applicantKey` ends up wrong — and a wrong applicant key silently
// mis-counts the plan allowance (§15.1), because the allowance is denominated in
// distinct applicants rather than events.
//
// Scoped by the SUBSCRIPTION being billed, not by the caller: usage can only
// ever be attributed to a customer of the account that is paying for it, so the
// subscription's client is the correct and narrowest bound.
//
// Only `uid` is returned as the label. Customer names live in encrypted paths
// that roleEncryptionPlugin masks to "***" without a decrypt grant, so a picker
// built on names would read as a column of asterisks for most operators — and
// `uid` is what an operator actually has to hand when backfilling anyway.
exports.getUsageReferences = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const { subscription: subId, refType = "Customer", search = "", limit = 25 } = req.query;
  if (!subId) return next(new ErrorResponse("subscription is required", 400));

  if (!["Customer", "Case"].includes(refType)) {
    return next(new ErrorResponse(`"${refType}" is not a referenceable record type`, 400));
  }

  const sub = await Subscription.findById(subId).select("client user");
  if (!sub) return next(new ErrorResponse("Subscription not found", 404));

  // A subscription with no company recorded cannot be narrowed to a customer
  // set. Say so rather than returning every customer on the platform.
  if (!sub.client) {
    return res.status(200).json({
      success: true,
      data: [],
      meta: {
        reason:
          "This subscription has no client company recorded, so its customers cannot be listed.",
      },
    });
  }

  const cap = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const term = String(search).trim();
  // Escaped: a uid search is operator input and must not be able to compile
  // into a pattern that scans the collection.
  const rx = term ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;

  let rows = [];
  if (refType === "Customer") {
    const Customer = require("../models/Customer");
    const filter = { "relations.client": sub.client };
    if (rx) filter.uid = rx;

    // .lean() and an explicit projection: nothing here needs a full document,
    // and narrowing the projection keeps encrypted paths out of the response
    // entirely rather than relying on them being masked.
    const docs = await Customer.find(filter).select("uid relations.type").limit(cap).lean();
    rows = docs.map((c) => ({
      _id: c._id,
      uid: c.uid || null,
      type: c.relations?.[0]?.type || null,
    }));
  } else {
    const Case = require("../models/Case");
    const filter = { client: sub.client };
    if (rx) filter.uid = rx;

    const docs = await Case.find(filter).select("uid title status").limit(cap).lean();
    rows = docs.map((c) => ({
      _id: c._id,
      uid: c.uid || null,
      title: c.title || null,
      type: c.status || null,
    }));
  }

  res.status(200).json({ success: true, data: rows });
});

// @desc   List usage records
// @route  GET /api/v1/usage
// @access dooit → all; client → own only
exports.getUsage = asyncHandler(async (req, res) => {
  const {
    subscription,
    productCode,
    periodKey,
    status,
    user,
    from,
    to,
    page = 1,
    limit = 50,
  } = req.query;

  const filter = { ...scopeFor(req) };
  if (subscription) filter.subscription = subscription;
  // dooit only — scopeFor already pins a client to its own records, and
  // honouring `user` for a client would let it read another account's meter.
  if (user && isDooit(req)) filter.user = user;
  if (productCode) filter.productCode = String(productCode).toLowerCase();
  if (periodKey) filter.periodKey = periodKey;
  if (status && status !== "all") filter.status = status;
  if (from || to) {
    filter.usageDate = {};
    if (from) filter.usageDate.$gte = new Date(from);
    if (to) filter.usageDate.$lte = new Date(to);
  }

  const result = await UsageRecord.paginate(filter, {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(500, Math.max(1, parseInt(limit, 10) || 50)),
    sort: { usageDate: -1 },
    // dooit reads across accounts, so a row is ambiguous without the account
    // on it. A client sees only its own records and needs no such column.
    ...(isDooit(req) ? { populate: [{ path: "user", select: "name email" }] } : {}),
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

// @desc   Period summary — totals by product and by day
// @route  GET /api/v1/usage/summary
// @access dooit → any (with ?subscription=); client → own
exports.getUsageSummary = asyncHandler(async (req, res, next) => {
  const { subscription, periodKey, user } = req.query;
  const { Types } = require("mongoose");

  // `excluded` is in the billable set: unentitled usage is charged at list
  // price, so omitting it here would under-report what the customer owes.
  const match = {
    ...scopeFor(req),
    status: { $in: ["recorded", "billed", "excluded"] },
  };
  if (subscription) match.subscription = new Types.ObjectId(subscription);
  // Only dooit may narrow to another account; scopeFor already pinned a client
  // to itself, and letting `user` through for a client would let it read
  // someone else's meter by editing a query string.
  if (user && isDooit(req)) match.user = new Types.ObjectId(user);
  if (periodKey) match.periodKey = periodKey;
  else {
    // Default to the caller's CURRENT period, derived in the account timezone.
    match.periodKey = periodKeysFor(new Date()).periodKey;
  }

  // Entitled vs not is split on `exclusionReason`, NOT on `status`.
  //
  // Status is a lifecycle (recorded → billed) and unentitled records pass
  // through it just like entitled ones once they are invoiced. Splitting on
  // status would therefore move a product out of the "not in your plan" bucket
  // the moment its period closed, which is precisely when someone goes looking
  // for it. `exclusionReason` is set once at ingest and never cleared.
  const entitledMatch = { ...match, exclusionReason: null };
  const excludedMatch = { ...match, exclusionReason: { $ne: null } };

  const [byProduct, byDay, applicants, excludedByProduct] = await Promise.all([
    UsageRecord.aggregate([
      { $match: entitledMatch },
      {
        $group: {
          _id: { code: "$productCode", name: "$productName", category: "$category" },
          quantity: { $sum: "$quantity" },
          amount: { $sum: "$amount" },
          events: { $sum: 1 },
        },
      },
      { $sort: { amount: -1 } },
    ]),
    UsageRecord.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$dayKey",
          quantity: { $sum: "$quantity" },
          amount: { $sum: "$amount" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Distinct applicants — the denominator a plan allowance is measured in
    // (§15.1). One applicant across many products counts ONCE.
    //
    // ENTITLED only. An applicant seen solely through a product outside the
    // plan is already being charged per use; letting them also consume the
    // included-applicant quota would push the account into overage for usage it
    // has separately paid list price for — billing the same event twice.
    UsageRecord.distinct("applicantKey", {
      ...entitledMatch,
      applicantKey: { $ne: null },
    }),
    UsageRecord.aggregate([
      { $match: excludedMatch },
      {
        $group: {
          _id: { code: "$productCode", name: "$productName", category: "$category" },
          quantity: { $sum: "$quantity" },
          amount: { $sum: "$amount" },
          events: { $sum: 1 },
        },
      },
      { $sort: { amount: -1 } },
    ]),
  ]);

  const totalAmount = byProduct.reduce((s, r) => s + toNumber(r.amount), 0);

  // ── Per-account breakdown ────────────────────────────────────────────────
  // dooit only. A client is already scoped to itself, so this would be a
  // single row restating the totals above — and shipping the shape at all
  // would invite a UI that renders other accounts' names when it should not.
  //
  // Distinct applicants are collected with $addToSet rather than counted,
  // because the allowance is denominated in applicants and one applicant
  // running several checks must count ONCE (§15.1) — summing events per
  // account would overstate every row.
  let byAccount = [];
  if (isDooit(req)) {
    const grouped = await UsageRecord.aggregate([
      { $match: match },
      {
        $group: {
          _id: { user: "$user", client: "$client" },
          quantity: { $sum: "$quantity" },
          amount: { $sum: "$amount" },
          events: { $sum: 1 },
          applicants: { $addToSet: "$applicantKey" },
          subscriptions: { $addToSet: "$subscription" },
          products: { $addToSet: "$productCode" },
        },
      },
      { $sort: { amount: -1 } },
    ]);

    // Names are resolved THROUGH Mongoose, not with a $lookup in the pipeline:
    // aggregation bypasses roleEncryptionPlugin, so a lookup would hand back
    // raw ciphertext (or a plaintext address the caller may not be entitled to
    // read). Going through the model keeps the same masking every other
    // endpoint applies.
    const User = require("../models/User");
    const Client = require("../models/Client");

    const userIds = grouped.map((g) => g._id.user).filter(Boolean);
    const clientIds = grouped.map((g) => g._id.client).filter(Boolean);

    const [users, clients] = await Promise.all([
      userIds.length ? User.find({ _id: { $in: userIds } }).select("name email") : [],
      clientIds.length ? Client.find({ _id: { $in: clientIds } }).select("name") : [],
    ]);

    const userById = new Map(users.map((u) => [String(u._id), u]));
    const clientById = new Map(clients.map((c) => [String(c._id), c]));

    byAccount = grouped.map((g) => {
      const u = userById.get(String(g._id.user));
      const c = clientById.get(String(g._id.client));
      return {
        user: g._id.user,
        userName: u?.name ?? null,
        userEmail: u?.email ?? null,
        client: g._id.client ?? null,
        clientName: c?.name ?? null,
        subscriptions: g.subscriptions.length,
        products: g.products.length,
        quantity: g.quantity,
        events: g.events,
        distinctApplicants: g.applicants.filter((a) => a != null).length,
        amount: Number(toNumber(g.amount).toFixed(2)),
      };
    });
  }

  res.status(200).json({
    success: true,
    data: {
      periodKey: match.periodKey,
      scope: {
        // So the UI can say what it is showing rather than inferring it.
        allAccounts: isDooit(req) && !user && !subscription,
        user: user || null,
        subscription: subscription || null,
      },
      accounts: byAccount.length,
      byAccount,
      totals: {
        amount: Number(totalAmount.toFixed(2)),
        quantity: byProduct.reduce((s, r) => s + r.quantity, 0),
        events: byProduct.reduce((s, r) => s + r.events, 0),
        distinctApplicants: applicants.length,
        // `amount` and `distinctApplicants` above cover ENTITLED usage only.
        // Excluded usage is charged, so it is a real cost to the customer — but
        // it is reported apart because it is priced by a different rule (list
        // price per event, not the applicant allowance) and because "what are
        // we consuming outside our plan" is a question worth being able to ask.
        excludedEvents: excludedByProduct.reduce((s, r) => s + r.events, 0),
        excludedQuantity: excludedByProduct.reduce((s, r) => s + r.quantity, 0),
        excludedProducts: excludedByProduct.length,
        excludedAmount: Number(
          excludedByProduct.reduce((s, r) => s + toNumber(r.amount), 0).toFixed(2)
        ),
      },
      byProduct: byProduct.map((r) => ({
        productCode: r._id.code,
        productName: r._id.name,
        category: r._id.category,
        quantity: r.quantity,
        events: r.events,
        amount: Number(toNumber(r.amount).toFixed(2)),
      })),
      // Identical shape to byProduct so one component renders both.
      excludedByProduct: excludedByProduct.map((r) => ({
        productCode: r._id.code,
        productName: r._id.name,
        category: r._id.category,
        quantity: r.quantity,
        events: r.events,
        amount: Number(toNumber(r.amount).toFixed(2)),
      })),
      byDay: byDay.map((r) => ({
        dayKey: r._id,
        quantity: r.quantity,
        amount: Number(toNumber(r.amount).toFixed(2)),
      })),
    },
  });
});

// @desc   Reverse a usage record (correction)
// @route  POST /api/v1/usage/:id/reverse
// @access dooit only
exports.reverseUsage = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const original = await UsageRecord.findById(req.params.id);
  if (!original) return next(new ErrorResponse("Usage record not found", 404));
  if (original.status === "reversed") {
    return next(new ErrorResponse("This record has already been reversed", 409));
  }
  if (original.reversalOf) {
    return next(new ErrorResponse("A reversal cannot itself be reversed", 409));
  }

  const reason = req.body.reason || "Correction";

  // The reversal is a NEW record with negated quantity and amount. The original
  // is left intact so any invoice that already included it still reproduces.
  const reversal = await UsageRecord.create({
    ...original.toObject(),
    _id: undefined,
    uid: undefined,
    quantity: -Math.abs(original.quantity),
    amount: require("../utils/money").toDecimal(
      -Math.abs(toNumber(original.amount))
    ),
    idempotencyKey: `reversal:${original._id}`,
    reversalOf: original._id,
    status: "recorded",
    invoice: null,
    billedAt: null,
    // Reversal is recorded NOW; the original keeps its own usageDate so the
    // audit trail shows both when the work happened and when it was corrected.
    usageDate: new Date(),
    ...periodKeysFor(new Date()),
    metadata: { ...(original.metadata || {}), reversalReason: reason },
  });

  original.status = "reversed";
  original.exclusionReason = reason;
  await original.save();

  res.status(201).json({
    success: true,
    data: reversal,
    meta: {
      reversed: original._id,
      note: original.invoice
        ? "The original was already invoiced — this reversal lands on the next invoice as an adjustment."
        : "The original was not yet invoiced — neither will be billed.",
    },
  });
});
