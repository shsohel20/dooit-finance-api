const mongoose = require("mongoose");

const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { assignSequence } = require("../utils/sequence");
const {
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  PAYMENT_METHODS,
  CURRENCIES,
} = require("./constants/billing");
const { nonNegative, maxScale, serializeDecimals } = require("../utils/money");

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Payment — money movement against an invoice.
//
// Two rules shape this collection, and both exist to keep the record of what was
// actually collected intact:
//
//   1. A RETRY is a new document, never an edit of the failed one. The dunning
//      history is the point — "we tried three times" must stay legible.
//
//   2. A REFUND is its own document pointing at the original via `refundOf`,
//      with a POSITIVE amount and `type: 'refund'`. Storing refunds as negative
//      amounts on the original would destroy the record of what was collected
//      and when. Partial refunds fall out naturally: several refund documents
//      against one payment.
//
// See docs/billingmodule/mongoose-schema.md §C.7, §G.7, §G.10
// ─────────────────────────────────────────────────────────────────────────────

const PaymentSchema = new Schema(
  {
    uid: { type: String, unique: true, sparse: true, index: true }, // PAY-0000001

    user: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "user is required"],
      index: true,
    },
    client: { type: Schema.Types.ObjectId, ref: "Client", default: null, index: true },
    invoice: {
      type: Schema.Types.ObjectId,
      ref: "Invoice",
      required: [true, "invoice is required"],
      index: true,
    },

    type: {
      type: String,
      enum: { values: PAYMENT_TYPES, message: "`{VALUE}` is not a valid payment type" },
      default: "payment",
      required: true,
      index: true,
    },

    // Always POSITIVE. `type` carries the direction — a negative amount here
    // would make "how much did we collect" ambiguous.
    amount: {
      type: Schema.Types.Decimal128,
      required: [true, "amount is required"],
      validate: [nonNegative, maxScale(2)],
    },
    currency: { type: String, enum: CURRENCIES, required: true, default: "AUD" },

    method: {
      type: String,
      enum: { values: PAYMENT_METHODS, message: "`{VALUE}` is not a valid payment method" },
      required: [true, "method is required"],
    },
    methodLabel: { type: String, trim: true, default: null }, // 'Card •••• 4421'

    status: {
      type: String,
      enum: { values: PAYMENT_STATUS, message: "`{VALUE}` is not a valid payment status" },
      default: "pending",
      required: true,
      index: true,
    },

    // ── Gateway ──────────────────────────────────────────────────────────────
    // Unique when present, so a replayed gateway webhook cannot double-post.
    //
    // Deliberately NO `default: null`. mongoose-unique-validator does not respect
    // `sparse` — it counts documents matching the value, and `null` IS a value,
    // so a second manual payment (which has no gateway id) would be rejected as
    // a duplicate of the first. Leaving the path undefined makes the validator
    // skip it, and the sparse DB index still catches genuine replays.
    transactionId: { type: String, trim: true },
    gateway: { type: String, trim: true, default: null },

    failureCode: { type: String, trim: true, default: null },
    failureReason: { type: String, trim: true, maxlength: 500, default: null },
    // How many attempts preceded this one. Retries chain via `retryOf`.
    retryCount: { type: Number, default: 0, min: 0 },
    retryOf: { type: Schema.Types.ObjectId, ref: "Payment", default: null },

    paidAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },

    // ── Refund linkage ───────────────────────────────────────────────────────
    refundOf: { type: Schema.Types.ObjectId, ref: "Payment", default: null, index: true },
    refundReason: { type: String, trim: true, maxlength: 500, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "payments",
    timestamps: true,
    toJSON: { virtuals: true, transform: (_doc, ret) => serializeDecimals(ret) },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// Sparse: most manual payments have no gateway id, and a unique index over many
// nulls would reject all but the first.
PaymentSchema.index({ transactionId: 1 }, { unique: true, sparse: true });
PaymentSchema.index({ invoice: 1, status: 1 });
PaymentSchema.index({ user: 1, createdAt: -1 }); // payment history
PaymentSchema.index({ status: 1, createdAt: -1 }); // failed-payment queue

// ── Virtuals ─────────────────────────────────────────────────────────────────
PaymentSchema.virtual("amountValue").get(function () {
  return this.amount == null ? null : parseFloat(this.amount.toString());
});

/** Signed for ledger display: a refund moves money the other way. */
PaymentSchema.virtual("signedAmount").get(function () {
  const v = this.amount == null ? 0 : parseFloat(this.amount.toString());
  return this.type === "refund" ? -v : v;
});

// ── Validation ───────────────────────────────────────────────────────────────
PaymentSchema.pre("validate", function (next) {
  if (this.type === "refund" && !this.refundOf) {
    this.invalidate("refundOf", "A refund must reference the original payment");
  }
  if (this.type === "payment" && this.refundOf) {
    this.invalidate("refundOf", "Only a refund may set refundOf");
  }
  // Keep the timestamps honest with the status they describe.
  if (this.status === "paid" && !this.paidAt) this.paidAt = new Date();
  if (this.status === "failed" && !this.failedAt) this.failedAt = new Date();
  next();
});

// ── Immutability ─────────────────────────────────────────────────────────────
// A settled payment is a financial record. Only the fields that describe a LATER
// event may change; the money itself never does.
const MUTABLE_AFTER_SETTLE = ["status", "refundedAt", "metadata", "updatedAt"];

PaymentSchema.post("init", function () {
  this.$locals.loadedStatus = this.status;
});

PaymentSchema.pre("save", function (next) {
  if (this.isNew) return next();
  if (this.$locals.loadedStatus === "pending") return next(); // still in flight

  const illegal = this.modifiedPaths().filter(
    (p) => !MUTABLE_AFTER_SETTLE.includes(p.split(".")[0])
  );
  if (illegal.length) {
    return next(
      new Error(
        "A settled payment is immutable — record a retry or a refund instead. " +
          `Illegal changes: ${illegal.join(", ")}`
      )
    );
  }
  next();
});

PaymentSchema.pre("save", assignSequence("payment_sequence", "PAY"));

PaymentSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
PaymentSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("Payment", PaymentSchema);
