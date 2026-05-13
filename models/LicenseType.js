const mongoose = require("mongoose");

const LicenseTypeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    // AFSL | ADI | INSURER | AUSTRAC_VASP | AUSTRAC_REMIT | AFSL_RE | AFSL_LIMITED | NONE
    name: { type: String, required: true, trim: true },
    regulator: { type: String, trim: true },                      // ASIC | APRA | AUSTRAC
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LicenseType", LicenseTypeSchema);
