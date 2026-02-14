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
    },

    riskScore: Number,
    riskLabel: String,

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
