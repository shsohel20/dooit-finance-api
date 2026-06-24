const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const RATING_ENUM = ["Very Low","Low","Medium","High","Extreme",""];

const CategoryScoreSchema = new mongoose.Schema({
  category: { type: String, enum: ["Customer", "Product", "Channel", "Geographic", "Environmental"] },
  weight:          { type: Number, default: 20 },
  inherentScore:   { type: Number, default: null },
  controlScore:    { type: Number, default: null },
  residualScore:   { type: Number, default: null },
  rating:          { type: String, enum: RATING_ENUM, default: "" },
  // delta from prior assessment (amendment diff)
  priorResidualScore: { type: Number, default: null },
  delta:              { type: String, enum: ["up","down","same","new",""], default: "" },
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
    inherentRiskScore:         { type: Number, default: null },
    inherentRiskRating:        { type: String, enum: RATING_ENUM, default: "" },
    controlEffectivenessScore: { type: Number, default: null },
    residualRiskScore:         { type: Number, default: null },
    residualRiskRating:        { type: String, enum: RATING_ENUM, default: "" },
    nraFloor:                  { type: String, default: "" },

    categoryScores: [CategoryScoreSchema],

    // ── Risk register section taxonomy (dynamic) ──────────────────────────────
    // Seeded with the AUSTRAC/FATF default sections (S1–S8) on creation;
    // COs may add custom sections. Scenarios reference sections by `code`.
    registerSections: [
      new mongoose.Schema(
        {
          code:      { type: String, required: true, trim: true },   // "S1"…"S8", "S9"+ custom
          label:     { type: String, required: true, trim: true },
          category:  { type: String, enum: ["Customer","Product","Channel","Geographic","Environmental"], default: "Customer" },
          sortOrder: { type: Number, default: 0 },
          basis:     { type: String, default: "" },                  // regulatory anchor
          source:    { type: String, enum: ["default","custom"], default: "custom" },
        },
        { _id: false }
      ),
    ],

    // ── Amendment tracking ─────────────────────────────────────────────────
    amendmentType: {
      type: String,
      enum: ["initial","annual_review","trigger_update"],
      default: "initial",
    },
    triggerReason:      { type: String, default: "" },
    priorAssessmentId:  { type: mongoose.Schema.ObjectId, ref: "EwraAssessment", default: null },
    amendmentPending:   { type: Boolean, default: false },

    // ── Review schedule ────────────────────────────────────────────────────
    reviewDate:         { type: Date, default: null },
    reviewCycleYears:   { type: Number, default: null },

    // ── NRA baseline (from entity_config) ─────────────────────────────────
    nraBaselineReference: { type: String, default: "" },
    sectorNraInherentMl:  { type: String, default: "" },
    sectorNraInherentTf:  { type: String, default: "" },
    sectorNraInherentPf:  { type: String, default: "" },

    // ── Wizard answers (steps 1-7) ─────────────────────────────────────────
    ewraAnswers: {
      // Step 1
      turnoverRange:              String,
      isSolePractitioner:         Boolean,
      austracEnrolled:            String,
      // Step 2
      clientTypes:                [String],
      foreignClientProportion:    String,
      complexStructures:          String,
      pepExposure:                String,
      // Step 3
      deliveryChannels:           [String],
      nonF2fProportion:           String,
      usesIntermediaries:         String,
      handlesCash:                String,
      // Step 4-6 — risk factor answers (key:value per question id)
      dsRiskFactors:              { type: mongoose.Schema.Types.Mixed, default: {} },
      crRiskFactors:              { type: mongoose.Schema.Types.Mixed, default: {} },
      chRiskFactors:              { type: mongoose.Schema.Types.Mixed, default: {} },
      // Step 7
      countriesExposure:          [String],
      mediumRiskCountry:          String,
      highRiskCountry:            String,
      sanctionsScreeningConfirmed:String,
    },

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
