const mongoose = require("mongoose");

const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const slugify = require("slugify");
const autopopulate = require("mongoose-autopopulate");

const { Schema } = mongoose;

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const ContactSchema = new Schema(
  {
    name: { type: String, trim: true },
    title: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    primary: { type: Boolean, default: false },
  },
  { _id: false }
);

const AddressSchema = new Schema(
  {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: "Bangladesh" },
    zipcode: { type: String, trim: true },
    geo: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: [0, 0] },
    },
  },
  { _id: false }
);

const DocumentSchema = new Schema(
  {
    name: { type: String, trim: true },
    url: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    type: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── RiskQuestionsSchema ───────────────────────────────────────────────────────
// Stores the AUSTRAC questionnaire answers used by the risk register engine.
// Fields that overlap with top-level Client fields are duplicated here so the
// engine can read a single coherent answers object without joining.

const CtrlEffSchema = new Schema(
  {
    cdd: { type: Number, min: 1, max: 5, default: 3 },
    tm: { type: Number, min: 1, max: 5, default: 3 },
    scr: { type: Number, min: 1, max: 5, default: 3 },
    geo: { type: Number, min: 1, max: 5, default: 3 },
    gov: { type: Number, min: 1, max: 5, default: 3 },
  },
  { _id: false }
);

const RiskQuestionsSchema = new Schema(
  {
    // ── Identity (mirrors Client top-level for engine convenience) ────────────
    // entity_type  → resolved from Client.clientType via fuzzy map if absent
    entity_type: { type: String, trim: true },
    // abn          → mirrors Client.registrationNumber
    abn: { type: String, trim: true },
    assessDate: { type: Date },
    austrac_enrolled: { type: String, trim: true },
    austracEnrolmentRef: { type: String, trim: true },  // e.g. "ENR-20260001"
    effectiveDate:       { type: String, trim: true },  // e.g. "1 July 2026"
    documentDate:        { type: String, trim: true },  // e.g. "15 June 2026"

    // ── Compliance Officer (mirrors Client.legalRepresentative) ───────────────
    co_name: { type: String, trim: true },
    co_email: { type: String, trim: true, lowercase: true },
    co_phone: { type: String, trim: true },

    // ── Senior Manager ────────────────────────────────────────────────────────
    sm_name: { type: String, trim: true },
    sm_email: { type: String, trim: true, lowercase: true },

    // ── Sector ────────────────────────────────────────────────────────────────
    turnover_range: { type: String, trim: true },
    is_sole_practitioner: { type: String, trim: true },
    licence_types: { type: [String], default: [] },

    // ── Customer Types ────────────────────────────────────────────────────────
    // Possible values: Individuals, Sole traders, Bodies corporate,
    //                  Trusts, Partnerships, Government / Public bodies,
    //                  Foreign entities, Financial institutions
    client_types: { type: [String], default: [] },
    foreign_client_proportion: { type: String, trim: true },
    // How often trusts / multi-layer corporate structures appear
    complex_structures: { type: String, trim: true },
    // No PEP exposure | Domestic PEPs only | Foreign PEPs only | Both
    pep_exposure: { type: String, trim: true },

    // ── Delivery Channels ─────────────────────────────────────────────────────
    delivery_channels: { type: [String], default: [] },
    non_f2f_proportion: { type: String, trim: true },
    // No | Yes — with formal CDD Arrangement | Yes — without formal arrangement
    uses_intermediaries: { type: String, trim: true },
    // No | Occasionally | Regularly
    handles_cash: { type: String, trim: true },

    // ── Designated Services Narrative ────────────────────────────────────────
    // Free-text list of specific services for AML/CTF Program document body.
    // Accountants: Table 7 services; Real Estate: Table 8 services, etc.
    designatedServicesText: { type: String, trim: true },

    // ── Designated Service Flags ──────────────────────────────────────────────
    ds_high_value_unfinanced: { type: String, trim: true },  // Yes/No
    ds_high_currency: { type: String, trim: true },  // Yes/No
    ds_intl_transfers: { type: String, trim: true },  // Yes/No
    // No | Occasionally | Regularly
    ds_anonymous_clients: { type: String, trim: true },
    ds_virtual_assets: { type: String, trim: true },  // Yes/No
    ds_complex_structures: { type: String, trim: true },  // Yes/No
    // No | Occasionally | Yes
    ds_unusual_services: { type: String, trim: true },

    // ── Client Risk Indicators ────────────────────────────────────────────────
    // No | Occasionally | Regularly
    cr_criminal_activity: { type: String, trim: true },
    // No | Domestic PEPs | Foreign PEPs | Both
    cr_pep: { type: String, trim: true },
    cr_unexplained_wealth: { type: String, trim: true },  // Yes/No
    // No | Occasionally | Yes — including with enhanced risk indicators
    cr_npo: { type: String, trim: true },

    // ── Channel Risk ──────────────────────────────────────────────────────────
    ch_remote_only: { type: String, trim: true },  // Yes/No
    // No | Yes — with formal CDD Arrangement | Yes — without formal arrangement
    ch_third_party_cdd: { type: String, trim: true },

    // ── Country / Jurisdiction ────────────────────────────────────────────────
    countries_exposure: { type: [String], default: [] },
    medium_risk_country: { type: String, trim: true },  // Yes/No
    high_risk_country: { type: String, trim: true },  // Yes/No
    // Confirmed and operational | In progress | Not yet established
    sanctions_screening_confirmed: { type: String, trim: true },

    // ── Control Effectiveness (1 = Initial → 5 = Optimised) ──────────────────
    ctrlEff: { type: CtrlEffSchema, default: () => ({}) },
  },
  { _id: false }
);

// ── Main Client schema ────────────────────────────────────────────────────────

const ClientSchema = new Schema(
  {
    uid: String,
    user: { type: mongoose.Schema.ObjectId, ref: "Users" },
    sequence: { type: Number, index: true },

    name: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, sparse: true, index: true },
    clientType: { type: String, required: true },

    // official identifiers
    registrationNumber: { type: String, trim: true, index: true, sparse: true },
    taxId: { type: String, trim: true, index: true, sparse: true },

    // contact info
    email: { type: String, trim: true, lowercase: true, index: true, sparse: true },
    phone: { type: String, trim: true },
    website: { type: String, trim: true },

    // nested / relational
    contacts: { type: [ContactSchema], default: [] },
    address: { type: AddressSchema, default: {} },

    legalRepresentative: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      designation: { type: String, trim: true },
    },

    documents: { type: [DocumentSchema], default: [] },

    status: {
      type: String,
      enum: ["Pending", "Active", "Inactive", "Blocked"],
      default: "Pending",
    },

    // Structured AUSTRAC questionnaire answers
    riskQuestions: { type: RiskQuestionsSchema, default: () => ({}) },

    settings: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

ClientSchema.index({ "address.geo": "2dsphere" });
ClientSchema.index({ user: 1 });

// ── Virtuals ──────────────────────────────────────────────────────────────────

ClientSchema.virtual("branches", {
  ref: "Branch",
  localField: "_id",
  foreignField: "client",
  justOne: false,
});

ClientSchema.virtual("fullAddress").get(function () {
  const a = this.address || {};
  return [a.street, a.city, a.state, a.zipcode, a.country].filter(Boolean).join(", ");
});

// ── Pre-save hooks ────────────────────────────────────────────────────────────

ClientSchema.pre("save", async function (next) {
  try {
    if (this.isModified("name") || !this.slug) {
      let baseSlug = slugify(this.name, { lower: true, strict: true });
      let slug = baseSlug;
      let counter = 1;
      const Client = this.constructor;
      while (await Client.exists({ slug })) {
        slug = `${baseSlug}-${counter}`;
        counter++;
      }
      this.slug = slug;
    }
    next();
  } catch (error) {
    next(error);
  }
});

ClientSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `GRP_${Date.now()}`;
  }
  next();
});

// ── Plugins ───────────────────────────────────────────────────────────────────

ClientSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
ClientSchema.plugin(mongoosePaginate);
ClientSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "client_sequence",
  start_seq: 1,
});
ClientSchema.plugin(autopopulate);

const Client = mongoose.model("Client", ClientSchema);

module.exports = Client;
