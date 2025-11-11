const mongoose = require("mongoose");
const { Schema } = mongoose;
const AutoIncrement = require("mongoose-sequence")(mongoose);


const DocumentMetaSchema = new Schema(
  {
    name: String,
    url: String,
    mimeType: String,
    type: String,
    docType:String,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const TrustKycSchema = new Schema(
  {
    uid: String,
    sequence: { type: Number, index: true }, // auto incremented

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
    documents: { type: [DocumentMetaSchema], default: [] },

  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/**
 * Indexes
 * - reasonable indexes for quick lookups by registration_number and customer
 */
// TrustKycSchema.index({ customer: 1 });
TrustKycSchema.index(
  { "trust_details.trust_type.unregulated_trust.registration_number": 1 },
  { sparse: true }
);
TrustKycSchema.index(
  { "trust_details.trust_type.self_managed_super_fund.abn": 1 },
  { sparse: true }
);

/* Virtuals */
TrustKycSchema.virtual("trustName").get(function () {
  return this.trust_details && this.trust_details.full_trust_name
    ? this.trust_details.full_trust_name
    : null;
});

/* Pre-save cleanup: ensure nested defaults exist */
TrustKycSchema.pre("save", function (next) {
  if (!this.trust_details) this.trust_details = {};
  if (!this.trust_details.contact_information)
    this.trust_details.contact_information = {};
  next();
});

TrustKycSchema.post("save", async function (doc, next) {
  if (!doc.uid && doc.sequence) {
    const padded = String(doc.sequence).padStart(3, "0");
    doc.uid = `TRKYC_${padded}`;
    await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
  }

  next();
});

TrustKycSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "trust_kyc_sequence", // unique counter id for this schema
  start_seq: 1,
});

module.exports = mongoose.model("TrustKyc", TrustKycSchema);
