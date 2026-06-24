const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const RegulatoryGuideSchema = new mongoose.Schema(
  {
    guideId: {
      type: String,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
      // Auto-generated: RG-001, RG-002 …
    },

    title: { type: String, required: true, trim: true },
    // e.g. "AML/CTF Rules 2024 — Reporting Entity Obligations"

    guideCode: { type: String, trim: true, index: true },
    // e.g. "RG104", "AML/CTF-RULES", "FATF-R10"

    regulator: {
      type: String,
      enum: ["AUSTRAC", "ASIC", "APRA", "FATF", "ISO", "Treasury", "Other"],
      default: "AUSTRAC",
    },

    version: { type: String, trim: true },
    // e.g. "2024-01", "3rd Edition"

    effectiveDate: { type: Date },
    reviewDate: { type: Date },

    status: {
      type: String,
      enum: ["Active", "Draft", "Superseded"],
      default: "Active",
    },

    description: { type: String, trim: true },

    // Obligations from the library that belong to this guide
    obligationIds: [{ type: String, trim: true }],
    // Array of ObligationLibrary.obligationId strings e.g. ["AML-001", "CDD-001"]

    // Which entity types this guide applies to (for filtering)
    applicableEntityTypes: [{ type: String, trim: true }],
    // e.g. ["All", "Tranche 1 - Banks & ADIs", "Tranche 1 - VASP/DCEP"]

    // Link to the actual regulatory document
    documentUrl: { type: String, trim: true },

    // Notes / summary for compliance officers
    notes: { type: String, trim: true },

    // Multi-tenancy
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
  },
  { timestamps: true }
);

// Auto-generate guideId before first save
RegulatoryGuideSchema.pre("save", async function (next) {
  if (!this.isNew || this.guideId) return next();
  const count = await this.constructor.countDocuments();
  this.guideId = `RG-${String(count + 1).padStart(4, "0")}`;
  next();
});

RegulatoryGuideSchema.index({ regulator: 1, status: 1 });
RegulatoryGuideSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("RegulatoryGuide", RegulatoryGuideSchema);
