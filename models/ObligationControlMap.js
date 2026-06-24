const mongoose = require("mongoose");

// Junction: maps obligations ↔ controls (many-to-many)
const ObligationControlMapSchema = new mongoose.Schema(
  {
    obligationId: { type: String, required: true, trim: true, index: true },
    // ref ObligationLibrary.obligationId

    controlId: { type: String, required: true, trim: true, index: true },
    // ref Control.controlId (Phase 2 model)

    mappingNotes: { type: String, trim: true },
    linkType: {
      type: String,
      enum: ["Primary","Supporting","Compensating",""],
      default: "",
    },
  },
  { timestamps: true }
);

ObligationControlMapSchema.index({ obligationId: 1, controlId: 1 }, { unique: true });

module.exports = mongoose.model("ObligationControlMap", ObligationControlMapSchema);
