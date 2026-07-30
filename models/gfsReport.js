// models/GFS.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const { Schema } = mongoose;

/* Small sub-schemas */
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
  },
  { _id: false }
);

const OFISchema = new Schema(
  {
    id: { type: String },
    name: { type: String },
    reportDate: { type: Date },
    scamType: { type: String },
  },
  { _id: false }
);

const POISchema = new Schema(
  {
    id: { type: String },
    name: { type: String },
    bank: { type: String },
    account: { type: String },
    reference: { type: String },
  },
  { _id: false }
);

const IPSchema = new Schema(
  {
    id: { type: String },
    address: { type: String },
    country: { type: String },
    date: { type: Date },
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

    // source / purpose
    sourceOfFunds: { type: String, default: "" },
    accountOpeningPurpose: { type: String, default: "" },

    // review period & totals
    reviewStartDate: { type: Date },
    reviewEndDate: { type: Date },
    totalDeposited: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    totalSuspicionAmount: { type: Number, default: 0 },

    // collections
    transactions: { type: [TransactionSchema], default: [] },
    ofis: { type: [OFISchema], default: [] }, // other financial institutions / reports
    pois: { type: [POISchema], default: [] }, // persons of interest
    cryptoAddresses: { type: [String], default: [] },
    ipAddresses: { type: [IPSchema], default: [] },

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
