const mongoose = require("mongoose");

const DesignatedServiceSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    // CUSTODY | VASP_EXCHANGE | VASP_TRANSFER | REMITTANCE | INSURANCE | REAL_ESTATE | ...
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    applicableDate: { type: Date },                               // Tranche 2 commencement date
    applicableEntityTypes: [{ type: String, trim: true }],        // which entity type names apply
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DesignatedService", DesignatedServiceSchema);
