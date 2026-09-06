// models/GFS.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const { riskFields } = require("./schemas/riskShared");
const { draftFields } = require("./schemas/reportShared");

const { Schema } = mongoose;

/* Small sub-schemas.
 *
 * The original hand-entry fields are kept as they were so existing records
 * still read; the additions (docs/74 §7.3) are what services/caseAnalysis can
 * fill automatically — real amounts, currencies, countries and risk flags
 * rather than a name and a number. */

const TransactionSchema = new Schema(
  {
    id: { type: String }, // optional client-side id
    date: { type: Date },
    amount: { type: Number, default: 0 },
    type: { type: String },
    fromBank: { type: String },
    fromAccount: { type: String },
    fromName: { type: String },
    toAccount: { type: String },
    reference: { type: String },
    cryptoAddress: { type: String },

    // ── from the case analysis ──
    transaction: { type: Schema.Types.ObjectId, ref: "Transaction" },
    uid: { type: String },
    subtype: { type: String },
    currency: { type: String },
    amountAUD: { type: Number, default: null }, // null when no conversion exists
    status: { type: String },
    channel: { type: String },
    direction: { type: String }, // in | out | internal | third_party
    counterparty: { type: String },
    counterpartyCountry: { type: String },
    purpose: { type: String },
    riskFlags: { type: [String], default: [] },
    relatedParty: { type: Boolean, default: false },
  },
  { _id: false }
);

// Other financial institutions seen on the counterparty side.
const OFISchema = new Schema(
  {
    id: { type: String },
    name: { type: String },
    reportDate: { type: Date },
    scamType: { type: String },

    country: { type: String },
    bic: { type: String },
    transactionCount: { type: Number, default: 0 },
  },
  { _id: false }
);

// Persons of interest: counterparties, and our own customers linked to the case.
const POISchema = new Schema(
  {
    id: { type: String },
    name: { type: String },
    bank: { type: String },
    account: { type: String },
    reference: { type: String },

    customer: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    relationship: { type: String }, // Subject | Linked customer | Counterparty
    country: { type: String },
    institution: { type: String },
    transactionCount: { type: Number, default: 0 },
    totalAmountAUD: { type: Number, default: 0 },
  },
  { _id: false }
);

const IPSchema = new Schema(
  {
    id: { type: String },
    address: { type: String },
    country: { type: String },
    date: { type: Date },

    count: { type: Number, default: 0 },
  },
  { _id: false }
);

// Crypto legs. Was `[String]` — see seeds/migrate-gfs-crypto-addresses.js.
const CryptoAddressSchema = new Schema(
  {
    address: { type: String },
    txHash: { type: String },
    network: { type: String },
    cluster: { type: String },
    hops: { type: Number, default: null },
    chainalysisScore: { type: Number, default: null },
    direction: { type: String },
    amount: { type: Number, default: null },
    currency: { type: String },
    amountAUD: { type: Number, default: null },
  },
  { _id: false }
);

/* Main schema */
const GFSSchema = new Schema(
  {
    uid: { type: String, index: true },
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
      default: null,
    },

    // ── Canonical linkage (Case = hub, Alert = provenance) ──
    case: { type: Schema.Types.ObjectId, ref: "Case", index: true, default: null },
    alert: { type: Schema.Types.ObjectId, ref: "Alert", index: true, default: null },

    // suspicion meta
    suspicionType: { type: String, default: "" },
    suspicionReason: { type: String, default: "" },
    suspicionDates: { type: String, default: "" },
    suspicionIntensity: { type: String, default: "" },
    suspicionBehaviour: { type: String, default: "" },

    // customer / account
    customerName: { type: String, default: "" },
    customerUID: { type: String, index: true },
    companyName: { type: String, default: "" },
    customerAge: { type: Number, default: 0 },
    accountOpeningDate: { type: Date },

    // customer profile facts (from Customer / KYC)
    customerType: { type: String, default: "" },
    onboardingChannel: { type: String, default: "" },
    occupation: { type: String, default: "" },
    kycStatus: { type: String, default: "" },
    amlRiskLabels: { type: [String], default: [] },
    pepFlag: { type: Boolean, default: false },
    sanctionsFlag: { type: Boolean, default: false },
    adverseMediaFlag: { type: Boolean, default: false },
    expectedTradingVolume: { type: String, default: "" },
    residentialAddress: { type: String, default: "" },

    // source / purpose
    sourceOfFunds: { type: String, default: "" },
    sourceOfWealth: { type: String, default: "" },
    accountOpeningPurpose: { type: String, default: "" },

    // review period & totals
    reviewStartDate: { type: Date },
    reviewEndDate: { type: Date },
    totalDeposited: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    totalSuspicionAmount: { type: Number, default: 0 },

    // derived activity shape (services/caseAnalysis)
    netFlowAUD: { type: Number, default: 0 },
    passThroughRatio: { type: Number, default: null }, // null when there is no inflow
    peakDailyVolumeAUD: { type: Number, default: 0 },
    activeDays: { type: Number, default: 0 },
    transactionCount: { type: Number, default: 0 },
    structuringCandidates: { type: Number, default: 0 },
    unconvertedCount: { type: Number, default: 0 }, // legs with no AUD conversion
    jurisdictionsInvolved: { type: [String], default: [] },
    riskFlags: { type: [String], default: [] },

    // collections
    transactions: { type: [TransactionSchema], default: [] },
    ofis: { type: [OFISchema], default: [] }, // other financial institutions / reports
    pois: { type: [POISchema], default: [] }, // persons of interest
    // The plain address list a filing prints. Deliberately still [String]:
    // retyping it to an object array makes Mongoose cast every stored address
    // into an object keyed by character index on read — silently destroying it
    // in any environment where a migration had not run. The forensic detail
    // lives alongside it in `cryptoLegs`.
    cryptoAddresses: { type: [String], default: [] },
    cryptoLegs: { type: [CryptoAddressSchema], default: [] },
    ipAddresses: { type: [IPSchema], default: [] },

    // links to other filings
    linkedToSMR: { type: Boolean, default: false },

    // ── Narrative (AI-written; docs/74 §4.3) ──
    suspicionSummary: { type: String, default: "" },
    behavioralChange: { type: Boolean, default: false }, // derived, not AI
    behavioralChangeDescription: { type: String, default: "" },

    // ── Risk, as our Case derived it ──
    ...riskFields({ nullable: true }),

    // ── Draft provenance ──
    ...draftFields(),

    // misc
    customerCountry: { type: String, default: "Australia" },
    additionalNotes: { type: String, default: "" },

    // attachments (store S3/Cloudinary keys or local paths)
    attachments: { type: [String], default: [] },

    // generated report (server-side cached text)
    generatedReport: { type: String, default: "" },

    // status/audit
    status: {
      type: String,
      enum: ["draft", "review", "submitted", "closed"],
      default: "draft",
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* pre-save uid */
// Tenant-scoped list queries
GFSSchema.index({ client: 1, status: 1, createdAt: -1 });

GFSSchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `GFS_${Date.now()}`;
  }
  next();
});

GFSSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
GFSSchema.plugin(mongoosePaginate);
GFSSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "gfs_sequence",
  start_seq: 1,
});

const GFS = mongoose.model("GFS", GFSSchema);
module.exports = GFS;
