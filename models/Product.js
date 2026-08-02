const mongoose = require("mongoose");

const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { assignSequence } = require("../utils/sequence");

const {
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
  METER_SOURCES,
  PRODUCT_STATUS,
  CURRENCIES,
} = require("./constants/billing");
const { nonNegative, maxScale, serializeDecimals } = require("../utils/money");

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Product — the reusable catalogue of billable AML/compliance SKUs.
//
// Authored by dooit users only; global to every client. There is deliberately
// NO `client` field: every document here is platform-owned, and adding a
// tenant field would invite tenant-scoped queries that return nothing.
// See docs/billingmodule/schema-design.md §6.1.1.
//
// `defaultUnitPrice` is the LIST price. A plan may override it per product, and
// the subscription's priceSnapshot freezes whatever was resolved at purchase —
// so editing this value never re-prices an existing subscriber.
//
// Money is Decimal128, not Number: unit prices run to four decimals
// (A$0.0065 Device Intelligence, A$0.0198 Applicant Risk Scoring) and IEEE-754
// doubles accumulate error when summed across thousands of usage records.
// See docs/billingmodule/mongoose-schema.md §B.5.
// ─────────────────────────────────────────────────────────────────────────────

const ProductSchema = new Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────────
    // Human-readable key, assigned atomically on insert (see utils/sequence.js).
    // The raw counter value is not stored — uid carries it.
    uid: { type: String, unique: true, sparse: true, index: true }, // PRD-0000001

    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      maxlength: [160, "Product name cannot exceed 160 characters"],
    },

    // Stable machine key used by meter producers (e.g. 'aus_gov_dvs').
    // Immutable after creation — usage records reference it by value.
    code: {
      type: String,
      required: [true, "Product code is required"],
      trim: true,
      lowercase: true,
      unique: true,
      match: [
        /^[a-z0-9_]{2,60}$/,
        "code must be 2-60 chars of lowercase letters, digits or underscore",
      ],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [1000, "Description cannot exceed 1000 characters"],
      default: null,
    },

    // ── Classification ───────────────────────────────────────────────────────
    category: {
      type: String,
      required: [true, "Product category is required"],
      enum: {
        values: PRODUCT_CATEGORIES,
        message: "`{VALUE}` is not a valid product category",
      },
      index: true,
    },

    // What one billable unit is — rendered on invoice lines.
    unit: {
      type: String,
      required: true,
      enum: { values: PRODUCT_UNITS, message: "`{VALUE}` is not a valid unit" },
      default: "check",
    },

    // ── Metering ─────────────────────────────────────────────────────────────
    meterSource: {
      type: String,
      enum: { values: METER_SOURCES, message: "`{VALUE}` is not a valid meter source" },
      default: "internal",
    },
    // Upstream event name this product is metered from, when applicable.
    meterEvent: { type: String, trim: true, default: null },

    // ── Pricing (list price — plans and snapshots may override) ──────────────
    currency: {
      type: String,
      enum: { values: CURRENCIES, message: "`{VALUE}` is not a supported currency" },
      default: "AUD",
    },
    // NOTE: `min: 0` would be silently ignored here — Mongoose's min/max only
    // apply to Number and Date paths, never Decimal128. Use the shared
    // validators in utils/money.js instead. See §B.5 of the schema spec.
    defaultUnitPrice: {
      type: Schema.Types.Decimal128,
      required: [true, "defaultUnitPrice is required"],
      validate: [nonNegative, maxScale(6)],
    },

    // false ⇒ metered and displayed, but charged at zero (e.g. 'Known face search')
    billable: { type: Boolean, default: true },

    // ── Lifecycle ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: { values: PRODUCT_STATUS, message: "`{VALUE}` is not a valid status" },
      default: "active",
      index: true,
    },

    // Must be a user holding an active `dooit` UserType membership.
    // Enforced in the service layer (assertUserType) — a ref cannot express it,
    // because userType lives on UserType, not Users.
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "createdBy is required"],
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "products",
    timestamps: true,
    // Decimal128 would otherwise serialise as {"$numberDecimal":"0.79"}; emit a
    // plain number for API consumers. The stored value stays Decimal128.
    toJSON: { virtuals: true, transform: (_doc, ret) => serializeDecimals(ret) },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// `code` and `uid` uniqueness are declared inline on the paths above.
ProductSchema.index({ category: 1, status: 1 });
ProductSchema.index({ status: 1, isDeleted: 1, name: 1 });

// ── Virtuals ─────────────────────────────────────────────────────────────────
// Decimal128 serialises as { $numberDecimal: "0.79" }, which is awkward for the
// UI. Expose a plain number alongside it rather than mutating the stored type.
ProductSchema.virtual("unitPriceValue").get(function () {
  return this.defaultUnitPrice == null
    ? null
    : parseFloat(this.defaultUnitPrice.toString());
});

// ── Hooks ────────────────────────────────────────────────────────────────────

// `code` is referenced by value from usage records and plan snapshots, so it
// must never change once the document exists.
ProductSchema.pre("save", function (next) {
  if (!this.isNew && this.isModified("code")) {
    return next(
      new Error("Product.code is immutable — create a new product instead")
    );
  }
  next();
});

ProductSchema.pre("save", function (next) {
  if (this.isModified("status") && this.status === "inactive" && !this.deletedAt) {
    // Deactivation is not deletion; leave isDeleted alone but stamp the moment.
    this.metadata = { ...(this.metadata || {}), deactivatedAt: new Date() };
  }
  next();
});

// ── Numbering ────────────────────────────────────────────────────────────────
// Assigns `uid` (PRD-0000001) atomically on insert.
// Deliberately NOT mongoose-sequence: its hook is parallel middleware, so any
// later hook reading `this.sequence` sees undefined — see utils/sequence.js.
ProductSchema.pre("save", assignSequence("product_sequence", "PRD"));

// ── Plugins ──────────────────────────────────────────────────────────────────
ProductSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
ProductSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("Product", ProductSchema);
