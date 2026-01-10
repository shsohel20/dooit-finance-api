// models/EcddReport.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const { Schema } = mongoose;

const EcddReportSchema = new Schema(
  {
    // Auto-generated unique id for UI (e.g. #ECDD_001)
    uid: { type: String, index: true, unique: true, sparse: true },

    // Auto increment sequence number
    sequence: { type: Number, index: true },

    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      index: true,
      default: null,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      index: true,
      default: null,
    },

    // Core relations
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
      required: false,
    },
    analyst: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: false,
      default: null,
    },
    generatedBy: { type: Schema.Types.ObjectId, ref: "Users", required: false },
    transaction: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      required: false,
    },

    // Basic case fields (matches your form)
    analystName: { type: String, trim: true, default: "" },
    position: { type: String, trim: true, default: "" },
    date: { type: Date, default: null },

    caseNumber: { type: String, trim: true, index: true, default: null },
    caseId: {
      type: Schema.Types.ObjectId,
      ref: "Alert",
      required: false,
      default: null,
    }, //alertId

    // Customer profile fields
    userId: { type: String, trim: true, default: "" },
    fullName: { type: String, trim: true, default: "" },
    customerName: { type: String, trim: true, default: "" },
    abn: { type: String, trim: true, default: "" },
    onboardingDate: { type: Date, default: null },
    accountPurpose: { type: String, default: "Digital Currency Exchange" },
    expectedVolume: { type: Number, default: null }, // store numeric if possible
    annualIncome: { type: Number, default: null }, // millions or raw, be consistent
    beneficialOwner: { type: String, trim: true, default: "" },
    directors: { type: String, trim: true, default: "" },

    // Flags
    isPEP: { type: String, enum: ["Yes", "No"], default: "No" },
    isSanctioned: { type: String, enum: ["Yes", "No"], default: "No" },
    relatedParty: { type: String, trim: true, default: "N/A" },

    // Transaction analysis
    accountCreationDate: { type: Date, default: null },
    analysisEndDate: { type: Date, default: null },
    totalDepositsAUD: { type: Number, default: 0 },
    totalWithdrawalsUSDT: { type: Number, default: 0 },
    totalWithdrawalsETH: { type: Number, default: 0 },
    totalWithdrawalsBTC: { type: Number, default: 0 },
    depositDetails: { type: String, default: "" },
    withdrawalDetails: { type: String, default: "" },
    additionalInfo: { type: String, default: "" },

    // Behavioral
    ipLocations: { type: Number, default: null },
    registeredAddress: { type: String, default: "" },

    // Auto-generated summaries (can be overridden in UI)
    profileSummary: { type: String, default: "" },
    transactionAnalysis: { type: String, default: "" },
    behavioralAnalysis: { type: String, default: "" },
    recommendation: { type: String, default: "" },

    // operational
    status: {
      type: String,
      enum: ["Pending", "Active", "Inactive", "Blocked"],
      default: "Pending",
    },

    // flexible fields
    settings: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/** Remove or correct invalid index */
// EcddReportSchema.index({ user: 1 }); // removed — no `user` field

// Post-save UID generation — generate padded uid like #CA_001
// EcddReportSchema.post("save", async function (doc, next) {
//   try {
//     if (!doc.uid && doc.sequence) {
//       const padded = String(doc.sequence).padStart(3, "0");
//       const newUid = `ECDD_${padded}`;
//       // Use updateOne to avoid triggering middleware recursively
//       await doc.constructor.updateOne(
//         { _id: doc._id },
//         { $set: { uid: newUid } }
//       );
//     }
//   } catch (err) {
//     // log and continue
//     /* eslint-disable no-console */
//     console.error("EcddReport post-save UID generation error:", err);
//   } finally {
//     next();
//   }
// });

EcddReportSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `ECDD_${Date.now()}`;
  }
  next();
});

// Plugins
// Keep uniqueValidator if you plan to have unique fields (uid, caseNumber, etc.)
EcddReportSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
EcddReportSchema.plugin(mongoosePaginate);

EcddReportSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "ecdd_report_sequence", // unique id for this schema
  start_seq: 1,
});

const EcddReport = mongoose.model("EcddReport", EcddReportSchema);

module.exports = EcddReport;
