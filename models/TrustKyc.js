const mongoose = require("mongoose");
const { Schema } = mongoose;
const AutoIncrement = require("mongoose-sequence")(mongoose);

/**
 * TrustKyc
 * ─────────────────────────────────────────────────────────────────────────
 * Reorganised in docs/65 Step 59 after two fields were found to describe the
 * same fact in different places. The rule this file now follows:
 *
 *   ONE FACT HAS ONE CANONICAL HOME. Where a second path must survive
 *   because live writers depend on it, it is an ALIAS — and the MODEL keeps
 *   it in sync, not the writers.
 *
 * That last part is the important half. Before this step the KYB wizard was
 * responsible for writing both `settlor.full_name` and
 * `trust_details.settlor_name`; every other writer (the two onboarding trust
 * forms) only wrote the flat one, so the structured one silently stayed
 * empty and readers had to know to check both. Synchronisation is now
 * `normaliseTrustDoc()` below, so it can't drift no matter who writes.
 *
 * CANONICAL / ALIAS pairs maintained here:
 *   trust_details.trust_identification.*  <-> trust_details.trust_type.<variant>.*
 *   settlor.country_of_residence          <-  settlor.residential_address.country
 *   controllers.controlling_persons[]     <-  appointors[]
 *
 * `trust_details.settlor_name` used to be one of these. It was REMOVED in
 * Step 60 by owner decision — `settlor.full_name` is now the only home for
 * the settlor's name. Writers still posting the old path are handled by
 * `liftLegacyTrustFields()` rather than by a schema field.
 *
 * NOTE ON WRITE PATHS: the reconciliation runs in a `save` hook, so every
 * writer must go through `create()` or `doc.save()`. `findByIdAndUpdate`
 * bypasses it — `resolveTrustLinks`' upsert was changed to findById+save in
 * Step 59 for exactly this reason. Don't reintroduce findOneAndUpdate here
 * without also porting the reconciliation to that hook.
 */

// Enum'd fields coerce "" -> undefined before validation (same pattern as
// CompanyKyc, docs/65 Step 30): Mongoose's enum validator skips undefined
// but rejects empty string, and onboarding writers submit "" for untouched
// selects.
const emptyToUndef = (v) => (v === "" ? undefined : v);

const SCREENING_STATUSES = ["cleared", "pending", "pep", "flagged"];

/* ── shared shapes ─────────────────────────────────────────────────────── */

// Rows carry an _id (docs/65 Step 55, mirroring CompanyKyc's Step 31 change)
// so they can be referenced by verification workflows — URL alone stops
// being the only identity. `docType` is the platform-wide document-kind
// field; `type` is legacy (still read, no longer written).
const DocumentMetaSchema = new Schema({
  name: String,
  url: String,
  mimeType: String,
  type: String,
  docType: String,
  expiry_date: Date,
  verification_status: {
    type: String,
    enum: ["unverified", "verified", "rejected"],
    set: emptyToUndef,
  },
  verified_by: { type: Schema.Types.ObjectId, ref: "Users" },
  verified_at: Date,
  uploadedAt: { type: Date, default: Date.now },
});

// A person's/company's own street address — settlor, individual trustees,
// company-trustee registered office. Uses `street`.
const StreetAddressSchema = new Schema(
  {
    street: String,
    suburb: String,
    state: String,
    postcode: String,
    country: String,
  },
  { _id: false },
);

// The TRUST's own addresses use `address` where the schema above uses
// `street`. That inconsistency is deliberate and load-bearing: four live
// onboarding forms already post `principal_address.address`, so renaming it
// would silently drop their data. Kept as its own shape so the difference is
// explicit rather than looking like a mistake.
const TrustAddressSchema = new Schema(
  {
    address: String,
    suburb: String,
    state: String,
    postcode: String,
    country: String,
  },
  { _id: false },
);

// KYC review decision history — same shape as CompanyKyc.review_history /
// Customer.kycHistory, the platform's established decision-trail pattern.
// Rejection reasons and approval details live in these entries (note +
// changedBy + changedAt), not in dedicated scalar fields.
const ReviewHistorySchema = new Schema(
  {
    status: String,
    note: String,
    changedBy: { type: Schema.Types.ObjectId, ref: "Users" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * Which generic identifier each regulatory variant restates. Only the two
 * that name a fact the generic block also holds are reconciled — `asrn` and
 * `legislation_name` are variant-only, so they have no generic counterpart
 * and are left alone.
 */
const VARIANT_ID_FIELD = {
  unregulated_trust: "registration_number",
  self_managed_super_fund: "abn",
  managed_investment_scheme_unregistered: "abn",
  other_superannuation_trust: "registration_number",
};
const RECONCILED_IDS = ["abn", "registration_number"];

const TrustKycSchema = new Schema(
  {
    uid: String,
    sequence: { type: Number, index: true }, // auto incremented

    customer: {
      type: mongoose.Schema.ObjectId,
      ref: "Customer",
      required: false,
      index: true,
    },

    /* ── the trust itself ────────────────────────────────────────────── */
    trust_details: {
      full_trust_name: String,
      // The trust's single country field — "country of registration" maps
      // here rather than to a duplicate field.
      country_of_establishment: String,
      governing_law: String, // e.g. "VIC"

      // Dates of the trust's existence. These sat under
      // `trust_identification` until Step 59, which was a mis-filing — a
      // date is not an identifier. Readers of the old path: none outside
      // the KYB wizard, which moved with them.
      date_established: Date,
      date_of_deed: Date,

      // CANONICAL generic identifiers. Any trust may carry these whatever
      // its regulatory category. Where the selected trust_type ALSO has a
      // slot for the same fact (an SMSF's ABN, an unregulated trust's
      // registration number), normaliseTrustDoc keeps the two equal, so the
      // sparse indexes further down match a record no matter which form
      // created it.
      trust_identification: {
        abn: String,
        acn: String,
        registration_number: String,
        tfn: String, // if applicable
        tax_residency: String,
        // DEPRECATED aliases of trust_details.date_established /
        // .date_of_deed. Declared so records written before the Step 59 move
        // stay readable through the model (a removed path is dropped from a
        // hydrated doc, which would have stranded stored dates); reconciled
        // upward by normaliseTrustDoc. Nothing writes these any more.
        date_established: Date,
        date_of_deed: Date,
      },

      // The nominal amount the settlor paid the trustee to constitute the
      // trust — a figure stated on the deed itself (commonly $10). Stored as
      // amount + currency rather than free text so it stays comparable and
      // isn't ambiguous for a trust settled outside Australia; the sibling
      // money fields here (annual_income, estimated_trading_volume) are free
      // text because they're ranges, whereas this is one exact legal figure.
      settled_sum: {
        amount: { type: Number, min: 0 },
        currency: { type: String, trim: true, uppercase: true },
      },

      // NOTE: `settlor_name` was removed here in docs/65 Step 60 — the
      // settlor's name lives ONLY on `settlor.full_name` now. Writers that
      // still post the old path (the two onboarding apps' trust forms) are
      // not broken: `liftLegacyTrustFields()` below moves it onto the
      // canonical field before the payload ever reaches this schema, which
      // it has to, because Mongoose drops unknown paths at construction and
      // no save hook could recover the value afterwards.

      industry: String,
      nature_of_business: String,
      annual_income: String,
      estimated_trading_volume: String,

      principal_address: TrustAddressSchema,
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

      // Regulatory category + the fields specific to it. The per-variant
      // `abn`/`registration_number` slots are ALIASES of the generic block
      // above (kept in sync); `asrn`, `legislation_name`, `type_description`,
      // `is_registered` and `regulatory_body` are variant-only facts with no
      // generic counterpart.
      trust_type: {
        selected_type: String,
        unregulated_trust: {
          type_description: String,
          is_registered: Boolean,
          regulatory_body: String,
          registration_number: String,
        },
        self_managed_super_fund: { abn: String },
        managed_investment_scheme_registered: { asrn: String },
        government_superannuation_fund: { legislation_name: String },
        managed_investment_scheme_unregistered: { abn: String },
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
    },

    /* ── the people behind it ────────────────────────────────────────── */

    // The settlor record — and since Step 60, the ONLY home for the
    // settlor's name. An entity settlor uses the company sub-block instead
    // of DOB/residence.
    settlor: {
      full_name: String,
      date_of_birth: Date,
      residential_address: StreetAddressSchema,
      // Derived from residential_address.country when that's present;
      // settable on its own when the full address isn't known.
      country_of_residence: String,
      is_company: Boolean,
      company: {
        company_name: String,
        registration_number: String,
      },
    },

    individual_trustees: {
      trustees: [
        {
          full_name: String,
          date_of_birth: Date,
          // Was an inline copy of the same five fields until Step 59.
          residential_address: StreetAddressSchema,
        },
      ],
      has_additional_trustees: Boolean,
    },

    company_trustees: {
      has_company_trustees: Boolean,
      company_details: [
        {
          company_name: String,
          registration_number: String, // ACN (or foreign equivalent)
          abn: String,
          registered_address: StreetAddressSchema,
          directors: [{ full_name: String }],
        },
      ],
    },

    beneficiaries: [
      {
        named_beneficiaries: String,
        beneficiary_classes: String,
        beneficiary_type: {
          type: String,
          enum: ["individual", "class", "company", "other"],
          set: emptyToUndef,
        },
        beneficial_interest_percent: { type: Number, min: 0, max: 100 },
        date_of_birth: Date, // individual beneficiaries only
      },
    ],

    // Who controls the trust. `controlling_persons` is the CANONICAL
    // register — anyone with power over the trust (appointor, guardian,
    // protector) belongs here, and every name in `appointors` below is
    // promoted into it automatically.
    controllers: {
      authorised_representatives: [
        {
          full_name: String,
          role: String,
        },
      ],
      controlling_persons: [
        {
          full_name: String,
          role: String, // e.g. appointor, guardian, protector
          pep_status: { type: String, enum: SCREENING_STATUSES, set: emptyToUndef },
          sanctions_status: { type: String, enum: SCREENING_STATUSES, set: emptyToUndef },
        },
      ],
    },

    // Raw appointor names as the trust-deed OCR extracts them — no role, no
    // screening. An inbox, not a register: normaliseTrustDoc promotes each
    // name into controllers.controlling_persons (role "appointor") so there
    // is one list to read, and does so idempotently.
    appointors: [String],

    /* ── compliance working state ────────────────────────────────────── */

    // Officer-set verification/risk plus the two intake questions. Distinct
    // from the per-person screening on controlling_persons above: these
    // describe the trust as a whole.
    aml_kyc: {
      kyc_verification_status: {
        type: String,
        enum: ["unverified", "in_progress", "verified", "rejected"],
        set: emptyToUndef,
      },
      verification_date: Date,
      risk_rating: {
        type: String,
        enum: ["low", "medium", "high", "extreme"],
        set: emptyToUndef,
      },
      source_of_funds: String,
      source_of_wealth: String,
      pep_screening_status: { type: String, enum: SCREENING_STATUSES, set: emptyToUndef },
      sanctions_screening_status: { type: String, enum: SCREENING_STATUSES, set: emptyToUndef },
    },

    documents: { type: [DocumentMetaSchema], default: [] },

    // Review workflow — same server-owned pattern as
    // CompanyKyc.review_status/review_history (Step 31): never accepted from
    // a client payload; rejection reasons and approval details are history
    // entries, not scalar fields.
    review_status: {
      type: String,
      enum: ["draft", "in_review", "approved", "escalated", "declined"],
      set: emptyToUndef,
    },
    review_history: { type: [ReviewHistorySchema], default: [] },
    next_review_date: Date,

    osintStatus: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/* ── reconciliation ────────────────────────────────────────────────────── */

/**
 * Moves retired payload paths onto their canonical fields, IN PLACE, on a
 * raw payload object (docs/65 Step 60).
 *
 * This has to run before the payload reaches the model. Mongoose drops
 * paths that aren't in the schema at document construction, so by the time
 * any `validate`/`save` hook runs the value is already gone — a hook cannot
 * be the safety net for a removed field.
 *
 * Currently handles:
 *   trust_details.settlor_name  ->  settlor.full_name
 * which the two onboarding apps' trust forms still post (they reach
 * TrustKyc through acceptInvite -> upsertEntityModel). Keeping this shim
 * means those forms don't have to be redeployed in lockstep, and a stale
 * cached client bundle can't silently drop a settlor name.
 *
 * Safe to call on any object, including undefined/non-trust payloads.
 */
function liftLegacyTrustFields(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const legacyName = payload.trust_details?.settlor_name;
  if (typeof legacyName === "string" && legacyName.trim()) {
    payload.settlor = payload.settlor || {};
    if (!String(payload.settlor.full_name || "").trim()) {
      payload.settlor.full_name = legacyName.trim();
    }
  }
  if (payload.trust_details && "settlor_name" in payload.trust_details) {
    delete payload.trust_details.settlor_name;
  }
  return payload;
}

/**
 * Keeps every CANONICAL/ALIAS pair equal. Idempotent — it must be safe to
 * run on every save, including saves that change nothing.
 *
 * Direction rule: whichever side has a value wins; when both have one and
 * they disagree, the CANONICAL side wins (the structured field is the one
 * new code writes deliberately).
 */
function normaliseTrustDoc(doc) {
  if (!doc) return;
  if (!doc.trust_details) doc.trust_details = {};
  const td = doc.trust_details;
  if (!td.contact_information) td.contact_information = {};

  // Dates: promote the pre-Step-59 location up to trust_details.
  const ti = td.trust_identification;
  if (ti) {
    if (!td.date_established && ti.date_established) td.date_established = ti.date_established;
    if (!td.date_of_deed && ti.date_of_deed) td.date_of_deed = ti.date_of_deed;
  }

  // settlor.country_of_residence <- residential_address.country
  const addrCountry = doc.settlor?.residential_address?.country;
  if (addrCountry && !doc.settlor.country_of_residence) {
    doc.settlor.country_of_residence = addrCountry;
  }

  // Generic identifiers <-> the selected variant's restatement of them.
  const selected = td.trust_type?.selected_type;
  const variantKey = VARIANT_ID_FIELD[selected];
  if (selected && variantKey && RECONCILED_IDS.includes(variantKey)) {
    if (!td.trust_identification) td.trust_identification = {};
    if (!td.trust_type[selected]) td.trust_type[selected] = {};
    const generic = td.trust_identification[variantKey];
    const variant = td.trust_type[selected][variantKey];
    if (generic) td.trust_type[selected][variantKey] = generic;
    else if (variant) td.trust_identification[variantKey] = variant;
  }

  // appointors[] -> controllers.controlling_persons[] (idempotent by name)
  const names = (doc.appointors || []).map((n) => String(n || "").trim()).filter(Boolean);
  if (names.length) {
    if (!doc.controllers) doc.controllers = {};
    if (!Array.isArray(doc.controllers.controlling_persons)) doc.controllers.controlling_persons = [];
    const seen = new Set(
      doc.controllers.controlling_persons.map((p) => String(p?.full_name || "").trim().toLowerCase()).filter(Boolean),
    );
    for (const name of names) {
      if (!seen.has(name.toLowerCase())) {
        doc.controllers.controlling_persons.push({ full_name: name, role: "appointor" });
        seen.add(name.toLowerCase());
      }
    }
  }
}

TrustKycSchema.pre("save", function (next) {
  normaliseTrustDoc(this);
  if (this.isNew && !this.uid) {
    this.uid = `TRKYC_${Date.now()}`;
  }
  next();
});

/* ── indexes ───────────────────────────────────────────────────────────── */

// Lookups hit the GENERIC identifiers now that reconciliation guarantees a
// variant-only write is mirrored up into them. The two variant-path indexes
// that existed before Step 59 are kept so records written directly (and any
// query still phrased against those paths) stay fast.
TrustKycSchema.index({ "trust_details.trust_identification.abn": 1 }, { sparse: true });
TrustKycSchema.index({ "trust_details.trust_identification.registration_number": 1 }, { sparse: true });
TrustKycSchema.index({ "trust_details.trust_type.unregulated_trust.registration_number": 1 }, { sparse: true });
TrustKycSchema.index({ "trust_details.trust_type.self_managed_super_fund.abn": 1 }, { sparse: true });

/* ── virtuals ──────────────────────────────────────────────────────────── */

TrustKycSchema.virtual("trustName").get(function () {
  return this.trust_details && this.trust_details.full_trust_name ? this.trust_details.full_trust_name : null;
});

TrustKycSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "trust_kyc_sequence", // unique counter id for this schema
  start_seq: 1,
});

module.exports = mongoose.model("TrustKyc", TrustKycSchema);
module.exports.normaliseTrustDoc = normaliseTrustDoc;
module.exports.liftLegacyTrustFields = liftLegacyTrustFields;
