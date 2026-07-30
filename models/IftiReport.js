// models/IFTI.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const { Schema } = mongoose;

/* Sub-schemas */
const TransactionSchema = new Schema(
  {
    dateReceived: { type: Date },
    dateAvailable: { type: Date },
    currencyCode: { type: String },
    totalAmount: { type: Number, default: 0 },
    transferType: { type: String },
    propertyDescription: { type: String },
    referenceNumber: { type: String },
  },
  { _id: false }
);

const PersonSchema = new Schema(
  {
    fullName: { type: String },
    otherName: { type: String },
    dateOfBirth: { type: Date },
    address: { type: String },
    city: { type: String },
    state: { type: String },
    postcode: { type: String },
    country: { type: String },
    phone: { type: String },
    email: { type: String },
    occupation: { type: String },
    abnAcnArbn: { type: String },
    customerNumber: { type: String },
    accountNumber: { type: String },
    businessStructure: { type: String },
    businessName: { type: String }, // beneficiary specific
    institutionName: { type: String },
    institutionCity: { type: String },
    institutionCountry: { type: String },
  },
  { _id: false }
);

const IntermediarySchema = new Schema(
  {
    key: { type: String }, // e.g. acceptingInstruction, acceptingMoney...
    present: { type: Boolean, default: false },
    fullName: { type: String },
    address: { type: String },
    city: { type: String },
    state: { type: String },
    postcode: { type: String },
    country: { type: String },
  },
  { _id: false }
);

const CompletedBySchema = new Schema(
  {
    fullName: { type: String },
    jobTitle: { type: String },
    phone: { type: String },
    email: { type: String },
  },
  { _id: false }
);

const ReportCompletionSchema = new Schema(
  {
    transferReason: { type: String },
    completedBy: CompletedBySchema,
  },
  { _id: false }
);

/* Main schema */
const IFTISchema = new Schema(
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

    // ── Canonical linkage (Case = hub, Alert = provenance) ──
    customer: { type: Schema.Types.ObjectId, ref: "Customer", index: true, default: null },
    case: { type: Schema.Types.ObjectId, ref: "Case", index: true, default: null },
    alert: { type: Schema.Types.ObjectId, ref: "Alert", index: true, default: null },

    transaction: { type: TransactionSchema, default: {} },
    orderingCustomer: { type: PersonSchema, default: {} },
    beneficiaryCustomer: { type: PersonSchema, default: {} },

    intermediaries: { type: [IntermediarySchema], default: [] }, // array of intermediaries
    // we also accept an object map from client, controller will normalize

    reportCompletion: { type: ReportCompletionSchema, default: {} },

    attachments: { type: [String], default: [] },

    generatedReport: { type: String, default: "" },

    status: {
      type: String,
      enum: ["draft", "submitted", "review", "approved", "closed"],
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

/* Pre-save UID */
// Tenant-scoped list queries
IFTISchema.index({ client: 1, status: 1, createdAt: -1 });

IFTISchema.pre("save", function (next) {
  if (this.isNew && !this.uid) this.uid = `IFTI_${Date.now()}`;
  next();
});

IFTISchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
IFTISchema.plugin(mongoosePaginate);
IFTISchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "ifti_sequence",
  start_seq: 1,
});

module.exports = mongoose.model("IFTI", IFTISchema);
