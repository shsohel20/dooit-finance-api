const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const EwraControlAssessmentSchema = new mongoose.Schema(
  {
    assessmentId: {
      type: mongoose.Schema.ObjectId,
      ref: "EwraAssessment",
      required: true,
      index: true,
    },
    controlId:    { type: String, required: true, trim: true }, // e.g. "CTRL_GOV_001"
    controlTitle: { type: String, trim: true },
    domain:       { type: String, trim: true },                  // e.g. "GOV"
    // responsible owner — inherited from the Controls Library on add, CO-editable
    controlOwner: { type: String, trim: true, default: "" },     // e.g. "AML/CTF CO"

    // ── Dual rating: Design + Performance (each 1-5) ──────────────────────
    designRating:      { type: Number, min: 1, max: 5, default: null },
    performanceRating: { type: Number, min: 1, max: 5, default: null },

    // Computed from (design + performance) / 2
    effectivenessScore: { type: Number, default: null },
    effectivenessLabel: {
      type: String,
      enum: ["Ineffective","Partially Effective","Effective","Highly Effective",""],
      default: "",
    },

    evidenceNotes:  { type: String, default: "" },
    gaps:           { type: String, default: "" },
    actionRequired: { type: String, default: "" },

    status: {
      type: String,
      enum: ["Not Started","In Progress","Complete"],
      default: "Not Started",
    },

    client: { type: mongoose.Schema.ObjectId, ref: "Client", default: null },
  },
  { timestamps: true }
);

// Prevent duplicate control per assessment
EwraControlAssessmentSchema.index(
  { assessmentId: 1, controlId: 1 },
  { unique: true }
);
EwraControlAssessmentSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("EwraControlAssessment", EwraControlAssessmentSchema);
