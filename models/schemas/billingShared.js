// models/schemas/billingShared.js
//
// Sub-schemas shared between BillingPlan and Subscription.
//
// These MUST be defined once. `subscriptions.priceSnapshot` is a frozen copy of
// the plan's commercials, so if the plan's tier/product shape and the snapshot's
// shape ever diverge, old snapshots silently stop validating — and the whole
// immutability guarantee rests on the snapshot being a faithful copy.
//
// Reference: docs/billingmodule/mongoose-schema.md §C.2 / §C.4

const mongoose = require("mongoose");
const { nonNegative, maxScale } = require("../../utils/money");

const { Schema } = mongoose;

// ── A single volume/tier band ────────────────────────────────────────────────
// Bands are inclusive on both ends. `to: null` means "and above" (open-ended).
const TierSchema = new Schema(
  {
    from: { type: Number, required: true, min: [0, "tier.from cannot be negative"] },
    to: { type: Number, default: null, min: [0, "tier.to cannot be negative"] },
    unitPrice: {
      type: Schema.Types.Decimal128,
      required: [true, "tier.unitPrice is required"],
      validate: [nonNegative, maxScale(6)],
    },
    // Display only — the price is authoritative, this is what the UI shows.
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  { _id: false }
);

// ── Plan ↔ product entitlement ───────────────────────────────────────────────
// Embedded so it versions atomically with the plan (§B.1). Carries a snapshot of
// the product's code/name/unit so a plan renders with no join and survives the
// product being archived.
const PlanProductSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: [true, "productId is required"],
    },
    code: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },

    enabled: { type: Boolean, default: true },
    includedQuantity: { type: Number, default: 0, min: 0 },

    // null ⇒ inherit Product.defaultUnitPrice at rating time
    unitPrice: {
      type: Schema.Types.Decimal128,
      default: null,
      validate: [nonNegative, maxScale(6)],
    },
    overagePrice: {
      type: Schema.Types.Decimal128,
      default: null,
      validate: [nonNegative, maxScale(6)],
    },

    tiers: { type: [TierSchema], default: [] },
  },
  { _id: false }
);

// ── Marketing / comparison feature row ───────────────────────────────────────
const PlanFeatureSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 160 },
    // true | false | '5,000' | 'Add-on' | '99.9%' — matches the UI's check/dash/text renderer
    value: { type: Schema.Types.Mixed, default: true },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

/**
 * Validate a tier ladder: ascending, contiguous, non-overlapping, with at most
 * one open-ended band which must sort last.
 *
 * The UI lets users type free text ('∞', '10,001', '—'); the service layer is
 * responsible for parsing to numbers before the document reaches here.
 *
 * @param {Array} tiers
 * @param {String} where  label used in the error message
 * @returns {String|null} error message, or null when the ladder is valid
 */
function validateTierLadder(tiers, where = "tiers") {
  if (!tiers || tiers.length === 0) return null;

  const open = tiers.filter((t) => t.to === null || t.to === undefined);
  if (open.length > 1) return `${where}: only one tier may be open-ended`;

  const sorted = [...tiers].sort((a, b) => a.from - b.from);

  for (let i = 0; i < sorted.length; i += 1) {
    const t = sorted[i];
    const next = sorted[i + 1];

    if (t.to != null && t.to < t.from) {
      return `${where}: band ${t.from}–${t.to} is inverted`;
    }
    if (next) {
      if (t.to == null) return `${where}: the open-ended band must be last`;
      if (next.from !== t.to + 1) {
        return `${where}: gap or overlap between ${t.to} and ${next.from}`;
      }
    }
  }
  return null;
}

module.exports = {
  TierSchema,
  PlanProductSchema,
  PlanFeatureSchema,
  validateTierLadder,
};
