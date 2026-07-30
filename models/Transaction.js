const mongoose = require("mongoose");
const { Schema } = mongoose;
const AutoIncrement = require("mongoose-sequence")(mongoose);
const autopopulate = require("mongoose-autopopulate");

/**
 * Party Schema (UPDATED)
 * Supports both registered + external entities
 */
const PartySchema = new Schema(
  {
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      autopopulate: true,
      // index: true,
    },

    name: { type: String, trim: true, index: true },
    account: { type: String, trim: true },
    institution: { type: String, trim: true },
    institutionCountry: { type: String, trim: true },
    bic: { type: String, trim: true },
    address: { type: String, trim: true },

    extra: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

/**
 * Crypto Schema
 */
const CryptoSchema = new Schema(
  {
    walletAddress: { type: String, trim: true, index: true, sparse: true },
    txHash: { type: String, trim: true, index: true, sparse: true },
    network: { type: String, trim: true },
    hops: { type: Number, default: 0 },
    cluster: { type: String, trim: true },
  },
  { _id: false }
);

/**
 * Travel Rule Schema
 */
const TravelRuleSchema = new Schema(
  {
    originatorVaspId: { type: String, trim: true, index: true, sparse: true },
    originatorVaspName: { type: String, trim: true },
    originatorVaspLicense: { type: String, trim: true },
    beneficiaryVaspId: { type: String, trim: true, index: true, sparse: true },
    beneficiaryVaspName: { type: String, trim: true },
    travelMessageId: { type: String, trim: true, index: true, sparse: true },
    protocol: { type: String, trim: true },
  },
  { _id: false }
);

/**
 * Main Transaction Schema
 */
const TransactionSchema = new Schema(
  {
    sequence: { type: Number, index: true, default: 1 },
    uid: { type: String, unique: true, index: true },

    client: { type: Schema.Types.ObjectId, ref: "Client", index: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", index: true },

    timestamp: { type: Date, default: Date.now, index: true },

    type: {
      type: String,
      enum: ["deposit", "withdrawal", "transfer", "exchange", "other"],
      default: "transfer",
      index: true,
    },

    subtype: { type: String, trim: true },

    amount: { type: Number, required: true },
    currency: { type: String, required: true, trim: true, index: true },
    convertedAmountAUD: { type: Number },

    reference: { type: String, trim: true, index: true },
    narrative: { type: String, trim: true },

    status: {
      type: String,
      enum: ["pending", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },

    channel: { type: String, trim: true, index: true },

    /**
     * 🔥 CORE FIX: Role-based parties
     */
    sender: { type: PartySchema, default: {} },
    receiver: { type: PartySchema, default: {} },
    beneficiary: { type: PartySchema, default: {} },
    intermediary: { type: PartySchema, default: {} },

    purpose: { type: String, trim: true },
    remittancePurposeCode: { type: String, trim: true },

    crypto: { type: CryptoSchema, default: {} },

    bullion: {
      type: { type: String, trim: true },
      purity: { type: String, trim: true },
      weight: { type: Number },
    },

    riskScore: { type: Number, default: 0, index: true },
    riskFlags: [{ type: String, trim: true, index: true }],

    forensic: {
      walletCluster: { type: String, trim: true },
      chainalysisScore: { type: Number },
      notes: { type: String, trim: true },
    },

    travelRule: { type: TravelRuleSchema, default: {} },

    relatedPartyTxnId: { type: String, default: "", trim: true, index: true },
    relatedPartyFlag: { type: Boolean, default: false },

    investigation: {
      // Canonical link to the investigation Case (kept in sync with Case.linkedTransactions[]).
      case: { type: Schema.Types.ObjectId, ref: "Case", default: null, index: true },
      caseId: { type: String, trim: true, index: true }, // legacy/string ref (now the Case uid)
      flagged: { type: Boolean, default: false },
      investigatorNotes: { type: String, trim: true },
    },

    createdBy: { type: Schema.Types.ObjectId, ref: "Users", index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/**
 * Auto Increment
 */
TransactionSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "transaction_sequence",
  start_seq: 1,
});

/**
 * 🔒 VALIDATION LOGIC (IMPORTANT)
 */
TransactionSchema.pre("validate", function (next) {
  const hasSender =
    this.sender?.customer || this.sender?.name;

  const hasReceiver =
    this.receiver?.customer || this.receiver?.name;

  if (this.type === "deposit" && !hasReceiver) {
    return next(new Error("Receiver required for deposit"));
  }

  if (this.type === "withdrawal" && !hasSender) {
    return next(new Error("Sender required for withdrawal"));
  }

  if (this.type === "transfer" && (!hasSender || !hasReceiver)) {
    return next(new Error("Sender & Receiver required for transfer"));
  }

  next();
});

/**
 * Pre-save
 */
TransactionSchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `TXN_${Date.now()}`;
  }

  if (this.currency) this.currency = this.currency.toUpperCase();
  if (this.channel) this.channel = this.channel.trim();

  next();
});

/**
 * Indexes
 */
TransactionSchema.index({ timestamp: -1 });
TransactionSchema.index({ "sender.customer": 1 });
TransactionSchema.index({ "receiver.customer": 1 });
TransactionSchema.index({ reference: "text", narrative: "text" });

/**
 * Virtual
 */
TransactionSchema.virtual("displayAmount").get(function () {
  return `${this.amount} ${this.currency}`;
});

TransactionSchema.plugin(autopopulate);

module.exports = mongoose.model("Transaction", TransactionSchema);