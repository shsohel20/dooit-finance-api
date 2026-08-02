const mongoose = require("mongoose");

const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// PlanEligibility — which client users may see and buy a PRIVATE plan.
//
// Why this is a collection rather than an `allowedClients: [ObjectId]` array on
// the plan: scale is not the reason (a multikey index would cope fine). The
// reason is IMMUTABILITY. A published plan is frozen, and granting a client
// access is an ordinary sales operation that may happen weekly — with an
// embedded array every grant would mutate a published plan document and break
// that guarantee. A separate collection also gets grantedBy / expiresAt /
// revocation, none of which fit in a bare ObjectId array.
//
// See docs/billingmodule/mongoose-schema.md §B.3
// ─────────────────────────────────────────────────────────────────────────────

const PlanEligibilitySchema = new Schema(
  {
    planId: {
      type: Schema.Types.ObjectId,
      ref: "BillingPlan",
      required: [true, "planId is required"],
      index: true,
    },

    // The client USER granted access. Must hold an active `client` UserType
    // membership — enforced by assertUserType() in the service layer.
    //
    // Named `user` (not `clientId`) to match the codebase: a Users ref is always
    // `user` (Client.js:160) and `client` always means the Client company
    // (Case.js:28). Calling a Users ref `clientId` inverts both conventions.
    user: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "user is required"],
      index: true,
    },

    // The company that user belongs to — a denormalised copy of their
    // `clientBelongs`. Unused by billing logic today; present so that moving to
    // company-level eligibility later is a query change, not a migration.
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      default: null,
      index: true,
    },

    // ── Grant ────────────────────────────────────────────────────────────────
    grantedBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "grantedBy is required"], // dooit
    },
    grantedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },

    // ── Revocation ───────────────────────────────────────────────────────────
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },

    status: {
      type: String,
      enum: {
        values: ["active", "revoked", "expired"],
        message: "`{VALUE}` is not a valid eligibility status",
      },
      default: "active",
      index: true,
    },

    note: { type: String, trim: true, maxlength: 500, default: null },
  },
  {
    collection: "planEligibility",
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// One grant row per (plan, user). Re-granting updates the existing row rather
// than accumulating duplicates.
PlanEligibilitySchema.index({ planId: 1, user: 1 }, { unique: true });
// "which private plans can I see?" — the hot read on the client catalogue
PlanEligibilitySchema.index({ user: 1, status: 1 });
// company-wide view of who has been granted what
PlanEligibilitySchema.index({ client: 1, status: 1 });
// expiry sweep
PlanEligibilitySchema.index({ status: 1, expiresAt: 1 });

// ── Virtuals ─────────────────────────────────────────────────────────────────
PlanEligibilitySchema.virtual("isCurrentlyValid").get(function () {
  if (this.status !== "active") return false;
  if (this.expiresAt && this.expiresAt.getTime() <= Date.now()) return false;
  return true;
});

// ── Hooks ────────────────────────────────────────────────────────────────────
PlanEligibilitySchema.pre("validate", function (next) {
  if (this.revokedAt && this.status === "active") {
    return next(new Error("A revoked eligibility cannot have status 'active'"));
  }
  if (this.expiresAt && this.grantedAt && this.expiresAt <= this.grantedAt) {
    return next(new Error("expiresAt must be after grantedAt"));
  }
  next();
});

PlanEligibilitySchema.pre("save", function (next) {
  if (this.isModified("status") && this.status === "revoked" && !this.revokedAt) {
    this.revokedAt = new Date();
  }
  next();
});

PlanEligibilitySchema.plugin(mongoosePaginate);

module.exports = mongoose.model("PlanEligibility", PlanEligibilitySchema);
