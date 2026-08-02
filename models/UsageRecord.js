const mongoose = require("mongoose");

const mongoosePaginate = require("mongoose-paginate-v2");

const {
  USAGE_STATUS,
  METER_SOURCES,
  PRODUCT_CATEGORIES,
} = require("./constants/billing");
const { nonNegative, maxScale, serializeDecimals } = require("../utils/money");

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// UsageRecord — one billable AML/KYC action. Append-only.
//
// The only high-volume billing collection, and the only one that is never
// edited: corrections are appended as REVERSING records (see `reversalOf`), so
// every historical invoice stays reproducible from the records that existed
// when it was issued.
//
// Three details here are the direct result of correctness findings in
// docs/billingmodule/schema-design.md §15 — each was a silent money bug:
//
//   idempotencyKey  §15.2  composed, never the bare provider id
//   periodKey       §15.3  derived in the ACCOUNT's timezone, not UTC
//   applicantKey    §15.1  distinct-applicant counting for plan allowances
// ─────────────────────────────────────────────────────────────────────────────

const UsageRecordSchema = new Schema(
  {
    // ── Who ──────────────────────────────────────────────────────────────────
    user: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "user is required"],
      index: true,
    },
    client: { type: Schema.Types.ObjectId, ref: "Client", default: null, index: true },

    subscription: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      required: [true, "subscription is required"],
      index: true,
    },
    plan: { type: Schema.Types.ObjectId, ref: "BillingPlan", default: null },

    // ── What ─────────────────────────────────────────────────────────────────
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "product is required"],
      index: true,
    },
    // Denormalised so a rollup never needs a join, and so the row still reads
    // correctly if the product is later renamed or archived.
    productCode: { type: String, required: true, trim: true, index: true },
    productName: { type: String, required: true, trim: true },
    category: { type: String, enum: PRODUCT_CATEGORIES, required: true },
    unit: { type: String, trim: true, default: "check" },

    // A NEGATIVE quantity is legal only on a reversal (see `reversalOf` and the
    // pre('validate') hook below). `min: 0` here would be simpler but would make
    // corrections impossible, forcing edits-in-place instead.
    quantity: { type: Number, required: true, default: 1 },

    // ── Price AT USAGE TIME ──────────────────────────────────────────────────
    // Resolved from the subscription's priceSnapshot, never from the live plan.
    unitPrice: {
      type: Schema.Types.Decimal128,
      required: true,
      validate: [nonNegative, maxScale(6)],
    },
    amount: { type: Schema.Types.Decimal128, required: true },
    currency: { type: String, default: "AUD" },
    // Where the price came from, so a disputed charge can be traced.
    priceSource: {
      type: String,
      enum: ["snapshot_override", "product_list", "zero_rated"],
      required: true,
    },

    // ── When ─────────────────────────────────────────────────────────────────
    usageDate: { type: Date, required: true, default: Date.now, index: true },
    // Derived in the account's timezone (§15.3). An event at 2026-07-31T23:30Z
    // is 2026-08-01 in Sydney — a different MONTH. Deriving these from UTC would
    // silently bill late-July usage on the August invoice.
    periodKey: { type: String, required: true, index: true }, // '2026-07'
    dayKey: { type: String, required: true, index: true }, // '2026-07-24'

    // ── Allowance counting (§15.1) ───────────────────────────────────────────
    // One applicant running an ID check, a liveness check and an AML screen
    // consumes the plan allowance ONCE. Keyed on the Customer, not the provider's
    // applicant id: a customer re-onboarded after rejection gets a new provider
    // id and would be double-counted.
    applicantKey: { type: String, trim: true, default: null, index: true },

    // ── Idempotency (§15.2) ──────────────────────────────────────────────────
    // MUST be composed: `${source}:${externalId}:${productCode}:${ordinal}`.
    // One provider webhook can be billable under several products at once; keyed
    // on the bare provider id, the first insert wins and every other product is
    // discarded as a duplicate — no error, just a smaller invoice.
    idempotencyKey: {
      type: String,
      required: [true, "idempotencyKey is required"],
      unique: true,
    },

    // ── Provenance ───────────────────────────────────────────────────────────
    source: {
      system: { type: String, enum: METER_SOURCES, default: "internal" },
      refType: { type: String, trim: true, default: null }, // 'Customer' | 'Case'
      refId: { type: Schema.Types.ObjectId, default: null },
      externalId: { type: String, trim: true, default: null },
    },

    // ── Billing state ────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: { values: USAGE_STATUS, message: "`{VALUE}` is not a valid usage status" },
      default: "recorded",
      index: true,
    },
    invoice: { type: Schema.Types.ObjectId, ref: "Invoice", default: null, index: true },
    billedAt: { type: Date, default: null },

    // An event whose usageDate falls in an already-closed period. Kept, never
    // rejected (§15.4) — it lands on the NEXT invoice as an adjustment.
    isLate: { type: Boolean, default: false },

    // Corrections are appended, never applied in place.
    reversalOf: { type: Schema.Types.ObjectId, ref: "UsageRecord", default: null },
    exclusionReason: { type: String, trim: true, default: null },

    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "usageRecords",
    // updatedAt is disabled deliberately: a usage record is an immutable
    // financial event. The only permitted mutations are status/invoice/billedAt
    // when it is swept onto an invoice.
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: { virtuals: true, transform: (_doc, ret) => serializeDecimals(ret) },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// The heaviest query in the system: "all unbilled usage for this subscription in
// this period, grouped by product" — covered entirely, including the $group.
UsageRecordSchema.index({ subscription: 1, periodKey: 1, product: 1 });
UsageRecordSchema.index({ subscription: 1, status: 1 }); // unbilled sweep
UsageRecordSchema.index({ user: 1, usageDate: -1 }); // client usage view
UsageRecordSchema.index({ product: 1, usageDate: -1 }); // product analytics
UsageRecordSchema.index({ subscription: 1, periodKey: 1, applicantKey: 1 }); // §15.1
UsageRecordSchema.index({ subscription: 1, dayKey: 1 }); // daily trend chart

// ── Virtuals ─────────────────────────────────────────────────────────────────
UsageRecordSchema.virtual("amountValue").get(function () {
  return this.amount == null ? null : parseFloat(this.amount.toString());
});

// ── Validation ───────────────────────────────────────────────────────────────
UsageRecordSchema.pre("validate", function (next) {
  // Negative quantity/amount is how a correction is expressed, and is valid
  // ONLY on a reversal. Anywhere else it is a bug that would silently credit
  // the customer.
  if (!this.reversalOf) {
    if (this.quantity < 0) {
      this.invalidate("quantity", "quantity cannot be negative except on a reversal");
    }
    if (this.amount != null && parseFloat(this.amount.toString()) < 0) {
      this.invalidate("amount", "amount cannot be negative except on a reversal");
    }
  }
  next();
});

// ── Immutability ─────────────────────────────────────────────────────────────
const MUTABLE_AFTER_INSERT = ["status", "invoice", "billedAt", "exclusionReason"];

UsageRecordSchema.pre("save", function (next) {
  if (this.isNew) return next();
  const illegal = this.modifiedPaths().filter(
    (p) => !MUTABLE_AFTER_INSERT.includes(p.split(".")[0])
  );
  if (illegal.length) {
    return next(
      new Error(
        "A usage record is immutable — append a reversing record instead. " +
          `Illegal changes: ${illegal.join(", ")}`
      )
    );
  }
  next();
});

UsageRecordSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("UsageRecord", UsageRecordSchema);
