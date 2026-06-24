const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

/**
 * EwraRiskScenario — micro layer of the EWRA framework.
 * One specific ML/TF/PF risk event (a Risk Register row, VDG_Risk_Register.md
 * format) under a parent EwraRiskFactor (macro dimension).
 *
 *   EwraAssessment (1)
 *     └── EwraRiskFactor (n)         ← macro: likelihood/impact per dimension
 *           └── EwraRiskScenario (n) ← micro: specific risk event
 *                 └── controlIds[]   ← join key to EwraControlAssessment.controlId
 */
const EwraRiskScenarioSchema = new mongoose.Schema(
  {
    assessmentId: {
      type: mongoose.Schema.ObjectId,
      ref: "EwraAssessment",
      required: true,
      index: true,
    },
    factorId: {
      type: mongoose.Schema.ObjectId,
      ref: "EwraRiskFactor",
      default: null,
      index: true,
    },
    factorRef: { type: String, trim: true, default: "" }, // "EW_C_001"
    category: {
      type: String,
      enum: ["Customer", "Product", "Channel", "Geographic", "Environmental", ""],
      default: "",
    },
    // section code — references EwraAssessment.registerSections.code
    // (dynamic taxonomy: S1–S8 defaults + custom sections, so no enum)
    riskSection: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    riskType: { type: String, trim: true, default: "" }, // Customer/Product/Jurisdiction/Channel/Behaviour/Operational

    ref: { type: Number, default: 0 }, // register sequence number
    riskName: { type: String, required: true, trim: true },
    description: { type: String, default: "" }, // root cause + red flags narrative
    pfSanctionsNote: { type: String, default: "" },
    applicableChannels: [{ type: String }], // ["F","D","T","A"]

    // ── 5×5 matrix inputs (codes computed via utils/ewraRiskRegister.js) ─────
    likelihood: { type: Number, min: 1, max: 5, default: null },
    consequence: { type: Number, min: 1, max: 5, default: null },
    inherentRisk: { type: String, enum: ["VL", "L", "M", "H", "E", ""], default: "" },

    existingControls: { type: String, default: "" },
    controlEffectiveness: { type: Number, min: 1, max: 5, default: null },
    // "derived" = computed from the linked EwraControlAssessment effectiveness
    // scores (the register is a REPORT over factors + controls); "manual" =
    // CO-entered fallback while linked controls are unassessed
    ctrlEffSource: { type: String, enum: ["manual", "derived"], default: "manual" },
    linkedControlsAssessed: { type: Number, default: 0 },
    residualRisk: { type: String, enum: ["VL", "L", "M", "H", "E", ""], default: "" },

    actionRequired: { type: Boolean, default: false },
    controlIds: [{ type: String }], // ["CTRL_CDD_001", …]
    controlsOwner: { type: String, default: "" },
    withinRiskAppetite: { type: Boolean, default: true },
    proposedTreatment: { type: String, default: "" },
    reviewerNotes: { type: String, default: "" },

    status: {
      type: String,
      enum: ["Draft", "Reviewed", "Approved"],
      default: "Draft",
    },

    // provenance: seeded from the template register or CO-created
    source: { type: String, enum: ["template", "manual"], default: "manual" },
    templateRef: { type: Number, default: null }, // sample_risk_register ref (1–28)

    // amendment diff (populated when copied from prior assessment)
    priorInherentRisk: { type: String, default: "" },
    priorResidualRisk: { type: String, default: "" },
    delta: { type: String, enum: ["up", "down", "same", "new", ""], default: "" },

    client: { type: mongoose.Schema.ObjectId, ref: "Client", default: null },
  },
  { timestamps: true }
);

EwraRiskScenarioSchema.index({ assessmentId: 1, riskSection: 1, ref: 1 });
EwraRiskScenarioSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("EwraRiskScenario", EwraRiskScenarioSchema);
