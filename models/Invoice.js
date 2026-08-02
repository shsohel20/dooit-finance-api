const mongoose = require("mongoose");

const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const {
  INVOICE_STATUS,
  LINE_TYPES,
  CURRENCIES,
  DISCOUNT_TYPES,
} = require("./constants/billing");
const { nonNegative, maxScale, serializeDecimals, toNumber } = require("../utils/money");

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Invoice — a period statement, and a SNAPSHOT.
//
// Every line carries its own description, quantity and unit price, so the
// invoice renders identically in three years regardless of what happened to the
// plan, the product catalogue or the subscription. Nothing here is resolved by
// join at render time.
//
// An issued invoice is never edited. A correction is: void it, release its usage
// records, and issue a replacement carrying `replacesInvoice` — both documents
// persist, because the audit trail is the point.
//
// See docs/billingmodule/mongoose-schema.md §C.6 and §G.8
// ─────────────────────────────────────────────────────────────────────────────

const InvoiceLineSchema = new Schema(
  {
    lineType: { type: String, enum: LINE_TYPES, required: true },

    product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    productCode: { type: String, trim: true, default: null },

    // Everything needed to reproduce this line WITHOUT loading the plan,
    // the product, or the subscription.
    description: { type: String, required: true, trim: true, maxlength: 300 },

    quantity: { type: Number, default: null },
    unitPrice: { type: Schema.Types.Decimal128, default: null },
    amount: { type: Schema.Types.Decimal128, required: true },

    // Under Model B, entitled usage is paid for by the base fee. Those lines are
    // recorded at amount 0 so the invoice still SHOWS what was consumed —
    // "430 ID verifications, included" — rather than hiding it.
    isIncluded: { type: Boolean, default: false },

    // Usage of a product the plan does NOT entitle. Also carried at amount 0,
    // but for the opposite reason: `isIncluded` means "already paid for",
    // `isExcluded` means "outside the agreement and therefore not charged".
    //
    // Both are shown. An invoice that silently omitted excluded usage would
    // leave the customer unable to reconcile it against their own logs, and
    // would hide the fact that they are consuming something they are not
    // entitled to — which is exactly the thing someone needs to see.
    isExcluded: { type: Boolean, default: false },

    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

// Declared as its own Schema rather than inline. A nested plain object whose
// first key is `type` is the one shape Mongoose cannot read unambiguously — it
// would take `discountApplied` itself to be a String path and silently discard
// `value` and `reason`. Inside `new Schema({...})` a top-level `type` key is
// unambiguous, so this form is safe.
const AppliedDiscountSchema = new Schema(
  {
    type: { type: String, enum: DISCOUNT_TYPES, default: "none" },
    value: { type: Number, default: 0 },
    reason: { type: String, trim: true, maxlength: 300, default: null },
  },
  { _id: false }
);

const InvoiceSchema = new Schema(
  {
    // INV-2026-0072 — allocated only when the invoice is ISSUED, so the issued
    // sequence has no gaps from abandoned drafts.
    invoiceNumber: { type: String, unique: true, sparse: true, index: true },

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

    status: {
      type: String,
      enum: { values: INVOICE_STATUS, message: "`{VALUE}` is not a valid invoice status" },
      default: "draft",
      required: true,
      index: true,
    },

    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    periodKey: { type: String, required: true, index: true },

    currency: { type: String, enum: CURRENCIES, required: true, default: "AUD" },
    lineItems: { type: [InvoiceLineSchema], default: [] },

    // ── Totals ───────────────────────────────────────────────────────────────
    subtotal: { type: Schema.Types.Decimal128, required: true, default: 0, validate: [nonNegative] },
    discount: { type: Schema.Types.Decimal128, required: true, default: 0, validate: [nonNegative] },
    taxRatePercent: { type: Number, default: 0, min: 0 },
    tax: { type: Schema.Types.Decimal128, required: true, default: 0, validate: [nonNegative] },
    total: { type: Schema.Types.Decimal128, required: true, default: 0 },
    amountPaid: { type: Schema.Types.Decimal128, required: true, default: 0 },
    amountDue: { type: Schema.Types.Decimal128, required: true, default: 0 },

    // ── Allowance accounting (Model B) ───────────────────────────────────────
    // What the allowance was, and how much of it the period actually consumed.
    // Stored so the invoice explains itself without recomputing from usage.
    allowance: {
      unit: { type: String, trim: true, default: "applicant" },
      included: { type: Number, default: null }, // null ⇒ unlimited
      used: { type: Number, default: 0 }, // DISTINCT applicants
      overage: { type: Number, default: 0 },
      overageUnitPrice: {
        type: Schema.Types.Decimal128,
        default: null,
        validate: [nonNegative, maxScale(6)],
      },
    },

    // The concession that produced `discount`, frozen at close time.
    //
    // `discount` alone says A$285 came off; this says why — 15%, and on whose
    // authority. The subscription's own discount is mutable by design, so
    // without this copy the reason for an old invoice's total is lost the first
    // time someone renegotiates.
    discountApplied: { type: AppliedDiscountSchema, default: () => ({}) },

    // Lineage only — never used for pricing.
    planSnapshot: {
      plan: { type: Schema.Types.ObjectId, ref: "BillingPlan", default: null },
      planCode: { type: String, default: null },
      planName: { type: String, default: null },
      planVersion: { type: Number, default: null },
    },

    issuedAt: { type: Date, default: null },
    dueAt: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null },

    // ── Delivery ─────────────────────────────────────────────────────────────
    // Whether the customer was actually sent this invoice, and when. Recorded
    // because "did they ever receive it?" is the first question asked about an
    // unpaid invoice, and a resend must not look like a first send.
    // `lastSentTo` is stored MASKED (s****@domain) — the plaintext address is a
    // delivery detail, not something to persist a second copy of alongside the
    // encrypted one on Users.
    sentAt: { type: Date, default: null },
    sentCount: { type: Number, default: 0, min: 0 },
    lastSentTo: { type: String, trim: true, default: null },

    // ── Dunning ──────────────────────────────────────────────────────────────
    // Overdue reminders, sent by the hourly sweep on a fixed schedule of
    // days-past-due. `lastStageDays` is the highest schedule step already sent,
    // NOT a count: the sweep runs hourly, so a step must be recorded by WHICH
    // step it was, or a single stage would re-fire every hour for a day.
    dunning: {
      lastStageDays: { type: Number, default: null },
      lastRemindedAt: { type: Date, default: null },
      reminderCount: { type: Number, default: 0, min: 0 },
    },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, trim: true, maxlength: 500, default: null },

    // Regeneration: void + reissue, never edit in place.
    replacesInvoice: { type: Schema.Types.ObjectId, ref: "Invoice", default: null },
    replacedByInvoice: { type: Schema.Types.ObjectId, ref: "Invoice", default: null },

    closedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    notes: { type: String, trim: true, maxlength: 2000, default: null },
  },
  {
    collection: "invoices",
    timestamps: true,
    toJSON: { virtuals: true, transform: (_doc, ret) => serializeDecimals(ret) },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// One invoice per subscription per period — the structural defence against a
// retried close job issuing a second invoice. Excludes voided invoices so a
// replacement can be issued for the same period.
//
// Keyed on `voidedAt: null` rather than the more obvious `status: {$ne:'void'}`.
// MongoDB accepts only a restricted grammar in partialFilterExpression —
// equality, $exists, $gt/$gte/$lt/$lte, $type and $and — and REJECTS $ne with
// "Expression not supported in partial index: $not". A schema-level index that
// mongod refuses to build fails silently: Model.init() rejects, mongoose logs
// nothing by default, and the collection simply has no index. This one never
// existed, so until now the only thing standing between a retried close job and
// a duplicate invoice was a check-then-insert with a race window between the
// two halves.
//
// `voidedAt` is set by voidInvoice() at the same moment as `status: 'void'`, so
// the two express the same fact and stay in step. Verified semantics: rejects a
// second live invoice for a period, permits a replacement once the first is
// voided, and lets several voided invoices for one period coexist.
//
// NOTE for existing deployments: if a database already contains duplicate live
// invoices for one {subscription, periodKey} — possible precisely because this
// index was absent — the build will fail until they are voided or removed.
InvoiceSchema.index(
  { subscription: 1, periodKey: 1 },
  { unique: true, partialFilterExpression: { voidedAt: null } }
);
InvoiceSchema.index({ user: 1, status: 1, issuedAt: -1 });
InvoiceSchema.index({ status: 1, dueAt: 1 }); // overdue sweep
InvoiceSchema.index({ client: 1, periodKey: 1 });

// ── Virtuals ─────────────────────────────────────────────────────────────────
InvoiceSchema.virtual("totalValue").get(function () {
  return toNumber(this.total);
});

InvoiceSchema.virtual("isOverdue").get(function () {
  return (
    ["open", "overdue"].includes(this.status) &&
    !!this.dueAt &&
    this.dueAt.getTime() < Date.now()
  );
});

// ── Totals invariant ─────────────────────────────────────────────────────────
// Enforced rather than trusted: a billing bug that silently mis-sums is worse
// than a save that fails loudly.
InvoiceSchema.pre("validate", function (next) {
  const n = toNumber;

  // subtotal must equal the sum of every non-discount, non-tax line
  const lineSum = (this.lineItems || [])
    .filter((l) => !["discount", "tax"].includes(l.lineType))
    .reduce((s, l) => s + n(l.amount), 0);

  if (Math.abs(lineSum - n(this.subtotal)) > 0.005) {
    this.invalidate(
      "subtotal",
      `subtotal ${n(this.subtotal)} does not equal the sum of its lines (${lineSum.toFixed(2)})`
    );
  }

  const expectedTotal = +(n(this.subtotal) - n(this.discount) + n(this.tax)).toFixed(2);
  if (Math.abs(expectedTotal - n(this.total)) > 0.005) {
    this.invalidate(
      "total",
      `total ${n(this.total)} != subtotal - discount + tax (${expectedTotal})`
    );
  }

  const expectedDue = +(n(this.total) - n(this.amountPaid)).toFixed(2);
  if (Math.abs(expectedDue - n(this.amountDue)) > 0.005) {
    this.invalidate(
      "amountDue",
      `amountDue ${n(this.amountDue)} != total - amountPaid (${expectedDue})`
    );
  }

  next();
});

// ── Immutability ─────────────────────────────────────────────────────────────
const MUTABLE_AFTER_ISSUE = [
  "status",
  "amountPaid",
  "amountDue",
  "paidAt",
  "voidedAt",
  "voidReason",
  "replacedByInvoice",
  "notes",
  "updatedAt",
  // Delivery is something that happens TO an issued invoice, not a change to
  // what it says — an invoice is emailed after it is issued, by definition.
  "sentAt",
  "sentCount",
  "lastSentTo",
  "dunning",
];

// `loadedStatus` is the status this document was last PERSISTED as, which is
// what the guard below compares against.
//
// post('init') alone is not enough: it fires only for documents read back from
// the database, so a document that was just created carries `undefined` here.
// That made the "drafts are still being assembled" bypass miss exactly the case
// it exists for — closing a period and issuing the resulting draft in one pass
// failed with "An issued invoice is immutable", because the freshly created
// draft did not look like a draft to the guard. Stamping on save as well closes
// that gap and keeps the guard strict once a document really is issued.
InvoiceSchema.post("init", function () {
  this.$locals.loadedStatus = this.status;
});

InvoiceSchema.post("save", function () {
  this.$locals.loadedStatus = this.status;
});

InvoiceSchema.pre("save", function (next) {
  if (this.isNew) return next();
  // Drafts are still being assembled; only an ISSUED invoice is frozen.
  if (this.$locals.loadedStatus === "draft") return next();

  const illegal = this.modifiedPaths().filter(
    (p) => !MUTABLE_AFTER_ISSUE.includes(p.split(".")[0])
  );
  if (illegal.length) {
    return next(
      new Error(
        "An issued invoice is immutable — void it and issue a replacement. " +
          `Illegal changes: ${illegal.join(", ")}`
      )
    );
  }
  next();
});

InvoiceSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
InvoiceSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("Invoice", InvoiceSchema);
