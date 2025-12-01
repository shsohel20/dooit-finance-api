// models/CustomerAccount.js
const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const { Schema } = mongoose;

/**
 * Card sub-schema
 */
const CardSchema = new Schema(
  {
    cardId: { type: String, trim: true }, // internal card id
    last4: { type: String, trim: true }, // last 4 digits
    brand: { type: String, trim: true }, // Visa / Mastercard / Amex
    expiryMonth: { type: Number, min: 1, max: 12 },
    expiryYear: { type: Number },
    issuedAt: { type: Date },
    status: {
      type: String,
      enum: ["active", "blocked", "cancelled", "expired"],
      default: "active",
    },
    tokenMasked: { type: String, trim: true }, // token or masked PAN (if stored)
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

/**
 * Contact sub-schema
 */
const ContactSchema = new Schema(
  {
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    address: { type: String, trim: true },
  },
  { _id: false }
);

/**
 * Main Customer Account Schema
 */
const CustomerAccountSchema = new Schema(
  {
    uid: { type: String, index: true }, // ACC_ timestamp uid

    // Auto increment sequence for human-friendly ids
    sequence: { type: Number, index: true },

    // relations
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: false,
      index: true,
    },
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: false,
      index: true,
    },

    // Basic account identifiers
    accountType: { type: String, required: true, trim: true }, // e.g., "savings", "business", "trust"
    accountName: { type: String, trim: true }, // friendly name for the account
    accountNumber: { type: String, required: true, trim: true, index: true },
    productCode: { type: String, trim: true }, // bank product code, if applicable

    // Bank routing / international identifiers (optional)
    currency: { type: String, trim: true, default: "AUD", index: true },
    iban: { type: String, trim: true, sparse: true },
    bsb: { type: String, trim: true, sparse: true }, // Australia specific
    swift: { type: String, trim: true, sparse: true },
    branchCode: { type: String, trim: true },

    // Financial state
    balance: { type: Number, default: 0 },
    availableBalance: { type: Number, default: 0 }, // optional
    overdraftLimit: { type: Number, default: 0 },
    dailyLimit: { type: Number, default: 0 },
    monthlyLimit: { type: Number, default: 0 },

    // Account holder details (denormalized - helpful for snapshots)
    accountHolderName: { type: String, trim: true },
    accountHolderType: {
      type: String,
      enum: ["individual", "company", "trust", "other"],
      default: "individual",
    },
    accountHolderContact: { type: ContactSchema, default: {} },

    // Cards (detailed card objects)
    linkedCards: { type: [CardSchema], default: [] },

    // Operational flags & metadata
    accountStatus: {
      type: String,
      enum: ["active", "suspended", "closed", "pending"],
      default: "active",
      index: true,
    },
    isActive: { type: Boolean, default: true, index: true },

    // Linked resources
    tags: [{ type: String, trim: true, index: true }], // arbitrary tags
    flags: [{ type: String, trim: true }], // e.g. ["pep", "watchlist"]

    // Activity timestamps
    openedAt: { type: Date },
    closedAt: { type: Date },
    lastActivityAt: { type: Date },

    // Misc / flexible storage
    metadata: { type: Schema.Types.Mixed, default: {} },

    // Who created/owns this record
    createdBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/**
 * Pre-save hooks
 */
CustomerAccountSchema.pre("save", function (next) {
  try {
    // generate uid if new
    if (this.isNew && !this.uid) {
      // Use milliseconds + random suffix to avoid collisions in quick parallel writes
      this.uid = `ACC_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    }

    // normalise accountNumber and currency
    if (this.accountNumber && typeof this.accountNumber === "string") {
      this.accountNumber = this.accountNumber.trim();
    }
    if (this.currency) this.currency = String(this.currency).toUpperCase();

    // Pre-save validation:
    // - must have either a linked 'customer' ObjectId or a non-empty accountHolderName
    // - accountNumber must be present
    if (
      !this.customer &&
      (!this.accountHolderName || String(this.accountHolderName).trim() === "")
    ) {
      const err = new Error(
        "Validation failed: either 'customer' (ObjectId) or 'accountHolderName' must be provided."
      );
      return next(err);
    }

    if (!this.accountNumber || String(this.accountNumber).trim() === "") {
      const err = new Error("Validation failed: 'accountNumber' is required.");
      return next(err);
    }

    next();
  } catch (e) {
    next(e);
  }
});

/**
 * Auto-increment plugin for sequence
 */
CustomerAccountSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "customer_account_sequence", // unique counter id for this schema
  start_seq: 1,
});

/**
 * Indexes
 */
CustomerAccountSchema.index({ client: 1, branch: 1, customer: 1 });
CustomerAccountSchema.index({ accountNumber: 1, client: 1 }, { unique: false });

/**
 * Virtuals
 */
CustomerAccountSchema.virtual("displayName").get(function () {
  return this.accountName || `${this.accountType} • ${this.accountNumber}`;
});

module.exports = mongoose.model("CustomerAccount", CustomerAccountSchema);
