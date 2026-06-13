const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const EwraRiskFactorSchema = new mongoose.Schema(
  {
    assessmentId: {
      type: mongoose.Schema.ObjectId,
      ref: "EwraAssessment",
      required: true,
      index: true,
    },
    category: {
      type: String,
      required: true,
      enum: ["Customer","Product","Channel","Geographic","Environmental"],
      index: true,
    },
    factorName:  { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    weight:      { type: Number, default: 20, min: 0, max: 100 }, // % within category

    // factorId links to ewra_factors seed template (e.g. "EW_C_001")
    factorId:    { type: String, trim: true, default: "" },

    // ── 5×5 Matrix inputs ──────────────────────────────────────────────────
    // NOTE: "impact" = "consequence" in AUSTRAC/workbook language — same field
    likelihood:  { type: Number, min: 1, max: 5, default: null },
    impact:      { type: Number, min: 1, max: 5, default: null },
    inherentScore:  { type: Number, default: null },
    inherentRating: { type: String, enum: ["Very Low","Low","Medium","High","Extreme",""], default: "" },

    // ── Control effectiveness ───────────────────────────────────────────────
    controlEffectiveness: { type: Number, min: 0, max: 5, default: null },
    residualScore:        { type: Number, default: null },
    residualRating:       { type: String, enum: ["Very Low","Low","Medium","High","Extreme",""], default: "" },

    // ── Amendment diff (populated when copied from prior assessment) ────────
    priorInherentScore: { type: Number, default: null },
    priorResidualScore: { type: Number, default: null },
    delta: { type: String, enum: ["up","down","same","new",""], default: "" },

    // ── Qualitative ────────────────────────────────────────────────────────
    rationale:     { type: String, default: "" },
    keyIndicators: [{ type: String }],

    // ── Scenario roll-up (supporting evidence from the risk register) ───────
    // Aggregated from this factor's EwraRiskScenario children on calculate;
    // informational — does not override the CO's factor scoring.
    scenarioRollup: {
      count:         { type: Number, default: 0 },
      actionCount:   { type: Number, default: 0 },
      worstInherent: { type: String, default: "" }, // VL/L/M/H/E
      worstResidual: { type: String, default: "" },
      avgCtrlEff:    { type: Number, default: null }, // avg derived control eff across scenarios
    },

    // ── Status ─────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["Not Started","In Progress","Complete"],
      default: "Not Started",
    },
    assignedTo: { type: String, default: "" },

    sortOrder: { type: Number, default: 0 },
    client:    { type: mongoose.Schema.ObjectId, ref: "Client", default: null },
  },
  { timestamps: true }
);

EwraRiskFactorSchema.index({ assessmentId: 1, category: 1, sortOrder: 1 });
EwraRiskFactorSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("EwraRiskFactor", EwraRiskFactorSchema);
