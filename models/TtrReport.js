// models/ThresholdTransactionReport.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const { Schema } = mongoose;

/* Sub-schemas */
const AddressSchema = new Schema(
  {
    fullStreetAddress: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    postcode: { type: String, required: true },
    country: { type: String, default: "Australia", required: true },
  },
  { _id: false }
);

const AccountSchema = new Schema(
  {
    type: { type: String },
    number: { type: String },
    currencyCode: { type: String, default: "AUD" },
    institution: { type: String },
  },
  { _id: false }
);

const DigitalWalletSchema = new Schema(
  {
    type: { type: String },
    identifier: { type: String },
    provider: { type: String },
  },
  { _id: false }
);

const IdentityVerificationSchema = new Schema(
  {
    documentation: { type: [String], default: [] },
    electronicDataSource: { type: [String], default: [] },
    deviceIdentifiers: { type: [String], default: [] },
  },
  { _id: false }
);

const CustomerSchema = new Schema(
  {
    fullName: { type: String, required: true },
    otherNames: { type: [String], default: [] },
    dateOfBirth: { type: Date },
    businessAddress: { type: AddressSchema, required: true },
    phoneNumbers: { type: [String], required: true },
    emailAddresses: { type: [String], required: true },
    occupation: { type: String },
    businessStructure: {
      type: String,
      enum: ["individual", "company", "partnership", "trust", "other"],
    },
    abn: { type: String },
    acn: { type: String },
    arbn: { type: String },
    accounts: { type: [AccountSchema], default: [] },
    digitalCurrencyWallets: { type: [DigitalWalletSchema], default: [] },
    identityVerification: { type: IdentityVerificationSchema, default: {} },
  },
  { _id: false }
);

const IndividualConductingSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["customer", "employee", "other"],
      required: true,
    },
    customerIndex: { type: Number, min: 0 },
    details: {
      fullName: { type: String },
      dateOfBirth: { type: Date },
      occupation: { type: String },
      relationshipToCustomer: { type: String },
    },
  },
  { _id: false }
);

const MoneySchema = new Schema(
  {
    currencyCode: { type: String, default: "AUD" },
    amount: { type: Number, min: 0.1, required: true },
  },
  { _id: false }
);

const ForeignCurrencySchema = new Schema(
  {
    currencyCode: { type: String, required: true },
    amount: { type: Number, min: 0, required: true },
    exchangeRate: { type: Number, min: 0 },
    audEquivalent: { type: Number, min: 0 },
  },
  { _id: false }
);

const DigitalCurrencySchema = new Schema(
  {
    type: { type: String },
    amount: { type: Number, min: 0 },
    walletAddress: { type: String },
    audEquivalent: { type: Number, min: 0 },
  },
  { _id: false }
);

const TransactionComponentsSchema = new Schema(
  {
    australianDollars: { type: MoneySchema },
    foreignCurrency: { type: [ForeignCurrencySchema], default: [] },
    digitalCurrency: { type: [DigitalCurrencySchema], default: [] },
    otherComponents: { type: [String], default: [] },
  },
  { _id: false }
);

const TransactionSchema = new Schema(
  {
    date: { type: Date, required: true },
    referenceNumber: { type: String, required: true },
    totalAmount: { type: MoneySchema, required: true },
    designatedService: {
      type: String,
      enum: [
        "currency-exchange",
        "funds-transfer",
        "cash-deposit",
        "cash-withdrawal",
        "bullion-purchase",
        "bullion-sale",
      ],
      required: true,
    },
    moneyReceived: { type: TransactionComponentsSchema },
    moneyProvided: { type: TransactionComponentsSchema },
  },
  { _id: false }
);

const RecipientSchema = new Schema(
  {
    isCustomer: { type: Boolean, required: true },
    fullName: { type: String },
    occupation: { type: String },
    phoneNumbers: { type: [String], default: [] },
    emailAddresses: { type: [String], default: [] },
    accounts: { type: [AccountSchema], default: [] },
    customerReference: { type: String },
  },
  { _id: false }
);

const PersonCompletingSchema = new Schema(
  {
    name: { type: String, required: true },
    jobTitle: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, required: true },
    date: { type: Date, required: true },
  },
  { _id: false }
);

const BranchSchema = new Schema(
  {
    identificationNumber: { type: String, required: true },
    name: { type: String, required: true },
    address: { type: AddressSchema, required: true },
  },
  { _id: false }
);

const ReportingEntitySchema = new Schema(
  {
    identificationNumber: { type: String, required: true },
    name: { type: String, required: true },
    branch: { type: BranchSchema, required: true },
    personCompleting: { type: PersonCompletingSchema, required: true },
  },
  { _id: false }
);

const PartASchema = new Schema(
  {
    customers: { type: CustomerSchema, required: true, minItems: 1 },
    transactionConductMethod: {
      type: String,
      //  enum: ["individual", "armoured-car", "atm", "night-deposit", "other"],
      required: true,
    },
    transactionConductDescription: { type: String, default: "" },
  },
  { _id: false }
);

const PartCSchema = new Schema(
  {
    transaction: { type: TransactionSchema, required: true },
    recipients: { type: [RecipientSchema], required: true },
  },
  { _id: false }
);

const MetadataSchema = new Schema(
  {
    version: { type: String, default: "1.0" },
    createdBy: { type: String },
    updatedBy: { type: String },
    submissionDate: { type: Date },
    austracReference: { type: String },
    fileAttachments: { type: [String], default: [] },
  },
  { _id: false }
);

/* Main schema */
const TTRSchema = new Schema(
  {
    uid: { type: String, index: true, unique: true },
    referenceNumber: { type: String, required: true, default: null }, // case id
    status: {
      type: String,
      enum: ["draft", "submitted", "approved"],
      default: "draft",
    },
    completionDate: { type: Date, required: true },

    partA: { type: [PartASchema], required: true, default: [] },
    partB: { type: IndividualConductingSchema, required: true },
    partC: { type: PartCSchema, required: true },
    partD: { type: ReportingEntitySchema, required: true },

    metadata: { type: MetadataSchema, required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* Auto-generate uid */
TTRSchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `TTR_${Date.now()}`;
  }
  next();
});

TTRSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
TTRSchema.plugin(mongoosePaginate);
TTRSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "ttr_sequence",
  start_seq: 1,
});

module.exports = mongoose.model("TTR", TTRSchema);
