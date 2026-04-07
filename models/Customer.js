const mongoose = require("mongoose");
const crypto = require("crypto");
const {
  buildRiskAssessmentFromCustomer,
  buildRiskAssessmentPerRelation,
} = require("../utils/riskAssessment");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const { roleEncryptionPlugin } = require("../utils/roleEncryptionPlugin");

const { Schema } = mongoose;

const restrictedProperty = [
  "personalKyc.personal_form.customer_details.given_name",
  "personalKyc.personal_form.customer_details.surname",
  "personalKyc.personal_form.contact_details.email",
  "personalKyc.personal_form.contact_details.phone",
  "personalKyc.personal_form.identificationNo",
];

const PersonalFormSchema = new Schema(
  {
    customer_details: {
      given_name: { type: String },
      middle_name: { type: String },
      surname: { type: String },
      date_of_birth: Date,
      other_names: String,
      referral: String,
    },
    contact_details: {
      email: { type: String },
      phone: { type: String },
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
    identificationNo: {
      type: String,
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
    docType: String,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CustomerSchema = new Schema(
  {
    uid: String,
    sequence: { type: Number, index: true }, // auto incremented
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
        onboardingChannel: { type: String, default: "Mobile App" }, //Mobile App, Website, In-Branch, Agent.

        registeredAt: { type: Date, default: Date.now },
        source: { type: String, default: "api" }, // e.g. "in-branch", "web", "api", "agent"
        notes: { type: String, default: "" },
        active: { type: Boolean, default: true },

        // --- INVITE: relation-scoped invite fields ---
        invitedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
        inviteToken: { type: String, default: null }, // hashed
        inviteTokenExpire: { type: Date, default: null },
        inviteTokenPlain: { type: String, select: false, default: null }, // optional plain token (dev/testing)
        // optional: track invite createdAt
        inviteCreatedAt: { type: Date, default: null },
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

    isPep: { type: Boolean, default: false },
    sanction: { type: Boolean, default: false },

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

    // 🔐 controls READ behavior only
    isDataEncrypted: { type: Boolean, default: false },

    // Users blocked from seeing this document's decrypted fields,
    // regardless of their role or global PrivacyPermission grants.
    restrictedUsers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Users" }],
      default: [],
    },

  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);


// CustomerSchema.set("toJSON", {
//   transform: function (doc, ret) {
//     if (ret.country) ret.country = decrypt(ret.country);
//     //  if (ret.phone) ret.phone = decrypt(ret.phone);
//     return ret;
//   }
// });

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

/**
 * Relation-level invite helpers
 * - setRelationInvite(relationIndex, expiresInMinutes) => returns plain token
 * - clearRelationInvite(relationIndex)
 * - findRelationByTokenHashed(hashed) => returns { relation, index } or null
 */

CustomerSchema.methods.setRelationInvite = function (
  relIndex,
  expiresInMinutes = 60 * 24 * 7
) {
  const plain = crypto.randomBytes(20).toString("hex");
  const hashed = crypto.createHash("sha256").update(plain).digest("hex");

  // ensure relations exists
  if (!this.relations || !this.relations[relIndex]) {
    throw new Error("relation index not found");
  }

  const rel = this.relations[relIndex];
  rel.inviteToken = hashed;
  rel.inviteTokenExpire = Date.now() + expiresInMinutes * 60 * 1000;
  rel.inviteTokenPlain = plain;
  rel.inviteCreatedAt = new Date();

  // also set invitedBy if not present
  if (!rel.invitedBy && this._invitedByAtSet) {
    // noop (internal), otherwise caller should set rel.invitedBy
  }

  return plain;
};

CustomerSchema.methods.clearRelationInvite = function (relIndex) {
  if (!this.relations || !this.relations[relIndex]) return;
  const rel = this.relations[relIndex];
  rel.inviteToken = undefined;
  rel.inviteTokenExpire = undefined;
  rel.inviteTokenPlain = undefined;
  rel.inviteCreatedAt = undefined;
};

CustomerSchema.methods.findRelationByHashedToken = function (hashed) {
  if (!hashed || !this.relations) return null;
  for (let i = 0; i < this.relations.length; i++) {
    const r = this.relations[i];
    if (r.inviteToken === hashed) return { relation: r, index: i };
  }
  return null;
};

CustomerSchema.index(
  { _id: 1, "relations.client": 1, "relations.branch": 1 },
  { unique: true, sparse: true, name: "customer_relation_unique" }
);

CustomerSchema.index({
  uid: "text",
  "personalKyc.personal_form.customer_details.given_name": "text",
  "personalKyc.personal_form.customer_details.surname": "text",
  "personalKyc.personal_form.contact_details.email": "text",
});

// CustomerSchema.post("save", async function (doc, next) {
//   if (!doc.uid && doc.sequence) {
//     const padded = String(doc.sequence).padStart(3, "0");
//     doc.uid = `CR_${padded}`;
//     await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
//   }
//   next();
// });

// always encrypt before save
CustomerSchema.pre("save", function (next) {
  try {
    if (this.isNew && !this.uid) {
      this.uid = `CR_${Date.now()}`;
    }

    // if (!hasAnyEncryptedFlag(this) && this.encryptFieldsSync) {
    //   this.encryptFieldsSync();
    // }

    next();
  } catch (e) {
    next(e);
  }
});


// function autoDecrypt(doc) {
//   if (!doc) return;

//   // ✅ ONLY decrypt if you WANT plaintext mode
//   if (!doc.isDataEncrypted && hasAnyEncryptedFlag(doc) && doc.decryptFieldsSync) {
//     try {
//       doc.decryptFieldsSync();
//     } catch (e) { }
//   }
// }


/* =========================
   Read Middleware
========================= */

// CustomerSchema.post("init", autoDecrypt);
// CustomerSchema.post("find", (docs) => docs.forEach(autoDecrypt));
// CustomerSchema.post("findOne", autoDecrypt);


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

CustomerSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "customer_sequence", // unique counter id for this schema
  start_seq: 1,
});

CustomerSchema.plugin(roleEncryptionPlugin, { paths: restrictedProperty });
CustomerSchema.statics.restrictedProperty = restrictedProperty;

CustomerSchema.virtual("relationRisks").get(function () {
  const plain = this.toObject({ virtuals: false, getters: false });
  const { relationRisks } = buildRiskAssessmentPerRelation(plain);
  return relationRisks;
});

CustomerSchema.virtual("riskSummary").get(function () {
  const plain = this.toObject({ virtuals: false, getters: false });
  const { summary } = buildRiskAssessmentPerRelation(plain);
  return summary;
});

CustomerSchema.virtual("riskAssessment").get(function () {
  // if (!shouldDecrypt(this)) return null;
  const plain = this.toObject({ virtuals: false, getters: false });
  return buildRiskAssessmentFromCustomer(plain).riskAssessment;
});
CustomerSchema.virtual("riskScore").get(function () {
  const plain = this.toObject({ virtuals: false, getters: false });
  return buildRiskAssessmentFromCustomer(plain).riskScore;
});
CustomerSchema.virtual("riskLabel").get(function () {
  const plain = this.toObject({ virtuals: false, getters: false });
  return buildRiskAssessmentFromCustomer(plain).riskLabel;
});

// CustomerSchema.plugin(fieldEncryption, {
//   fields: ["personalKyc", "documents", "declaration"],
//   secret: process.env.DATA_ENCRYPTION_KEY,
// });


module.exports = mongoose.model("Customer", CustomerSchema);
