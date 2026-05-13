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

    // ── 5×5 Matrix inputs ──────────────────────────────────────────────────
    likelihood:  { type: Number, min: 1, max: 5, default: null }, // 1=Rare … 5=Almost Certain
    impact:      { type: Number, min: 1, max: 5, default: null }, // 1=Insignificant … 5=Catastrophic
    inherentScore:  { type: Number, default: null },              // matrix cell value 1-25 → normalised 1-5
    inherentRating: { type: String, enum: ["Low","Medium","High","Extreme",""], default: "" },

    // ── Control effectiveness ───────────────────────────────────────────────
    controlEffectiveness: { type: Number, min: 0, max: 5, default: null }, // 0-5
    residualScore:        { type: Number, default: null },
    residualRating:       { type: String, enum: ["Low","Medium","High","Extreme",""], default: "" },

    // ── Qualitative ────────────────────────────────────────────────────────
    rationale:     { type: String, default: "" },
    keyIndicators: [{ type: String }],

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
