// models/SMR.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const { Schema } = mongoose;

// reuse small schemas from your JSON Schema
const AddressSchema = new Schema(
  {
    street: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    postcode: { type: String, default: "" },
    country: { type: String, default: "" },
  },
  { _id: false }
);

const MoneySchema = new Schema(
  {
    currencyCode: { type: String },
    amount: { type: Number, min: 0 },
  },
  { _id: false }
);

const PartyDetailsSchema = new Schema(
  {
    name: String,
    institutions: [
      {
        // array of Institution
        name: String,
        address: { type: AddressSchema, default: {} },
      },
    ],
  },
  { _id: false }
);
const DigitalCurrencySchema = new Schema(
  {
    type: String,
    amount: Number,
    walletAddress: String,
  },
  { _id: false }
);
const TransactionSchema = new Schema(
  {
    date: Date,
    type: String,
    completed: Boolean,
    referenceNumber: String,
    totalAmount: MoneySchema,
    cashAmount: MoneySchema,
    foreignCurrencies: [{ currencyCode: String, amount: Number }],
    digitalCurrencies: [DigitalCurrencySchema],
    sender: PartyDetailsSchema,
    payee: PartyDetailsSchema,
    beneficiary: PartyDetailsSchema,
  },
  { _id: false }
);

const IdentityDocumentSchema = new Schema(
  {
    type: String,
    number: String,
    country: String,
    expiry: Date,
  },
  { _id: false }
);

const IdentityVerificationSchema = new Schema(
  {
    documents: [IdentityDocumentSchema],
    electronicSources: [{ type: { type: String }, identifier: String }],
    deviceIdentifiers: [{ type: { type: String }, identifier: String }],
  },
  { _id: false }
);

const PersonOrganisationSchema = new Schema(
  {
    name: { type: String },
    otherNames: [String],
    personDetails: {
      dateOfBirth: Date,
      nationality: String,
    },
    businessAddress: AddressSchema,
    phoneNumbers: [String],
    emails: [String],

    accounts: [{ type: Schema.Types.Mixed }], // keep flexible
    digitalWallets: [{ type: Schema.Types.Mixed }],
    occupation: String,

    beneficialOwners: [{ name: String, address: AddressSchema }],
    officeHolders: [{ name: String, position: String }],
    documentation: String,
    identityVerification: IdentityVerificationSchema,
    isCustomer: Boolean,
    isAuthorisedAgent: Boolean,
  },
  { _id: false }
);

const UnidentifiedPersonSchema = new Schema(
  {
    description: String,
    documentation: String,
  },
  { _id: false }
);

const PreviousReportSchema = new Schema(
  {
    date: Date,
    referenceNumber: String,
  },
  { _id: false }
);

const GovernmentBodySchema = new Schema(
  {
    name: String,
    address: AddressSchema,
    dateReported: Date,
    informationProvided: String,
  },
  { _id: false }
);

const CompletedBySchema = new Schema(
  {
    name: String,
    jobTitle: String,
    phone: String,
    email: String,
  },
  { _id: false }
);

const ReportingEntitySchema = new Schema(
  {
    name: String,
    address: AddressSchema,
    branchName: String,
    internalReference: String,
    completedBy: CompletedBySchema,
  },
  { _id: false }
);

const WorkflowEventSchema = new Schema(
  {
    timestamp: { type: Date, default: Date.now },
    user: String,
    action: String,
    fromStatus: String,
    toStatus: String,
    notes: String,
  },
  { _id: false }
);

const SMRSpec = new Schema(
  {
    uid: { type: String, index: true }, // eg SMR_...
    sequence: { type: Number, index: true },

    caseId: {
      type: Schema.Types.ObjectId,
      ref: "Alert",
      required: false,
      default: null,
    },
    caseNumber: { type: String, index: true, default: null }, // external reference

    status: {
      type: String,
      enum: ["draft", "review", "approved"],
      default: "draft",
    },

    // PART A
    partA: {
      designatedServices: [String],
      serviceStatus: {
        type: String,
        enum: ["provided", "requested", "enquired"],
      },
      suspicionReasons: [String],
      otherReasons: [String],
    },

    // PART B
    partB: {
      groundsForSuspicion: String,
    },

    // PART C
    partC: {
      personOrganisation: { type: PersonOrganisationSchema, default: {} },
    },

    // PART D
    partD: {
      hasOtherParties: Boolean,
      otherParties: [PersonOrganisationSchema],
    },

    // PART E
    partE: {
      hasUnidentifiedPersons: Boolean,
      unidentifiedPersons: [UnidentifiedPersonSchema],
    },

    // PART F
    partF: {
      transactions: [TransactionSchema],
    },

    // PART G
    partG: {
      likelyOffence: [String],
      previousReports: [PreviousReportSchema],
      otherGovernmentBodies: [GovernmentBodySchema],
      attachments: [String], // store file keys/URLs
    },

    // PART H
    partH: {
      reportingEntity: ReportingEntitySchema,
    },

    // metadata + audit
    metadata: {
      version: String,
      createdBy: String,
      updatedBy: String,
      workflowHistory: [WorkflowEventSchema],
      submissionDate: Date,
      austracReference: String,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// pre-save uid
SMRSpec.pre("save", function (next) {
  if (this.isNew && !this.uid) this.uid = `SMR_${Date.now()}`;
  next();
});

SMRSpec.plugin(uniqueValidator, { message: "{PATH} must be unique." });
SMRSpec.plugin(mongoosePaginate);
SMRSpec.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "smr_sequence",
  start_seq: 1,
});

const SMR = mongoose.model("SMR", SMRSpec);
module.exports = SMR;
