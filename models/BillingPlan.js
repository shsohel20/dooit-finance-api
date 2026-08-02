const mongoose = require("mongoose");

const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { assignSequence } = require("../utils/sequence");

const {
  PRICING_MODELS,
  BILLING_CYCLES,
  PLAN_STATUS,
  PLAN_VISIBILITY,
  SLA_TARGETS,
  SUPPORT_LEVELS,
  CURRENCIES,
} = require("./constants/billing");
const {
  TierSchema,
  PlanProductSchema,
  PlanFeatureSchema,
  validateTierLadder,
} = require("./schemas/billingShared");
const { nonNegative, maxScale, serializeDecimals } = require("../utils/money");

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// BillingPlan — what dooit sells. One document per VERSION.
//
// Lifecycle:  draft ──publish──► published ──archive──► archived
//
// A published plan is a CONTRACT and is frozen: the pre('save') guard below
// rejects any edit to a document that was already published when it was loaded.
// Changing a published plan means publishing `version + 1`; the previous version
// stays readable so historical subscriptions and invoices still resolve.
//
// Even so, billing never reads this collection — it reads
// `subscriptions.priceSnapshot`. The freeze is defence in depth, not the
// primary guarantee. See docs/billingmodule/mongoose-schema.md §B.4.
// ─────────────────────────────────────────────────────────────────────────────

// Fields that may still change AFTER a plan is published. Everything else is
// frozen. Checked against the first path segment, so nested edits such as
// `products.0.enabled` are caught too.
const POST_PUBLISH_MUTABLE = [
  "status",
  "publishedAt",
  "publishedBy",
  "archivedAt",
  "updatedBy",
  "updatedAt",
  "displayOrder",
  "popular",
  "isDeleted",
  "deletedAt",
];

const BillingPlanSchema = new Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────────
    // Human-readable key, assigned atomically on insert (see utils/sequence.js).
    // The raw counter value is not stored — uid carries it.
    uid: { type: String, unique: true, sparse: true, index: true }, // PLN-0000001

    name: {
      type: String,
      required: [true, "Plan name is required"],
      trim: true,
      maxlength: [120, "Plan name cannot exceed 120 characters"],
    },
    // Stable key across versions: ('plan_growth', 1), ('plan_growth', 2), …
    code: {
      type: String,
      required: [true, "Plan code is required"],
      trim: true,
      lowercase: true,
      match: [
        /^[a-z0-9_]{2,60}$/,
        "code must be 2-60 chars of lowercase letters, digits or underscore",
      ],
    },
    version: { type: Number, required: true, default: 1, min: 1 },

    tagline: { type: String, trim: true, maxlength: 160, default: null },
    description: { type: String, trim: true, maxlength: 1000, default: null },

    // ── Ownership — MUST hold an active `dooit` UserType membership.
    // Enforced by assertUserType() in the service layer: a ref cannot express it
    // because userType lives on UserType, not Users.
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "createdBy is required"],
      index: true,
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },

    // ── Lifecycle ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: { values: PLAN_STATUS, message: "`{VALUE}` is not a valid plan status" },
      default: "draft",
      index: true,
    },
    visibility: {
      type: String,
      enum: { values: PLAN_VISIBILITY, message: "`{VALUE}` is not a valid visibility" },
      default: "private",
      index: true,
    },

    // ── Pricing ──────────────────────────────────────────────────────────────
    pricingModel: {
      type: String,
      required: true,
      enum: { values: PRICING_MODELS, message: "`{VALUE}` is not a valid pricing model" },
      default: "hybrid",
    },
    billingCycle: {
      type: String,
      required: true,
      enum: { values: BILLING_CYCLES, message: "`{VALUE}` is not a valid billing cycle" },
      default: "monthly",
    },
    currency: {
      type: String,
      enum: { values: CURRENCIES, message: "`{VALUE}` is not a supported currency" },
      default: "AUD",
    },
    basePrice: {
      type: Schema.Types.Decimal128,
      default: () => mongoose.Types.Decimal128.fromString("0.00"),
      validate: [nonNegative, maxScale(6)],
    },
    // 'Enterprise' style — quoted, not published. Cannot be self-purchased.
    isCustomPriced: { type: Boolean, default: false },

    // ── Allowance & overage ──────────────────────────────────────────────────
    includedUsage: { type: Number, default: null, min: 0 }, // null ⇒ unlimited
    includedUnit: { type: String, trim: true, default: "applicant" },
    overagePrice: {
      type: Schema.Types.Decimal128,
      default: () => mongoose.Types.Decimal128.fromString("0.00"),
      validate: [nonNegative, maxScale(6)],
    },
    tiers: { type: [TierSchema], default: [] },

    annualDiscountPercent: { type: Number, default: 0, min: 0, max: 100 },

    // ── Contents ─────────────────────────────────────────────────────────────
    products: { type: [PlanProductSchema], default: [] },
    features: { type: [PlanFeatureSchema], default: [] },

    // ── Presentation ─────────────────────────────────────────────────────────
    popular: { type: Boolean, default: false },
    accentColor: { type: String, trim: true, default: "#0e766a" },
    displayOrder: { type: Number, default: 0 },

    // ── Purchase & change policy ─────────────────────────────────────────────
    // Can a client subscribe unaided, or must dooit/sales provision it?
    // Forced false whenever isCustomPriced — there is no price to charge.
    selfServe: { type: Boolean, default: true },
    salesCta: { type: String, trim: true, default: "Contact sales" },

    // ── Limits & support (Plan Builder § "Limits & support") ─────────────────
    // Typed rather than free-form `features[]` rows, because the comparison
    // matrix needs to line these up across plans.
    seatsLabel: { type: String, trim: true, maxlength: 60, default: null }, // 'Up to 25 seats'
    seatsLimit: { type: Number, default: null, min: 0 }, // null ⇒ unlimited
    slaTarget: {
      type: String,
      enum: { values: SLA_TARGETS, message: "`{VALUE}` is not a valid SLA target" },
      default: "none",
    },
    supportLevel: {
      type: String,
      enum: { values: SUPPORT_LEVELS, message: "`{VALUE}` is not a valid support level" },
      default: "email",
    },

    changePolicy: {
      allowUpgrade: { type: Boolean, default: true },
      allowDowngrade: { type: Boolean, default: true },
      allowCancel: { type: Boolean, default: true },
      cancelAtPeriodEnd: { type: Boolean, default: true },
      minimumTermMonths: { type: Number, default: 0, min: 0 },
    },

    trialDays: { type: Number, default: 0, min: 0 },

    publishedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "billingPlans",
    timestamps: true,
    // Decimal128 would otherwise serialise as {"$numberDecimal":"1900.00"}; emit a
    // plain number for API consumers. The stored value stays Decimal128.
    toJSON: { virtuals: true, transform: (_doc, ret) => serializeDecimals(ret) },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
BillingPlanSchema.index({ code: 1, version: 1 }, { unique: true }); // versioning key
BillingPlanSchema.index({ createdBy: 1, status: 1 }); // "plans I authored"
BillingPlanSchema.index({ status: 1, visibility: 1, displayOrder: 1 }); // catalogue
BillingPlanSchema.index({ status: 1, isDeleted: 1, updatedAt: -1 }); // admin list
BillingPlanSchema.index({ "products.productId": 1 }); // "which plans sell X?"

// ── Virtuals ─────────────────────────────────────────────────────────────────
BillingPlanSchema.virtual("basePriceValue").get(function () {
  return this.basePrice == null ? null : parseFloat(this.basePrice.toString());
});

BillingPlanSchema.virtual("enabledProductCount").get(function () {
  return (this.products || []).filter((p) => p.enabled).length;
});

// ── Validation ───────────────────────────────────────────────────────────────
BillingPlanSchema.pre("validate", function (next) {
  // A custom-priced plan has no published price and can never be self-served.
  if (this.isCustomPriced) {
    this.basePrice = mongoose.Types.Decimal128.fromString("0.00");
    this.selfServe = false;
  }

  // Report these with invalidate() rather than next(new Error()): a plain Error
  // has no `.errors`, so middleware/error.js cannot recognise it and the caller
  // gets a 500 instead of a 400. invalidate() produces a real ValidationError.
  const ladderErr = validateTierLadder(this.tiers, "tiers");
  if (ladderErr) this.invalidate("tiers", ladderErr);

  for (const p of this.products || []) {
    const e = validateTierLadder(p.tiers, `products.${p.code}.tiers`);
    if (e) this.invalidate("products", e);
  }

  // A product may appear only once in a plan
  const codes = (this.products || []).map((p) => p.code);
  const dupe = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dupe) this.invalidate("products", `Duplicate product "${dupe}" in plan`);

  next();
});

// ── Immutability ─────────────────────────────────────────────────────────────
// Remember the status the document had when it was LOADED. Comparing against
// this (rather than the in-memory status) is what lets the draft → published
// transition through while still freezing an already-published document.
// Stamped on save as well as on init: post('init') fires only for documents
// read back from the database, so a plan created and then re-saved in the same
// pass would carry `undefined` here and slip past the freeze below. See the
// equivalent note in Invoice.js.
BillingPlanSchema.post("init", function () {
  this.$locals.loadedStatus = this.status;
});

BillingPlanSchema.post("save", function () {
  this.$locals.loadedStatus = this.status;
});

BillingPlanSchema.pre("save", function (next) {
  if (this.isNew) return next();
  if (this.$locals.loadedStatus !== "published") return next();

  const illegal = this.modifiedPaths()
    .filter((p) => !POST_PUBLISH_MUTABLE.includes(p.split(".")[0]));

  if (illegal.length) {
    return next(
      new Error(
        "Published plan is immutable — publish a new version instead. " +
          `Illegal changes: ${illegal.join(", ")}`
      )
    );
  }
  next();
});

// Stamp lifecycle timestamps
BillingPlanSchema.pre("save", function (next) {
  if (this.isModified("status")) {
    if (this.status === "published" && !this.publishedAt) this.publishedAt = new Date();
    if (this.status === "archived" && !this.archivedAt) this.archivedAt = new Date();
  }
  next();
});

// ── Numbering ────────────────────────────────────────────────────────────────
// See utils/sequence.js for why this is not mongoose-sequence.
BillingPlanSchema.pre("save", assignSequence("billing_plan_sequence", "PLN"));

// ── Plugins ──────────────────────────────────────────────────────────────────
BillingPlanSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
BillingPlanSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("BillingPlan", BillingPlanSchema);
