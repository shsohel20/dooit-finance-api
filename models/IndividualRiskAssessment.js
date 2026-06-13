const mongoose = require("mongoose");
const { Schema } = mongoose;

const IndividualRiskAssessmentSchema = new Schema(
  {
    uid: String,
    client: { type: Schema.Types.ObjectId, ref: "Client", index: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", index: true },
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
      required: false, // allow external assessment too
    },

    customerUid: String,
    customerName: String,

    // snapshot used for calculation
    inputSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },

    // computed breakdown
    assessment: {
      customerType: {},
      jurisdiction: {},
      customerRetention: {},
      product: {},
      channel: {},
      occupation: {},
      industry: {},
      pepStatus: {},
      sourceOfFunds: {},
      sourceOfWealth: {},
      adverseMedia: {},
    },

    riskScore: Number,
    riskLabel: String,

    // reporting entity type the product catalogue was scoped to
    entityType: { type: String, default: "" },

    // engine override notes (e.g. "Foreign PEP — minimum HIGH")
    overrides: { type: [String], default: [] },

    // UHRC / mixer-style hard blocks — decline service, do not alert client
    serviceBlocked: { type: Boolean, default: false },

    // periodic review (Section 4): Low +3y · Medium +2y · High +1y
    nextReviewDate: { type: Date, default: null, index: true },

    // relation summary (if used)
    relationSummary: {
      maxScore: Number,
      averageScore: Number,
      highestLabel: String,
    },

    assessedAt: {
      type: Date,
      default: Date.now,
    },

    assessedBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },

    source: {
      type: String,
      default: "manual", // api / system / onboarding / batch
    },

    version: {
      type: Number,
      default: 1,
    },

    notes: String,

    // ── ECDD Gate (blocks service delivery until CO resolves) ─────────────────
    // Set to true when CRA result is High or Unacceptable
    ecddRequired: { type: Boolean, default: false },
    // Compliance Officer must approve or decline before service delivery resumes
    cddGate:      { type: Boolean, default: false },

    ecddStatus: {
      type: String,
      enum: ["Pending", "Approved", "Declined", ""],
      default: "",
    },
    ecddDecision:    { type: String, default: "" }, // CO's written rationale
    ecddDecidedBy:   { type: Schema.Types.ObjectId, ref: "Users", default: null },
    ecddDecidedAt:   { type: Date, default: null },
    ecddReviewDate:  { type: Date, default: null }, // next scheduled ECDD review

    // the completed ECDD form backing the gate decision (spec: "CO must
    // complete ECDD form and click 'Approve'")
    ecddReport: { type: Schema.Types.ObjectId, ref: "EcddReport", default: null },
  },
  { timestamps: true },
);

IndividualRiskAssessmentSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `CRA_${Date.now()}`;
  }
  next();
});
module.exports = mongoose.model(
  "IndividualRiskAssessment",
  IndividualRiskAssessmentSchema,
);
