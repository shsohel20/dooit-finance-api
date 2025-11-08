// models/Customer.js
"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");

const { Schema } = mongoose;

const PersonalFormSchema = new Schema(
  {
    customer_details: {
      given_name: String,
      middle_name: String,
      surname: String,
      date_of_birth: Date,
      other_names: String,
      referral: String,
    },
    contact_details: {
      email: String,
      phone: String,
    },
    employment_details: {
      occupation: String,
      industry: String,
      employer_name: String,
    },
    residential_address: {
      address: String,
      suburb: String,
      state: String,
      postcode: String,
      country: String,
    },
    mailing_address: {
      address: String,
      suburb: String,
      state: String,
      postcode: String,
      country: String,
    },
  },
  { _id: false }
);

const Authorization = new Schema(
  {
    company_name: String,
    agent_name: String,
    title_relationship: String,
    agent_signature: String,
    agent_date: Date,
    documents_attested: { type: Boolean, default: false },
  },
  { _id: false }
);

const PersonalKycSchema = new Schema(
  {
    personal_form: { type: PersonalFormSchema, default: {} },
    // identification: { type: PersonalIdentificationSchema, default: {} },
    funds_wealth: {
      source_of_funds: String,
      source_of_wealth: String,
      account_purpose: String,
      estimated_trading_volume: String,
    },
    sole_trader: {
      is_sole_trader: { type: Boolean, default: false },
      business_details: {
        business_name: String,
        abn: String, // Australian Business Number
        business_address: {
          address: String,
          suburb: String,
          state: String,
          postcode: String,
          country: String,
        },
      },
    },
  },
  { _id: false }
);

//Company Docs
const CompanyKycSchema = new Schema(
  {
    general_information: {
      legal_name: String,
      trading_names: String,
      phone_number: String,
      registration_number: String, //acn ,arbn
      country_of_incorporation: String,
      contact_email: String,
      industry: String,
      nature_of_business: String,
      annual_income: String,
      local_agent: {
        name: String,
        address: {
          street: String,
          suburb: String,
          state: String,
          postcode: String,
          country: String,
        },
      },
      registered_address: {
        street: String,
        suburb: String,
        state: String,
        postcode: String,
        country: String,
      },
      business_address: {
        different_from_registered: { type: Boolean, default: false },
        street: String,
        suburb: String,
        state: String,
        postcode: String,
        country: String,
      },
      company_type: Schema.Types.Mixed,
      account_purpose: Schema.Types.Mixed,
      estimated_trading_volume: String,
    },
    directors_beneficial_owner: {
      number_of_directors: Number,
      directors: [{ given_name: String, surname: String }],
      beneficial_owners: [
        {
          full_name: String,
          date_of_birth: Date,
          residential_address: {
            street: String,
            suburb: String,
            state: String,
            postcode: String,
            country: String,
          },
        },
      ],
    },
  },
  { _id: false }
);

//Trust Docs
const TrustKycSchema = new Schema(
  {
    trust_details: {
      full_trust_name: String,
      country_of_establishment: String,
      settlor_name: String,
      industry: String,
      nature_of_business: String,
      annual_income: String,
      principal_address: {
        address: String,
        suburb: String,
        state: String,
        postcode: String,
        country: String,
      },
      postal_address: {
        different_from_principal: { type: Boolean, default: false },
        address: String,
        suburb: String,
        state: String,
        postcode: String,
        country: String,
      },
      contact_information: {
        email: String,
        phone: String,
        website: String,
      },
      trust_type: {
        selected_type: String,
        unregulated_trust: {
          type_description: String,
          is_registered: Boolean,
          regulatory_body: String,
          registration_number: String,
        },
        self_managed_super_fund: {
          abn: String,
        },
        managed_investment_scheme_registered: {
          asrn: String,
        },
        government_superannuation_fund: {
          legislation_name: String,
        },
        managed_investment_scheme_unregistered: {
          abn: String,
        },
        other_superannuation_trust: {
          regulator_name: String,
          registration_number: String,
        },
      },
      account_purpose: {
        digital_currency_exchange: Boolean,
        peer_to_peer: Boolean,
        fx: Boolean,
        other: Boolean,
      },
      estimated_trading_volume: String,
    },
    beneficiaries: [
      {
        named_beneficiaries: String,
        beneficiary_classes: String,
      },
    ],
    company_trustees: {
      has_company_trustees: Boolean,
      company_details: [
        {
          company_name: String,
          registration_number: String,
        },
      ],
    },
    individual_trustees: {
      trustees: [
        {
          full_name: String,
          date_of_birth: Date,
          residential_address: {
            street: String,
            suburb: String,
            state: String,
            postcode: String,
            country: String,
          },
        },
      ],
      has_additional_trustees: Boolean,
    },
  },
  { _id: false }
);

// ==================== NON-INDIVIDUAL SCHEMAS ====================

// General Information Schema (Common to all non-individual types)

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

// Main Non-Individual KYC Schema
const NonIndividualKycSchema = new Schema(
  {
    general_information: { type: GeneralInformationSchema, default: {} },
    partnership: { type: PartnershipSchema, default: {} },
    government_body: { type: GovernmentBodySchema, default: {} },
    association_cooperative: {
      type: AssociationCooperativeSchema,
      default: {},
    },
  },
  { _id: false }
);

const DocumentMetaSchema = new Schema(
  {
    name: String,
    url: String,
    mimeType: String,
    type: String,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CustomerSchema = new Schema(
  {
    relations: [
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
        registeredAt: { type: Date, default: Date.now },
        source: { type: String, default: "" }, // e.g. "in-branch", "web", "api", "agent"
        notes: { type: String, default: "" },
        active: { type: Boolean, default: true },
      },
    ],
    user: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
      index: true,
    },

    // invited flow fields
    invitedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    inviteToken: String, // hashed token
    inviteTokenExpire: Date,
    inviteTokenPlain: { type: String, select: false }, // optional: to return (or keep server-side only)

    // customer type and status
    type: {
      type: String,
      enum: [
        "individual",
        "company",
        "partnership",
        "government_body",
        "association",
        "cooperative",
        "trust",
      ],
      required: true,
    },
    country: { type: String, default: "" },
    onboardingChannel: { type: String, default: "" }, //Mobile App, Website, In-Branch, Agent.

    // forms
    personalKyc: { type: PersonalKycSchema, default: {} },
    //  companyKyc: { type: CompanyKycSchema, default: {} },
    /// trustKyc: { type: TrustKycSchema, default: {} }, // NEW: Add trustKyc
    nonIndividualKyc: { type: NonIndividualKycSchema, default: {} }, // NEW: For partnership, government_body, association, cooperative
    referrer: { type: {}, default: {} },

    // uploaded documents
    documents: { type: [DocumentMetaSchema], default: [] },

    // kyc status: pending, in_review, verified, rejected
    kycStatus: {
      type: String,
      enum: ["pending", "in_review", "verified", "rejected"],
      default: "pending",
    },
    kycNotes: { type: String, default: "" },
    kycHistory: [
      {
        status: String,
        note: String,
        changedBy: { type: Schema.Types.ObjectId, ref: "Users" },
        changedAt: { type: Date, default: Date.now },
      },
    ],

    // soft delete / archived
    consentToScreen: { type: Boolean, default: false }, //Agreement for ongoing screening.
    isDeleted: { type: Boolean, default: false },

    // generic metadata
    metadata: { type: Schema.Types.Mixed, default: {} },

    declaration: {
      declarations_accepted: { type: Boolean, default: false },
      signatory_name: String,
      signature: String,
      date: Date,
    },
    authorized: { type: Authorization, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/**
 * Helpers: set invite token (generate plain & store hashed)
 */
CustomerSchema.methods.generateInviteToken = function (
  expiresInMinutes = 60 * 24 * 7
) {
  // plain token to send by link
  const plain = crypto.randomBytes(20).toString("hex");
  const hashed = crypto.createHash("sha256").update(plain).digest("hex");
  this.inviteToken = hashed;
  this.inviteTokenExpire = Date.now() + expiresInMinutes * 60 * 1000;
  // store plain optionally (not recommended in production). We'll not save plain by default.
  this.inviteTokenPlain = plain;
  return plain;
};

CustomerSchema.index(
  { _id: 1, "relations.client": 1, "relations.branch": 1 },
  { unique: true, sparse: true, name: "customer_relation_unique" }
);

CustomerSchema.methods.clearInviteToken = function () {
  this.inviteToken = undefined;
  this.inviteTokenExpire = undefined;
  this.inviteTokenPlain = undefined;
};

CustomerSchema.virtual("isInviteActive").get(function () {
  return !!(
    this.inviteToken &&
    this.inviteTokenExpire &&
    this.inviteTokenExpire > Date.now()
  );
});

module.exports = mongoose.model("Customer", CustomerSchema);
