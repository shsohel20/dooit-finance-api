const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const CategoryScoreSchema = new mongoose.Schema({
  category: { type: String, enum: ["Customer", "Product", "Channel", "Geographic", "Environmental"] },
  weight:          { type: Number, default: 20 },   // % weight of this category
  inherentScore:   { type: Number, default: null },  // 0-5
  controlScore:    { type: Number, default: null },  // 0-5 (effectiveness)
  residualScore:   { type: Number, default: null },  // 0-5
  rating:          { type: String, enum: ["Low","Medium","High","Extreme",""], default: "" },
}, { _id: false });

const EwraAssessmentSchema = new mongoose.Schema(
  {
    assessmentName: { type: String, required: true, trim: true },
    entityProfile:  { type: mongoose.Schema.ObjectId, ref: "EntityProfile", required: true, index: true },

    assessmentType: {
      type: String,
      enum: ["EWRA", "BRA", "PRODUCT_RA"],
      default: "EWRA",
    },
    riskTypes: [{
      type: String,
      enum: ["AML","CTF","SANCTIONS","FRAUD","ABAC","MODERN_SLAVERY","PROLIFERATION"],
    }],

    periodStart: { type: Date },
    periodEnd:   { type: Date },
    version:     { type: String, default: "1.0" },

    status: {
      type: String,
      enum: ["Draft","In Review","Approved","Archived"],
      default: "Draft",
      index: true,
    },

    // ── Computed scores ────────────────────────────────────────────────────
    inherentRiskScore:    { type: Number, default: null },
    inherentRiskRating:   { type: String, enum: ["Low","Medium","High","Extreme",""], default: "" },
    controlEffectivenessScore: { type: Number, default: null },
    residualRiskScore:    { type: Number, default: null },
    residualRiskRating:   { type: String, enum: ["Low","Medium","High","Extreme",""], default: "" },
    nraFloor:             { type: String, default: "" }, // e.g. "Medium"

    // per-category breakdown
    categoryScores: [CategoryScoreSchema],

    // ── Workflow ───────────────────────────────────────────────────────────
    submittedBy: { type: mongoose.Schema.ObjectId, ref: "Users", default: null },
    submittedAt: { type: Date, default: null },
    approvedBy:  { type: mongoose.Schema.ObjectId, ref: "Users", default: null },
    approvedAt:  { type: Date, default: null },
    reviewNotes: { type: String, default: "" },

    // ── Progress tracking ──────────────────────────────────────────────────
    factorsComplete:  { type: Number, default: 0 },
    factorsTotal:     { type: Number, default: 0 },
    controlsComplete: { type: Number, default: 0 },
    controlsTotal:    { type: Number, default: 0 },

    client:    { type: mongoose.Schema.ObjectId, ref: "Client", default: null },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "Users", default: null },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: "Users", default: null },
  },
  { timestamps: true }
);

EwraAssessmentSchema.index({ entityProfile: 1, status: 1 });
EwraAssessmentSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("EwraAssessment", EwraAssessmentSchema);
