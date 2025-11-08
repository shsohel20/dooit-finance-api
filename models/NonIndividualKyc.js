const mongoose = require("mongoose");
const { Schema } = mongoose;
// Common Address Schema (reusable)
const AddressSchema = new Schema(
  {
    street: String,
    suburb: String,
    state: String,
    postcode: String,
    country: String,
  },
  { _id: false }
);

// Common Contact Schema
const ContactSchema = new Schema(
  {
    email: String,
    phone: String,
    website: String,
  },
  { _id: false }
);

// Common ASIC Registration Schema
const AsicRegistrationSchema = new Schema(
  {
    is_registered: { type: Boolean, default: false },
    registration_body: String,
    registration_number: String,
  },
  { _id: false }
);

// Common Account Purpose Schema
const AccountPurposeSchema = new Schema(
  {
    digital_currency_exchange: { type: Boolean, default: false },
    peer_to_peer: { type: Boolean, default: false },
    fx: { type: Boolean, default: false },
    other: { type: Boolean, default: false },
  },
  { _id: false }
);
const GeneralInformationSchema = new Schema(
  {
    entity_name: String,
    country_of_formation: String,
    registered_business_name: String,
    industry: String,
    nature_of_Business: String,
    annual_income: String,
    asic_registration: { type: AsicRegistrationSchema, default: {} },
    contact_information: { type: ContactSchema, default: {} },
    registered_address: { type: AddressSchema, default: {} },
    business_address: {
      different_from_registered: { type: Boolean, default: false },
      street: String,
      suburb: String,
      state: String,
      postcode: String,
      country: String,
    },
    account_purpose: { type: AccountPurposeSchema, default: {} },
    estimated_trading_volume: String,
  },
  { _id: false }
);

// Partnership Schema
const PartnershipSchema = new Schema(
  {
    partnership_type: String,
    is_regulated: { type: Boolean, default: false },
    regulator_name: String,
    membership_number: String,
    nature_of_business_activities: String,
    company_partners: [
      {
        legal_entity_name: String,
        registration_number: String,
      },
    ],
    individual_partners: [
      {
        is_managing_partner: { type: Boolean, default: false },
        given_name: String,
        surname: String,
        date_of_birth: Date,
        residential_address: { type: AddressSchema, default: {} },
      },
    ],
  },
  { _id: false }
);
// Government Body Schema
const GovernmentBodySchema = new Schema(
  {
    government_body_type: String,
    government_name: String,
    legislation_name: String,
  },
  { _id: false }
);

// Association/Cooperative Schema
const AssociationCooperativeSchema = new Schema(
  {
    entity_type: String,
    officeholders: {
      president_chair: {
        given_name: String,
        surname: String,
        date_of_birth: Date,
        residential_address: { type: AddressSchema, default: {} },
      },
      secretary: {
        full_name: String,
        date_of_birth: Date,
        residential_address: { type: AddressSchema, default: {} },
      },
      treasurer: {
        full_name: String,
        date_of_birth: Date,
        residential_address: { type: AddressSchema, default: {} },
      },
      public_officer: {
        full_name: String,
        date_of_birth: Date,
        residential_address: { type: AddressSchema, default: {} },
      },
    },
    beneficial_owners: [
      {
        given_name: String,
        surname: String,
        date_of_birth: Date,
      },
    ],
  },
  { _id: false }
);
const NonIndividualKycSchema = new Schema(
  {
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: false, // allow null if branch-less relation
      index: true,
    },
    customer: {
      type: mongoose.Schema.ObjectId,
      ref: "Customer",
      required: false,
      index: true,
    },
    general_information: { type: GeneralInformationSchema, default: {} },
    partnership: { type: PartnershipSchema, default: {} },
    government_body: { type: GovernmentBodySchema, default: {} },
    association_cooperative: {
      type: AssociationCooperativeSchema,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* -------------------------
   Indexes & Virtuals
   ------------------------- */
// NonIndividualKycSchema.index({ customer: 1 });
NonIndividualKycSchema.index(
  { "general_information.registered_business_name": 1 },
  { sparse: true }
);

NonIndividualKycSchema.virtual("displayName").get(function () {
  return (
    (this.general_information && this.general_information.entity_name) ||
    (this.general_information &&
      this.general_information.registered_business_name) ||
    null
  );
});

/* -------------------------
   Pre-save & helpers
   ------------------------- */
NonIndividualKycSchema.pre("save", function (next) {
  if (!this.general_information) this.general_information = {};
  if (!this.general_information.contact_information)
    this.general_information.contact_information = {};
  next();
});

module.exports = mongoose.model("NonIndividualKyc", NonIndividualKycSchema);
