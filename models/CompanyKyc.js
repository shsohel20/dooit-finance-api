const mongoose = require("mongoose");
const { Schema } = mongoose;
const AutoIncrement = require("mongoose-sequence")(mongoose);

// Enum'd fields coerce "" -> undefined before validation (docs/65 Step 30):
// Mongoose's enum validator skips undefined but rejects empty string, and
// several onboarding writers submit "" for untouched selects. Coercing keeps
// those flows working while still rejecting actual wrong values.
const emptyToUndef = (v) => (v === "" ? undefined : v);

// Document rows carry an _id (docs/65 Step 31) so they can be referenced by
// verification workflows and removed individually — URL alone stops being
// the only identity. `docType` is the platform-wide document-kind field;
// `type` is legacy (still read, no longer written by new code).
const DocumentMetaSchema = new Schema({
  name: String,
  url: String,
  mimeType: String,
  type: String,
  docType: String,
  category: String, // e.g. charter_formation | constitution | other
  document_date: Date, // date of the document itself (versioning)
  expiry_date: Date, // e.g. proof-of-address staleness (docs/65 Step 31)
  verification_status: {
    type: String,
    enum: ["unverified", "verified", "rejected"],
    set: emptyToUndef,
  },
  // Binary lives in the platform file store, not on this document.
  file: { type: Schema.Types.ObjectId, ref: "File" },
  uploadedAt: { type: Date, default: Date.now },
});

/* -------------------------
   KYB Phase-1 sub-schemas (GEMS-aligned registers — see docs/kyb concpet
   and docs/75). All optional/additive: legacy records remain valid untouched.
   Intentionally excludes ASIC-filing/lodgement fields (owner decision, see
   docs/75 §"What this rebuild deliberately omits").
   ------------------------- */

const IdentifierSchema = new Schema(
  {
    id_type: {
      type: String,
      enum: ["acn", "abn", "arbn", "lei", "corporate_key", "other"],
      set: emptyToUndef,
    },
    value: String,
    jurisdiction: String,
  },
  { _id: false }
);

// Shared address shape (docs/65 Step 26) — backs registered_addresses[],
// business_addresses[] and local_agents[].address below. Arrays hold
// concurrently-active entries (e.g. multiple business locations, local
// agents in multiple jurisdictions), not a history/audit trail.
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

const LocalAgentSchema = new Schema(
  {
    name: String,
    address: AddressSchema,
  },
  { _id: false }
);

const AppointmentSchema = new Schema({
  role: {
    type: String,
    enum: ["director", "secretary", "amlctf_compliance_officer", "authorized_signer", "poa", "other"],
    set: emptyToUndef,
  },
  given_name: String,
  surname: String,
  date_appointed: Date,
  date_resigned: Date,
  date_of_birth: Date,
  birth_place: String, // "Melbourne, VIC"
  residential_address: AddressSchema, // structured, not free text (docs/65 Step 27)
  screening_status: {
    type: String,
    enum: ["cleared", "pending", "pep", "flagged"],
    set: emptyToUndef,
  },
  customer: { type: Schema.Types.ObjectId, ref: "Customer" }, // link once the person is onboarded
});

const ShareCapitalSchema = new Schema(
  {
    security_class: String,
    amount_issued: { type: Number, min: 0 },
    voting: { type: Boolean, default: true },
    total_paid: { type: Number, min: 0 },
    total_unpaid: { type: Number, min: 0 },
  },
  { _id: false }
);

const ShareholderSchema = new Schema(
  {
    holder_name: String,
    holder_model: String, // CompanyKyc | TrustKyc | NonIndividualKyc | Customer
    holder_entity: { type: Schema.Types.ObjectId, refPath: "shareholders.holder_model" },
    security_class: String,
    units_held: { type: Number, min: 0 },
    percent_held: { type: Number, min: 0, max: 100 },
    // False when this holder holds on behalf of someone else — the reason
    // beneficial_owners[] (below, on the schema) is a separate register
    // rather than derived from percent_held (docs/65 Step 23).
    beneficially_held: Boolean,
    fully_paid: Boolean,
    // Who this row is actually held for when beneficially_held is false
    // (docs/65 Step 43 — Trust/Nominee/Minor cases). A "trust" arrangement
    // links to a real TrustKyc via the existing holder_model/holder_entity
    // polymorphic ref above (holder_model:"TrustKyc"); nominee/minor aren't
    // TrustKyc-shaped, so they use the beneficiary block below instead.
    //
    // Restructured in docs/65 Step 66:
    //  - `type` -> `arrangement_type`. A nested path literally named `type`
    //    is the classic Mongoose ambiguity (it's also the type-descriptor
    //    key); it happened to register correctly here, but it read as a
    //    schema definition at every call site.
    //  - flat `beneficiary_name`/`date_of_birth` -> a `beneficiary` block,
    //    with `beneficiary_type` saying whether that beneficiary is a person
    //    or an entity. A nominee can hold for a company, which the single
    //    name field could only record as a string.
    // Old documents are migrated by api/scripts/migrate-beneficial-arrangement.js.
    beneficial_arrangement: {
      arrangement_type: {
        type: String,
        enum: ["trust", "nominee", "minor", "other"],
        set: emptyToUndef,
      },

      beneficiary_type: {
        type: String,
        enum: ["individual", "entity"],
        set: emptyToUndef,
      },

      beneficiary: {
        first_name: String,
        middle_name: String,
        last_name: String,
        // Whole-name capture. The wizard collects one name field, so this is
        // the populated one in practice; the split parts are here for
        // payloads that carry them (OCR, an imported register).
        full_name: String,

        entity_name: String, // beneficiary_type === "entity"

        date_of_birth: Date, // minor / individual beneficiary
      },

      // Declared but still never written: a "trust" arrangement's link lives
      // on holder_model/holder_entity above (docs/65 Step 43), and writing it
      // here as well would create a second source of truth for one link.
      trust_kyc: {
        type: Schema.Types.ObjectId,
        ref: "TrustKyc",
      },
    },
  },
  { _id: false }
);

const RelatedEntitySchema = new Schema(
  {
    relation: {
      type: String,
      enum: ["parent", "subsidiary", "branch"],
      set: emptyToUndef,
    },
    name: String,
    entity_ref: { type: Schema.Types.ObjectId, ref: "CompanyKyc" },
    percent_interest: { type: Number, min: 0, max: 100 },
    percent_voting: { type: Number, min: 0, max: 100 },
    jurisdiction: String,
    date_acquired: Date,
  },
  { _id: false }
);

const NameHistorySchema = new Schema(
  {
    name: String,
    effective_from: Date,
    effective_to: Date, // open entry (no effective_to) = current name
  },
  { _id: false }
);

// KYB review decision history (docs/65 Step 31) — same shape as
// Customer.kycHistory, the platform's established decision-trail pattern.
const ReviewHistorySchema = new Schema(
  {
    status: String,
    note: String,
    changedBy: { type: Schema.Types.ObjectId, ref: "Users" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CompanyKycSchema = new Schema(
  {
    uid: String,
    sequence: { type: Number, index: true }, // auto incremented

    //TODO

    customer: {
      type: mongoose.Schema.ObjectId,
      ref: "Customer",
      required: false,
      index: true,
    },
    // No client/branch fields here (docs/75, carried forward from the earlier
    // tenancy design): one company can be onboarded by multiple reporting
    // entities, so multi-tenancy belongs on Customer.relations rather than on
    // this document. If a tenant-scoping pass is reintroduced later, resolve
    // it at query time through Customer.relations — do not add client/branch
    // columns here.
    general_information: {
      legal_name: String,
      // Single current value, no history mechanism — unlike legal_name below,
      // nothing tracks prior trading names (docs/65 Step 23). Not a duplicate
      // of name_history; a real gap only if historical trading names are
      // ever required, which nothing currently needs.
      trading_names: String,
      // Multiple entries supported (docs/65 Step 38) — was a single scalar
      // String; legacy documents keep whatever they had (Mongoose casts an
      // existing scalar read back as-is, and casts a scalar *write* into a
      // one-element array, so older writers that still send a single string
      // keep working unchanged).
      phone_number: [String],
      // Deliberately independent of identifiers[] (docs/65 Step 23): backs a
      // live sparse index (below), a dedup lookup and a list-search filter in
      // customerController.js, and is the *only* registration-number field
      // every onboarding form except the KYB add-wizard writes (they have no
      // identifiers UI). The wizard derives this from the ACN row in
      // identifiers[] at submit time; the Review page de-dupes the display.
      registration_number: String, //acn ,arbn
      // The document's single, sole country/jurisdiction field (docs/65
      // Step 21) — entity_profile no longer carries a competing jurisdiction
      // field, so there's nothing to reconcile on display.
      country_of_incorporation: String,
      // Empty strings, null and undefined always pass Mongoose's match
      // validator, so optional-and-blank stays valid for every writer.
      // Multiple entries supported (docs/65 Step 38) — trim/lowercase/match
      // apply per-element for array-of-typed-string paths.
      contact_email: [
        {
          type: String,
          trim: true,
          lowercase: true,
          match: [/^\S+@\S+\.\S+$/, "contact_email must be a valid email address"],
        },
      ],
      industry: String,
      nature_of_business: String,
      annual_income: String,

      // Structured KYB classification (docs/65 Step 22 — formerly a separate
      // entity_profile sub-document, merged in here since nothing else used
      // it as a distinct register). The sole entity-classification field
      // (docs/65 Step 24) — the legacy company_type Mixed field was removed
      // and every onboarding writer (KYB add-wizard, both onboarding-ui/
      // onboard-new-ui company wizards, and the internal registration forms)
      // now targets this field directly.
      // "trust" as an entity_type was added in docs/65 Step 43 (requiring a
      // linked TrustKyc) and removed again in Step 45 — the wizard's "Trust"
      // label now collapses back into "other" (Step 24 behaviour), and a
      // Trust entity is onboarded through the separate TrustKyc flow instead
      // of the Companies module. Shareholder-level trust arrangements
      // (beneficial_arrangement, below) are unrelated and unaffected.
      entity_type: {
        type: String,
        enum: ["proprietary_limited", "public_company", "foreign_company", "other"],
        set: emptyToUndef,
      },
      registration_date: Date,
      // "external_administration" is live vocabulary — the add-wizard's
      // Status select ships it as its third option (docs/65 Step 30).
      status: {
        type: String,
        enum: ["active", "deregistered", "external_administration"],
        set: emptyToUndef,
      },
      class_subclass: String, // "Limited By Shares · Proprietary"
      account_purpose: Schema.Types.Mixed,
      estimated_trading_volume: String,

      // Concurrent entries, not a history register (docs/65 Step 26) — e.g. a
      // foreign company may have local agents in more than one jurisdiction.
      local_agents: { type: [LocalAgentSchema], default: [] },
      registered_addresses: { type: [AddressSchema], default: [] },
      // No "different_from_registered" flag — an empty array already means
      // "no separate business address on file" (docs/65 Step 26).
      business_addresses: { type: [AddressSchema], default: [] },
    },
    directors_beneficial_owner: {
      number_of_directors: Number,
      directors: [{ given_name: String, surname: String }],
      // Deliberately independent of shareholders[] below — a shareholder can
      // hold on behalf of someone else (see shareholders[].beneficially_held),
      // so ownership % here isn't safely derivable from units_held/
      // percent_held there. Owner decision (13 Jul 2026, docs/65 Step 23):
      // keep both registers populated independently, no auto-linkage.
      beneficial_owners: [
        {
          full_name: String,
          date_of_birth: Date,
          // Statutory UBO test needs the numbers (AML/CTF Act ≥25%) — and it
          // needs them sane: an unbounded 800% would silently pass the ≥25
          // check in the ubos virtual (docs/65 Step 30).
          ownership_percent: { type: Number, min: 0, max: 100 },
          voting_percent: { type: Number, min: 0, max: 100 },
          control_type: {
            type: String,
            enum: ["ownership", "voting_rights", "other_means"],
            set: emptyToUndef,
          },
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

    identifiers: { type: [IdentifierSchema], default: [] },
    // Supersedes directors[] as source of truth when present; a pre-save hook
    // below mirrors role === "director" rows into
    // directors_beneficial_owner.directors for backward compatibility — the
    // mirror lives in the model (not per-writer) so it can't drift.
    appointments: { type: [AppointmentSchema], default: [] },
    share_capital: { type: [ShareCapitalSchema], default: [] },
    shareholders: { type: [ShareholderSchema], default: [] },
    related_entities: { type: [RelatedEntitySchema], default: [] },
    // Maintained by the name-history pre-save hook; do not write directly.
    name_history: { type: [NameHistorySchema], default: [] },
    documents: { type: [DocumentMetaSchema], default: [] },
    //TODO company wise meta questions
    questionnaires: [{ type: Schema.Types.Mixed, default: {} }],
    // Osint Status
    osintStatus: { type: Boolean, default: false },

    // ── KYB review workflow (docs/65 Step 31) ────────────────────────────────
    // Internal review state — DISTINCT from general_information.status, which
    // is the company's registry standing (active/deregistered). Server-owned:
    // set on create ("in_review" via the writer), advanced only through
    // PATCH /company/:id/review-status; never accepted from a client payload
    // (excluded from pickKybPayload's whitelist).
    review_status: {
      type: String,
      enum: ["draft", "in_review", "approved", "escalated", "declined"],
      default: "draft",
      index: true,
    },
    // Maintained by the review-status endpoint; do not write directly.
    review_history: { type: [ReviewHistorySchema], default: [] },
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

CompanyKycSchema.index({ "identifiers.value": 1 }, { sparse: true });

// The company -> trust link, indexed so it can be read backwards (docs/65
// Step 70). GET /trust/:id/companies asks "which companies does this trust
// hold?", which is a query on this exact path; without the index it is a
// collection scan on every load of a trust dossier. Sparse because only
// shareholder rows that name a linked entity carry it. Its absence was
// flagged as the blocker for the reverse lookup at the end of Step 68.
CompanyKycSchema.index({ "shareholders.holder_entity": 1 }, { sparse: true });

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
 * Virtual: ubos
 * Beneficial owners meeting the statutory UBO test — ≥25% ownership or voting
 * interest, or control through other means (AML/CTF Act s.5 "beneficial owner").
 */
CompanyKycSchema.virtual("ubos").get(function () {
  const owners =
    (this.directors_beneficial_owner &&
      this.directors_beneficial_owner.beneficial_owners) ||
    [];
  return owners.filter(
    (o) =>
      (o.ownership_percent || 0) >= 25 ||
      (o.voting_percent || 0) >= 25 ||
      o.control_type === "other_means"
  );
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
 * Pre-save: mirror appointments[] director rows into the legacy
 * directors_beneficial_owner.directors[] (docs/75). appointments is
 * authoritative once populated — this enforces the mirror in the model so no
 * writer has to remember to do it by hand. Only overwrites directors[] when
 * appointments has at least one director row; a manually-set directors[] is
 * left untouched when appointments is empty or absent (pre-Phase-1 records).
 * Runs before the number_of_directors hook below so the count reflects the
 * mirrored list.
 */
CompanyKycSchema.pre("save", function (next) {
  if (Array.isArray(this.appointments) && this.appointments.length) {
    const directors = this.appointments
      .filter((a) => a.role === "director")
      .map((a) => ({ given_name: a.given_name, surname: a.surname }));
    if (directors.length) {
      this.directors_beneficial_owner = this.directors_beneficial_owner || {};
      this.directors_beneficial_owner.directors = directors;
    }
  }
  next();
});

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

/**
 * Pre-save: maintain name_history (GEMS "Name History" register).
 * The entry without effective_to is the current name; renaming closes it and
 * opens a new one.
 */
CompanyKycSchema.pre("save", function (next) {
  const legalName =
    this.general_information && this.general_information.legal_name;
  if (!legalName) return next();
  this.name_history = this.name_history || [];
  const current = this.name_history.find((n) => !n.effective_to);
  if (!current) {
    this.name_history.push({
      name: legalName,
      effective_from: this.createdAt || new Date(),
    });
  } else if (current.name !== legalName) {
    current.effective_to = new Date();
    this.name_history.push({ name: legalName, effective_from: new Date() });
  }
  next();
});

// CompanyKycSchema.post("save", async function (doc, next) {
//   if (!doc.uid && doc.sequence) {
//     const padded = String(doc.sequence).padStart(3, "0");
//     doc.uid = `COMKYC_${padded}`;
//     await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
//   }
//   next();
// });

CompanyKycSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    // Random suffix guards against same-millisecond collisions (docs/65
    // Step 30) — two concurrent creates used to mint identical uids. Format
    // still matches the /^COMKYC_/i lookup in getCompanyKyc.
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    this.uid = `COMKYC_${Date.now()}_${suffix}`;
  }
  next();
});

CompanyKycSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "customer_kyc_sequence", // unique counter id for this schema
  start_seq: 1,
});

module.exports = mongoose.model("CompanyKyc", CompanyKycSchema);
