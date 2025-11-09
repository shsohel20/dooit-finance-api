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
    uid: String,
    user: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
      index: true,
    },
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
        onboardingChannel: { type: String, default: "" }, //Mobile App, Website, In-Branch, Agent.

        registeredAt: { type: Date, default: Date.now },
        source: { type: String, default: "" }, // e.g. "in-branch", "web", "api", "agent"
        notes: { type: String, default: "" },
        active: { type: Boolean, default: true },
      },
    ],

    // invited flow fields
    invitedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    inviteToken: String, // hashed token
    inviteTokenExpire: Date,
    inviteTokenPlain: { type: String, select: false }, // optional: to return (or keep server-side only)

    // forms
    personalKyc: { type: PersonalKycSchema, default: {} },
    referrer: { type: {}, default: {} },

    // uploaded documents
    documents: { type: [DocumentMetaSchema], default: [] },

    country: { type: String, default: "Bangladesh" },
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
    isActive: { type: Boolean, default: false },

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
 * Generate and assign an invite token.
 */
CustomerSchema.methods.generateInviteToken = function (
  expiresInMinutes = 60 * 24 * 7
) {
  const plain = crypto.randomBytes(20).toString("hex");
  const hashed = crypto.createHash("sha256").update(plain).digest("hex");

  this.inviteToken = hashed;
  this.inviteTokenExpire = Date.now() + expiresInMinutes * 60 * 1000;

  // Optional: store plain for debugging or testing only
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
  (this.metadata.client = undefined), (this.metadata.branch = undefined);
};

CustomerSchema.virtual("isInviteActive").get(function () {
  return !!(
    this.inviteToken &&
    this.inviteTokenExpire &&
    this.inviteTokenExpire > Date.now()
  );
});

module.exports = mongoose.model("Customer", CustomerSchema);
