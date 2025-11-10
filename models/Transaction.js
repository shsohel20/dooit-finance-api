const mongoose = require("mongoose");
const { Schema } = mongoose;
const AutoIncrement = require("mongoose-sequence")(mongoose);
/**
 * Small reusable sub-schemas
 */
const PartySchema = new Schema(
  {
    name: { type: String, trim: true, index: true },
    account: { type: String, trim: true }, // account/wallet id
    institution: { type: String, trim: true }, // bank name / VASP name
    institutionCountry: { type: String, trim: true },
    bic: { type: String, trim: true }, // optional BIC/SWIFT
    address: { type: String, trim: true },
    extra: { type: Schema.Types.Mixed }, // any provider-specific payload
  },
  { _id: false }
);

const CryptoSchema = new Schema(
  {
    walletAddress: { type: String, trim: true, index: true, sparse: true },
    txHash: { type: String, trim: true, index: true, sparse: true },
    network: { type: String, trim: true },
    hops: { type: Number, default: 0 },
    cluster: { type: String, trim: true }, // cluster name if known
  },
  { _id: false }
);

const TravelRuleSchema = new Schema(
  {
    originatorVaspId: { type: String, trim: true, index: true, sparse: true },
    originatorVaspName: { type: String, trim: true },
    originatorVaspLicense: { type: String, trim: true },
    beneficiaryVaspId: { type: String, trim: true, index: true, sparse: true },
    beneficiaryVaspName: { type: String, trim: true },
    travelMessageId: { type: String, trim: true, index: true, sparse: true },
    protocol: { type: String, trim: true }, // e.g. IVMS101
  },
  { _id: false }
);

/**
 * Main Transaction Schema
 */
const TransactionSchema = new Schema(
  {
    sequence: { type: Number, index: true },

    // TX_001
    uid: { type: String, unique: true, index: true },

    // relations
    customer: { type: Schema.Types.ObjectId, ref: "Customer", index: true },
    client: { type: Schema.Types.ObjectId, ref: "Client", index: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", index: true },

    // TX_002 timestamp
    timestamp: { type: Date, default: Date.now, index: true },

    // TX_003 / TX_004
    type: {
      type: String,
      enum: ["deposit", "withdrawal", "transfer", "exchange", "other"],
      default: "transfer",
      index: true,
    },
    subtype: { type: String, trim: true }, // e.g., "wire", "spot-fx", "otc"

    // TX_005 - amounts
    amount: { type: Number, required: true },
    currency: { type: String, required: true, trim: true, index: true },
    convertedAmountAUD: { type: Number }, // TX_007

    // TX_008 reference & narrative
    reference: { type: String, trim: true, index: true },
    narrative: { type: String, trim: true },

    // TX_009 status
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },

    // TX_010 channel
    channel: { type: String, trim: true, index: true }, // Mobile App, Branch, Online

    // Sender / Beneficiary / Intermediary
    sender: { type: PartySchema, default: {} }, // TX_011 .. TX_014
    beneficiary: { type: PartySchema, default: {} }, // TX_015 .. TX_018
    intermediary: { type: PartySchema, default: {} }, // TX_019

    // TX_020 purpose / TX_021 remittance code
    purpose: { type: String, trim: true },
    remittancePurposeCode: { type: String, trim: true },

    // Crypto-specific TX_022..TX_024
    crypto: { type: CryptoSchema, default: {} },

    // Bullion / precious metals (simple examples)
    bullion: {
      type: { type: String, trim: true }, // e.g., "gold"
      purity: { type: String, trim: true }, // "99.99"
      weight: { type: Number }, // grams
    },

    // Risk & Forensic (RISK_001..FOR_001 etc.)
    riskScore: { type: Number, default: 0, index: true },
    riskFlags: [{ type: String, trim: true, index: true }], // e.g., ["pep", "sanction_match"]
    forensic: {
      walletCluster: { type: String, trim: true },
      chainalysisScore: { type: Number },
      notes: { type: String, trim: true },
    },

    // Travel rule / VASP metadata (TX_VA_*)
    travelRule: { type: TravelRuleSchema, default: {} },

    // Related party / group (TX_030)
    relatedPartyTxnId: { type: String, trim: true, index: true }, // link to group/related txns
    relatedPartyFlag: { type: Boolean, default: false },

    // Investigator / case link fields (INV_001..INV_004)
    investigation: {
      caseId: { type: String, trim: true, index: true },
      flagged: { type: Boolean, default: false },
      investigatorNotes: { type: String, trim: true },
    },

    // Operational metadata
    createdBy: { type: Schema.Types.ObjectId, ref: "Users", index: true },
    metadata: { type: Schema.Types.Mixed, default: {} }, // DIG_* / other auto-captured fields (IP, device, session)
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);
/**
 * Auto-increment plugin for sequence
 */
TransactionSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "transaction_sequence",
  start_seq: 1,
});
/**
 * Pre-save: basic checks / normalization
 */
TransactionSchema.pre("save", function (next) {
  // Normalize channel/currency to uppercase where appropriate
  if (this.currency) this.currency = this.currency.toUpperCase();
  if (this.channel) this.channel = this.channel.trim();
  next();
});

TransactionSchema.post("save", async function (doc, next) {
  if (!doc.uid && doc.sequence) {
    const padded = String(doc.sequence).padStart(3, "0");
    doc.uid = `TXN_${padded}`;
    await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
  }

  next();
});
/**
 * Indexes - avoid duplicate/index: true inside sub-docs for the same path.
 * Unique where needed, sparse for optional fields.
 */

TransactionSchema.index({ customer: 1, timestamp: -1 });

// TransactionSchema.index({ "crypto.walletAddress": 1 }, { sparse: true });
// TransactionSchema.index({ "travelRule.travelMessageId": 1 }, { sparse: true });
TransactionSchema.index({ reference: "text", narrative: "text" }); // text index for search

/**
 * Virtual: human friendly display
 */
TransactionSchema.virtual("displayAmount").get(function () {
  return `${this.amount} ${this.currency}`;
});

module.exports = mongoose.model("Transaction", TransactionSchema);
