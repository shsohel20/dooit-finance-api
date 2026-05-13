const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

// Instantiated obligation for a specific entity profile
const EntityObligationSchema = new mongoose.Schema(
  {
    entityProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EntityProfile",
      required: true,
      index: true,
    },
    obligationId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // ref ObligationLibrary.obligationId — stored as string for fast lookup

    // Obligation details snapshot (denormalised for display without extra join)
    obligationCategory: { type: String, trim: true },
    obligationDescription: { type: String, trim: true },

    status: {
      type: String,
      enum: ["Active", "Pending", "Exempt", "Not Applicable"],
      default: "Active",
    },

    controlOwner: { type: String, trim: true },
    oversightOwner: { type: String, trim: true },

    monitoringFrequency: {
      type: String,
      enum: ["Daily", "Weekly", "Monthly", "Quarterly", "Annually", "As Required", ""],
      default: "",
    },

    lastTestedDate: { type: Date },
    nextReviewDate: { type: Date },

    testResult: {
      type: String,
      enum: ["Pass", "Fail", "Partial", "Not Tested", ""],
      default: "",
    },

    remediationStatus: {
      type: String,
      enum: ["Open", "In Progress", "Closed", ""],
      default: "",
    },

    riskRating: {
      type: String,
      enum: ["Low", "Medium", "High", "Critical", ""],
      default: "",
    },

    notes: { type: String, trim: true },

    // Multi-tenancy
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
  },
  { timestamps: true }
);

EntityObligationSchema.index({ entityProfileId: 1, obligationId: 1 }, { unique: true });
EntityObligationSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("EntityObligation", EntityObligationSchema);
