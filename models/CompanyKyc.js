const mongoose = require("mongoose");
const { Schema } = mongoose;

const CompanyKycSchema = new Schema(
  {
    uid: String,
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
CompanyKycSchema.index(
  { "general_information.registration_number": 1 },
  { sparse: true }
);

// CompanyKycSchema.index({ customer: 1 });

/**
 * Virtual: friendlyName
 */
CompanyKycSchema.virtual("companyName").get(function () {
  return this.general_information && this.general_information.legal_name
    ? this.general_information.legal_name
    : null;
});

/**
 * Instance helper: addDirector
 */
CompanyKycSchema.methods.addDirector = async function (director) {
  this.directors_beneficial_owner.directors =
    this.directors_beneficial_owner.directors || [];
  this.directors_beneficial_owner.directors.push(director);
  this.directors_beneficial_owner.number_of_directors = (
    this.directors_beneficial_owner.directors || []
  ).length;
  await this.save();
  return this;
};

/**
 * Instance helper: addBeneficialOwner
 */
CompanyKycSchema.methods.addBeneficialOwner = async function (owner) {
  this.directors_beneficial_owner.beneficial_owners =
    this.directors_beneficial_owner.beneficial_owners || [];
  this.directors_beneficial_owner.beneficial_owners.push(owner);
  await this.save();
  return this;
};

/**
 * Pre-save: ensure number_of_directors reflects array length
 */
CompanyKycSchema.pre("save", function (next) {
  if (this.directors_beneficial_owner) {
    this.directors_beneficial_owner.number_of_directors = Array.isArray(
      this.directors_beneficial_owner.directors
    )
      ? this.directors_beneficial_owner.directors.length
      : 0;
  }
  next();
});

module.exports = mongoose.model("CompanyKyc", CompanyKycSchema);
