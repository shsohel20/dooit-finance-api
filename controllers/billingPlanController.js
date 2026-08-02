// controllers/billingPlanController.js
//
// Billing plans — what dooit sells and clients buy.
//
// Access model (docs/billingmodule/mongoose-schema.md §2.3 / §B.4):
//   dooit  — full authoring: draft, edit, publish, version, archive, grant access
//   client — read only, and only PUBLISHED plans that are either `public` or
//            privately granted to them via planEligibility
//
// Immutability: a published plan is frozen by the model's pre('save') guard.
// Editing one means publishing `version + 1`; the previous version stays
// readable so existing subscriptions and invoices still resolve.

const mongoose = require("mongoose");

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const BillingPlan = require("../models/BillingPlan");
const PlanEligibility = require("../models/PlanEligibility");
const Product = require("../models/Product");
const UserType = require("../models/UserType");
const { toDecimal, toNumber } = require("../utils/money");
const {
  assertUserType,
  assertActingAs,
  isDooit,
  actorId,
  USER_TYPE_DOOIT,
  USER_TYPE_CLIENT,
} = require("../services/billing/assertUserType");

// Fields a dooit user may set. Allow-list, so a future schema field is never
// mass-assignable by accident.
const WRITABLE = [
  "name",
  "code",
  "tagline",
  "description",
  "visibility",
  "pricingModel",
  "billingCycle",
  "currency",
  "basePrice",
  "isCustomPriced",
  "includedUsage",
  "includedUnit",
  "overagePrice",
  "tiers",
  "products",
  "features",
  "popular",
  "accentColor",
  "displayOrder",
  "selfServe",
  "salesCta",
  "seatsLabel",
  "seatsLimit",
  "slaTarget",
  "supportLevel",
  "changePolicy",
  "trialDays",
  "annualDiscountPercent",
  "metadata",
];

// `code` and `version` identify the plan across versions — set at creation only.
const UPDATABLE = WRITABLE.filter((f) => f !== "code");

const pick = (src, fields) =>
  fields.reduce((acc, f) => {
    if (src[f] !== undefined) acc[f] = src[f];
    return acc;
  }, {});

// ── Input normalisation ──────────────────────────────────────────────────────

/**
 * The Plan Builder lets users type free text into tier bands — '1,000', '∞',
 * '—', ''. Parse to numbers here so the model never sees a string.
 */
const parseQty = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[,\s]/g, "");
  if (/^(∞|inf|infinity|-|—)$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const normalizeTier = (t = {}) => ({
  from: parseQty(t.from) ?? 0,
  to: parseQty(t.to),
  unitPrice: toDecimal(t.unitPrice ?? 0),
  discountPercent: Number(String(t.discountPercent ?? 0).replace("%", "")) || 0,
});

const optionalMoney = (v) =>
  v === null || v === undefined || v === "" ? null : toDecimal(v);

/**
 * Resolve plan products against the real catalogue.
 *
 * code / name / unit are taken from the Product document, never from the
 * request: they are a SNAPSHOT for rendering, and letting a caller supply them
 * would allow a plan to advertise a product it does not actually reference.
 */
const resolvePlanProducts = async (products) => {
  if (!Array.isArray(products)) return undefined;
  if (products.length === 0) return [];

  const ids = products.map((p) => p.productId).filter(Boolean);
  const valid = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (valid.length !== products.length) {
    throw new ErrorResponse("Every plan product needs a valid productId", 400);
  }

  const docs = await Product.find({ _id: { $in: valid }, isDeleted: false })
    .select("_id code name unit")
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  return products.map((p) => {
    const doc = byId.get(String(p.productId));
    if (!doc) throw new ErrorResponse(`Unknown or deleted product: ${p.productId}`, 400);
    return {
      productId: doc._id,
      code: doc.code,
      name: doc.name,
      unit: doc.unit,
      enabled: p.enabled !== false,
      includedQuantity: parseQty(p.includedQuantity) ?? 0,
      unitPrice: optionalMoney(p.unitPrice),
      overagePrice: optionalMoney(p.overagePrice),
      tiers: Array.isArray(p.tiers) ? p.tiers.map(normalizeTier) : [],
    };
  });
};

const normalizePayload = async (raw, fields) => {
  const payload = pick(raw, fields);

  if (payload.basePrice !== undefined) payload.basePrice = toDecimal(payload.basePrice);
  if (payload.overagePrice !== undefined) {
    payload.overagePrice = toDecimal(payload.overagePrice ?? 0);
  }
  if (payload.includedUsage !== undefined) {
    payload.includedUsage = parseQty(payload.includedUsage);
  }
  if (Array.isArray(payload.tiers)) payload.tiers = payload.tiers.map(normalizeTier);
  if (payload.products !== undefined) {
    payload.products = await resolvePlanProducts(payload.products);
  }
  return payload;
};

// ── Visibility ───────────────────────────────────────────────────────────────

/**
 * Build the filter a CLIENT may read: published, not deleted, and either public
 * or privately granted to them. Grants are checked server-side on every read —
 * guessing a planId must not be enough.
 */
const clientVisibleFilter = async (userId) => {
  const grantedIds = await PlanEligibility.find({
    user: userId,
    status: "active",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  }).distinct("planId");

  return {
    status: "published",
    isDeleted: false,
    $or: [{ visibility: "public" }, { _id: { $in: grantedIds } }],
  };
};

// ─────────────────────────────────────────────────────────────────────────────

// @desc   List plans
// @route  GET /api/v1/billing-plan
// @access dooit → all; client → published + visible only
exports.getPlans = asyncHandler(async (req, res) => {
  const {
    status,
    visibility,
    code,
    search,
    latestOnly = "false",
    page = 1,
    limit = 50,
    sort = "-updatedAt",
  } = req.query;

  let filter;
  if (isDooit(req)) {
    filter = { isDeleted: false };
    if (status && status !== "all") filter.status = status;
    if (visibility && visibility !== "all") filter.visibility = visibility;
    if (code) filter.code = String(code).toLowerCase();
  } else {
    filter = await clientVisibleFilter(actorId(req));
    if (code) filter.code = String(code).toLowerCase();
  }

  if (search) {
    const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const term = [
      { name: { $regex: safe, $options: "i" } },
      { code: { $regex: safe, $options: "i" } },
      { tagline: { $regex: safe, $options: "i" } },
    ];
    // Preserve an existing $or (the client visibility clause) — overwriting it
    // would widen access to every published plan.
    filter.$and = [...(filter.$and || []), { $or: term }];
  }

  const SORTS = {
    "-updatedAt": { updatedAt: -1 },
    updatedAt: { updatedAt: 1 },
    name: { name: 1 },
    order: { displayOrder: 1, name: 1 },
    price: { basePrice: 1 },
    "-price": { basePrice: -1 },
  };

  const result = await BillingPlan.paginate(filter, {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(200, Math.max(1, parseInt(limit, 10) || 50)),
    sort: SORTS[sort] || SORTS["-updatedAt"],
  });

  let docs = result.docs;
  // Collapse to the newest version per code — useful for a catalogue view where
  // older archived versions are noise.
  if (latestOnly === "true") {
    const best = new Map();
    for (const p of docs) {
      const cur = best.get(p.code);
      if (!cur || p.version > cur.version) best.set(p.code, p);
    }
    docs = [...best.values()];
  }

  res.status(200).json({
    success: true,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.totalDocs,
      totalPages: result.totalPages,
    },
    data: docs,
  });
});

// @desc   Enum values for building the Plan Builder form
// @route  GET /api/v1/billing-plan/meta
// @access any authenticated user
exports.getPlanMeta = asyncHandler(async (req, res) => {
  const {
    PRICING_MODELS,
    BILLING_CYCLES,
    PLAN_STATUS,
    PLAN_VISIBILITY,
    SLA_TARGETS,
    SUPPORT_LEVELS,
    CURRENCIES,
  } = require("../models/constants/billing");

  res.status(200).json({
    success: true,
    data: {
      pricingModels: PRICING_MODELS,
      billingCycles: BILLING_CYCLES,
      statuses: PLAN_STATUS,
      visibilities: PLAN_VISIBILITY,
      slaTargets: SLA_TARGETS,
      supportLevels: SUPPORT_LEVELS,
      currencies: CURRENCIES,
    },
  });
});

// @desc   Get one plan
// @route  GET /api/v1/billing-plan/:id
// @access dooit → any; client → only if published and visible to them
exports.getPlan = asyncHandler(async (req, res, next) => {
  const plan = await BillingPlan.findById(req.params.id);
  if (!plan || plan.isDeleted) return next(new ErrorResponse("Plan not found", 404));

  if (!isDooit(req)) {
    const filter = await clientVisibleFilter(actorId(req));
    const visible = await BillingPlan.exists({ _id: plan._id, ...filter });
    // 404 rather than 403: a client should not be able to probe for the
    // existence of a private plan they were never granted.
    if (!visible) return next(new ErrorResponse("Plan not found", 404));
  }

  res.status(200).json({ success: true, data: plan });
});

// @desc   Create a draft plan
// @route  POST /api/v1/billing-plan
// @access dooit only
exports.createPlan = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);
  const createdBy = actorId(req);
  await assertUserType(createdBy, USER_TYPE_DOOIT, "createdBy");

  const payload = await normalizePayload(req.body, WRITABLE);
  if (!payload.code) return next(new ErrorResponse("code is required", 400));

  const code = String(payload.code).toLowerCase();
  const version = Number(req.body.version) || 1;

  const clash = await BillingPlan.findOne({ code, version }).select("_id");
  if (clash) {
    return next(
      new ErrorResponse(`Plan "${code}" version ${version} already exists`, 409)
    );
  }

  const plan = await BillingPlan.create({
    ...payload,
    code,
    version,
    status: "draft", // publishing is a separate, validated step
    createdBy,
  });

  res.status(201).json({ success: true, data: plan });
});

// @desc   Update a DRAFT plan
// @route  PUT /api/v1/billing-plan/:id
// @access dooit only
exports.updatePlan = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const plan = await BillingPlan.findById(req.params.id);
  if (!plan || plan.isDeleted) return next(new ErrorResponse("Plan not found", 404));

  if (plan.status !== "draft") {
    return next(
      new ErrorResponse(
        `A ${plan.status} plan is immutable. Create a new version with POST /billing-plan/${plan._id}/new-version.`,
        409
      )
    );
  }
  if (req.body.code !== undefined && String(req.body.code).toLowerCase() !== plan.code) {
    return next(
      new ErrorResponse("Plan code is immutable — create a new plan instead", 400)
    );
  }

  const payload = await normalizePayload(req.body, UPDATABLE);
  Object.assign(plan, payload, { updatedBy: actorId(req) });
  await plan.save();

  res.status(200).json({ success: true, data: plan });
});

// @desc   Publish a draft — validates, then archives the prior published version
// @route  POST /api/v1/billing-plan/:id/publish
// @access dooit only
exports.publishPlan = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);
  const publishedBy = actorId(req);
  await assertUserType(publishedBy, USER_TYPE_DOOIT, "publishedBy");

  const plan = await BillingPlan.findById(req.params.id);
  if (!plan || plan.isDeleted) return next(new ErrorResponse("Plan not found", 404));
  if (plan.status === "published") {
    return next(new ErrorResponse("Plan is already published", 409));
  }
  if (plan.status === "archived") {
    return next(
      new ErrorResponse("An archived plan cannot be republished — create a new version", 409)
    );
  }

  // Publishing turns a draft into a contract, so validate hard here rather than
  // letting a half-built plan reach a customer.
  const errors = [];
  if (!plan.name?.trim()) errors.push("name is required");
  if (!plan.products?.some((p) => p.enabled)) {
    errors.push("at least one enabled product is required");
  }
  if (
    !plan.isCustomPriced &&
    ["flat", "hybrid"].includes(plan.pricingModel) &&
    toNumber(plan.basePrice) <= 0
  ) {
    errors.push(
      "basePrice must be greater than zero for a flat or hybrid plan (or mark it custom-priced)"
    );
  }
  if (plan.visibility === "private") {
    const grants = await PlanEligibility.countDocuments({
      planId: plan._id,
      status: "active",
    });
    if (grants === 0) {
      errors.push("a private plan needs at least one eligible client before publishing");
    }
  }
  if (errors.length) {
    return next(new ErrorResponse(`Cannot publish: ${errors.join("; ")}`, 400));
  }

  plan.status = "published";
  plan.publishedBy = publishedBy;
  plan.updatedBy = publishedBy;
  await plan.save();

  // Archive older published versions of the same code AFTER the new one is live,
  // so a failure here leaves the catalogue over-supplied rather than empty.
  // (No transaction: this runs on standalone mongo too.)
  const archived = await BillingPlan.updateMany(
    {
      code: plan.code,
      _id: { $ne: plan._id },
      status: "published",
      isDeleted: false,
    },
    { $set: { status: "archived", archivedAt: new Date(), updatedBy: publishedBy } }
  );

  res.status(200).json({
    success: true,
    data: plan,
    meta: { archivedPreviousVersions: archived.modifiedCount ?? 0 },
  });
});

// @desc   Clone a plan into a new DRAFT version
// @route  POST /api/v1/billing-plan/:id/new-version
// @access dooit only
exports.createNewVersion = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);
  const createdBy = actorId(req);

  const source = await BillingPlan.findById(req.params.id).lean();
  if (!source || source.isDeleted) return next(new ErrorResponse("Plan not found", 404));

  const existingDraft = await BillingPlan.findOne({
    code: source.code,
    status: "draft",
    isDeleted: false,
  }).select("_id version");
  if (existingDraft) {
    return next(
      new ErrorResponse(
        `Plan "${source.code}" already has an open draft (v${existingDraft.version}) — edit or discard it first`,
        409
      )
    );
  }

  const highest = await BillingPlan.findOne({ code: source.code })
    .sort({ version: -1 })
    .select("version")
    .lean();

  const {
    _id,
    uid,
    createdAt,
    updatedAt,
    publishedAt,
    publishedBy,
    archivedAt,
    __v,
    ...rest
  } = source;

  const draft = await BillingPlan.create({
    ...rest,
    version: (highest?.version ?? source.version) + 1,
    status: "draft",
    publishedAt: null,
    publishedBy: null,
    archivedAt: null,
    createdBy,
    updatedBy: null,
  });

  res.status(201).json({
    success: true,
    data: draft,
    meta: { clonedFrom: { id: source._id, version: source.version } },
  });
});

// @desc   Archive a published plan
// @route  POST /api/v1/billing-plan/:id/archive
// @access dooit only
exports.archivePlan = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const plan = await BillingPlan.findById(req.params.id);
  if (!plan || plan.isDeleted) return next(new ErrorResponse("Plan not found", 404));
  if (plan.status !== "published") {
    return next(new ErrorResponse("Only a published plan can be archived", 409));
  }

  plan.status = "archived";
  plan.updatedBy = actorId(req);
  await plan.save();

  res.status(200).json({
    success: true,
    data: plan,
    // Archiving removes the plan from the catalogue only. Existing subscribers
    // keep billing from their own priceSnapshot and are never cancelled.
    meta: { note: "Existing subscriptions are unaffected — they bill from their own snapshot." },
  });
});

// @desc   Soft-delete a DRAFT plan
// @route  DELETE /api/v1/billing-plan/:id
// @access dooit only
exports.deletePlan = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const plan = await BillingPlan.findById(req.params.id);
  if (!plan || plan.isDeleted) return next(new ErrorResponse("Plan not found", 404));
  if (plan.status !== "draft") {
    return next(
      new ErrorResponse(
        `Only a draft can be deleted. Archive the ${plan.status} plan instead.`,
        409
      )
    );
  }

  plan.isDeleted = true;
  plan.deletedAt = new Date();
  plan.updatedBy = actorId(req);
  await plan.save();

  res.status(200).json({ success: true, data: {} });
});

// ── Eligibility (private plan access) ────────────────────────────────────────

// @desc   List who may buy a private plan
// @route  GET /api/v1/billing-plan/:id/eligibility
// @access dooit only
exports.getEligibility = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const plan = await BillingPlan.findById(req.params.id).select("_id");
  if (!plan) return next(new ErrorResponse("Plan not found", 404));

  const grants = await PlanEligibility.find({ planId: plan._id })
    .populate("user", "name email")
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, data: grants });
});

// @desc   Client users a plan can be granted to
// @route  GET /api/v1/billing-plan/clients
// @access dooit only
//
// Lives here rather than on userController because the question is
// billing-specific — "who can I sell a plan to" — and the answer is a UserType
// membership query, not a user query. Users hold many memberships, so results
// are deduped by user.
exports.getGrantableClients = asyncHandler(async (req, res) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const { search, limit = 50 } = req.query;

  const memberships = await UserType.find({
    userType: USER_TYPE_CLIENT,
    isActive: true,
  })
    .populate("user", "name email isActive")
    .populate("clientBelongs", "name")
    .limit(Math.min(200, Number(limit) || 50) * 3) // headroom for the dedupe
    .lean();

  const seen = new Map();
  for (const m of memberships) {
    if (!m.user || m.user.isActive === false) continue;
    const id = String(m.user._id);
    if (seen.has(id)) continue;
    seen.set(id, {
      _id: m.user._id,
      name: m.user.name,
      email: m.user.email,
      client: m.clientBelongs?._id ?? null,
      clientName: m.clientBelongs?.name ?? null,
    });
  }

  let data = [...seen.values()];
  if (search) {
    const term = String(search).toLowerCase();
    data = data.filter(
      (u) =>
        u.name?.toLowerCase().includes(term) ||
        u.email?.toLowerCase().includes(term) ||
        u.clientName?.toLowerCase().includes(term)
    );
  }

  res.status(200).json({
    success: true,
    data: data.slice(0, Math.min(200, Number(limit) || 50)),
  });
});

// @desc   Grant a client user access to a private plan
// @route  POST /api/v1/billing-plan/:id/eligibility
// @access dooit only
exports.grantEligibility = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);
  const grantedBy = actorId(req);

  const { user, client = null, expiresAt = null, note = null } = req.body;
  if (!user) return next(new ErrorResponse("user is required", 400));
  await assertUserType(user, USER_TYPE_CLIENT, "user");

  const plan = await BillingPlan.findById(req.params.id).select("_id visibility");
  if (!plan) return next(new ErrorResponse("Plan not found", 404));

  // Upsert: re-granting a revoked row reactivates it rather than colliding with
  // the unique (planId, user) index.
  const grant = await PlanEligibility.findOneAndUpdate(
    { planId: plan._id, user },
    {
      $set: {
        client,
        grantedBy,
        grantedAt: new Date(),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        note,
        status: "active",
        revokedAt: null,
        revokedBy: null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
  );

  res.status(201).json({ success: true, data: grant });
});

// @desc   Revoke access
// @route  DELETE /api/v1/billing-plan/:id/eligibility/:userId
// @access dooit only
exports.revokeEligibility = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const grant = await PlanEligibility.findOne({
    planId: req.params.id,
    user: req.params.userId,
  });
  if (!grant) return next(new ErrorResponse("Eligibility not found", 404));

  grant.status = "revoked";
  grant.revokedBy = actorId(req);
  await grant.save();

  res.status(200).json({ success: true, data: grant });
});
