const mongoose = require("mongoose");

const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { assignSequence } = require("../utils/sequence");
const {
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_CHANGE_TYPES,
  DISCOUNT_TYPES,
  PRICING_MODELS,
  BILLING_CYCLES,
  CURRENCIES,
} = require("./constants/billing");
const { TierSchema, PlanProductSchema } = require("./schemas/billingShared");
const { nonNegative, maxScale, serializeDecimals } = require("../utils/money");

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Subscription — binds a client USER to a plan, and FREEZES its pricing.
//
// This is the contract. `priceSnapshot` is a full copy of the plan's commercials
// taken at purchase time, and **billing reads the snapshot, never the plan**.
// `plan` is kept for lineage and display only; if the rating engine ever loads
// billingPlans to price something, the immutability guarantee is void.
//
// That is why the snapshot reuses the SAME sub-schemas as BillingPlan
// (schemas/billingShared.js) — if the two shapes drifted, old snapshots would
// silently stop validating.
//
// See docs/billingmodule/mongoose-schema.md §B.4 and §7.5.
// ─────────────────────────────────────────────────────────────────────────────

const PriceSnapshotSchema = new Schema(
  {
    // ── Provenance ───────────────────────────────────────────────────────────
    planCode: { type: String, required: true, trim: true },
    planName: { type: String, required: true, trim: true },
    planVersion: { type: Number, required: true },

    // ── Commercials, frozen ──────────────────────────────────────────────────
    pricingModel: { type: String, enum: PRICING_MODELS, required: true },
    billingCycle: { type: String, enum: BILLING_CYCLES, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },

    basePrice: {
      type: Schema.Types.Decimal128,
      required: true,
      validate: [nonNegative, maxScale(6)],
    },
    isCustomPriced: { type: Boolean, default: false },

    includedUsage: { type: Number, default: null },
    includedUnit: { type: String, trim: true, default: "applicant" },
    overagePrice: {
      type: Schema.Types.Decimal128,
      default: () => mongoose.Types.Decimal128.fromString("0.00"),
      validate: [nonNegative, maxScale(6)],
    },
    annualDiscountPercent: { type: Number, default: 0, min: 0, max: 100 },

    tiers: { type: [TierSchema], default: [] },
    products: { type: [PlanProductSchema], default: [] },

    // ── Entitlements the subscriber was sold ─────────────────────────────────
    seatsLabel: { type: String, trim: true, default: null },
    slaTarget: { type: String, trim: true, default: "none" },
    supportLevel: { type: String, trim: true, default: "email" },

    // The change policy in force for THIS subscription. Copied deliberately:
    // cancellation rights must not change because the catalogue changed.
    changePolicy: {
      allowUpgrade: { type: Boolean, default: true },
      allowDowngrade: { type: Boolean, default: true },
      allowCancel: { type: Boolean, default: true },
      cancelAtPeriodEnd: { type: Boolean, default: true },
      minimumTermMonths: { type: Number, default: 0 },
    },

    snapshotAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

// ── Negotiated discount ──────────────────────────────────────────────────────
// dooit-only, and MUTABLE — unlike everything in priceSnapshot. See the note on
// DISCOUNT_TYPES for why it is not frozen with the rest of the commercials.
//
// `value` means percent when type is 'percentage' and money when it is 'fixed',
// which is the one thing about this shape worth being careful with: a 10 that
// should have been 10% and was stored as fixed is a A$10 discount on a A$1,900
// invoice, and nothing downstream can tell that it was a mistake. The
// controller validates the range per type for that reason.
const DiscountSchema = new Schema(
  {
    type: { type: String, enum: DISCOUNT_TYPES, default: "none" },
    value: {
      type: Schema.Types.Decimal128,
      default: 0,
      validate: [nonNegative, maxScale(2)],
    },
    reason: { type: String, trim: true, maxlength: 300, default: null },
    // Who granted it. A discount is a commercial concession, so it is worth
    // being able to answer "who agreed to this" years later.
    appliedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    appliedAt: { type: Date, default: null },
  },
  { _id: false }
);

const SubscriptionSchema = new Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────────
    uid: { type: String, unique: true, sparse: true, index: true }, // SUB-0000001

    // ── Who ──────────────────────────────────────────────────────────────────
    // The client USER who subscribed. Named `user` (not `clientId`) to match the
    // codebase: a Users ref is `user`, and `client` always means the company.
    // Must hold an active `client` UserType membership — enforced in the service
    // layer, since userType lives on UserType rather than Users.
    user: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "user is required"],
      index: true,
    },
    // That user's company. Denormalised so company-level billing later is a
    // query change rather than a migration.
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      default: null,
      index: true,
    },

    // ── What (lineage only — NOT used for pricing) ───────────────────────────
    plan: {
      type: Schema.Types.ObjectId,
      ref: "BillingPlan",
      required: [true, "plan is required"],
      index: true,
    },
    planCode: { type: String, required: true, trim: true },
    planVersion: { type: Number, required: true },

    // ── Lifecycle ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: {
        values: SUBSCRIPTION_STATUS,
        message: "`{VALUE}` is not a valid subscription status",
      },
      default: "pending",
      required: true,
      index: true,
    },

    startDate: { type: Date, required: true, default: Date.now },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    trialEndsAt: { type: Date, default: null },
    minimumTermEndsAt: { type: Date, default: null },
    nextInvoiceAt: { type: Date, default: null, index: true },

    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    cancelReason: { type: String, trim: true, maxlength: 500, default: null },
    pausedAt: { type: Date, default: null },
    resumedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },

    // ── THE guarantee ────────────────────────────────────────────────────────
    priceSnapshot: {
      type: PriceSnapshotSchema,
      required: [true, "priceSnapshot is required"],
    },

    // Applied to each invoice's subtotal at close time, and copied onto that
    // invoice so changing it later never rewrites history.
    discount: { type: DiscountSchema, default: () => ({}) },

    // ── Change lineage (upgrade / downgrade / renewal chain) ─────────────────
    previousSubscription: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },
    replacedBySubscription: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },
    changeType: {
      type: String,
      enum: SUBSCRIPTION_CHANGE_TYPES,
      default: "new",
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "createdBy is required"],
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "subscriptions",
    timestamps: true,
    toJSON: { virtuals: true, transform: (_doc, ret) => serializeDecimals(ret) },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
SubscriptionSchema.index({ user: 1, status: 1 });
SubscriptionSchema.index({ client: 1, status: 1 });
SubscriptionSchema.index({ plan: 1, status: 1 }); // "who is on this plan?"
SubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 }); // period-close sweep
SubscriptionSchema.index({ nextInvoiceAt: 1, status: 1 }); // billing cron

// ONE active subscription per client user, enforced by the DATABASE rather than
// by a check-then-insert that two concurrent requests could both pass.
//
// partialFilterExpression uses plain equality only: $in is not reliably
// supported across MongoDB versions, so `pending` is NOT covered here and must
// be guarded in the service layer.
SubscriptionSchema.index(
  { user: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
    name: "uniq_active_subscription_per_user",
  }
);

// ── Virtuals ─────────────────────────────────────────────────────────────────
SubscriptionSchema.virtual("basePriceValue").get(function () {
  const v = this.priceSnapshot?.basePrice;
  return v == null ? null : parseFloat(v.toString());
});

SubscriptionSchema.virtual("isLive").get(function () {
  return this.status === "active" || this.status === "pending";
});

/** Days until the current period ends — negative once overdue for close. */
SubscriptionSchema.virtual("daysToPeriodEnd").get(function () {
  if (!this.currentPeriodEnd) return null;
  return Math.ceil((this.currentPeriodEnd - Date.now()) / 86400000);
});

// ── Validation ───────────────────────────────────────────────────────────────
SubscriptionSchema.pre("validate", function (next) {
  if (this.currentPeriodStart && this.currentPeriodEnd) {
    if (this.currentPeriodEnd <= this.currentPeriodStart) {
      this.invalidate(
        "currentPeriodEnd",
        "currentPeriodEnd must be after currentPeriodStart"
      );
    }
  }
  if (this.status === "cancelled" && !this.cancelledAt) this.cancelledAt = new Date();
  if (this.status === "paused" && !this.pausedAt) this.pausedAt = new Date();
  if (["cancelled", "expired"].includes(this.status) && !this.endedAt) {
    this.endedAt = new Date();
  }
  next();
});

// A snapshot is frozen for the life of the subscription. Changing a plan means a
// NEW subscription linked via previousSubscription — never an edited snapshot.
// Set on save as well as on init: post('init') fires only for documents read
// back from the database, so a subscription created and then re-saved in the
// same pass would carry `undefined` here and could have its snapshot rewritten.
// See the equivalent note in Invoice.js.
SubscriptionSchema.post("init", function () {
  this.$locals.hadSnapshot = true;
});

SubscriptionSchema.post("save", function () {
  this.$locals.hadSnapshot = true;
});

SubscriptionSchema.pre("save", function (next) {
  if (!this.isNew && this.$locals.hadSnapshot && this.isModified("priceSnapshot")) {
    return next(
      new Error(
        "priceSnapshot is immutable — create a new subscription for a plan change"
      )
    );
  }
  next();
});

// ── Numbering ────────────────────────────────────────────────────────────────
SubscriptionSchema.pre("save", assignSequence("subscription_sequence", "SUB"));

SubscriptionSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
SubscriptionSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("Subscription", SubscriptionSchema);
