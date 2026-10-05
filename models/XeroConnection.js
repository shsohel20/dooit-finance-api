const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// XeroConnection — one authorised Xero organisation for one Dooit company.
//
// `refreshToken` is stored ONLY as AES-256-GCM ciphertext (utils/encryption) and
// is `select: false`, so a stray find() never carries it. `accessToken` is a
// short-lived cache (30 min at Xero) kept so a burst of API calls does not hit
// the token endpoint each time; it is likewise ciphertext + select:false.
// toJSON strips both, so no API response can leak them.
// ─────────────────────────────────────────────────────────────────────────────

const XERO_CONNECTION_STATUS = ["connected", "disconnected", "revoked", "error"];

const XeroConnectionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "Users", required: true, index: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Client", required: true },

    tenantId: { type: String, required: true, trim: true },
    // Xero's id for the *connection* (needed to DELETE /connections/{id}).
    connectionId: { type: String, trim: true, default: null },
    tenantName: { type: String, trim: true, default: null },

    accessToken: { type: String, select: false, default: null },
    refreshToken: { type: String, select: false, default: null },
    expiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },

    connectedAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
    status: { type: String, enum: XERO_CONNECTION_STATUS, default: "connected", index: true },

    // Sync bookkeeping surfaced in Settings.
    lastSyncAt: { type: Date, default: null },
    lastSyncStatus: { type: String, enum: ["idle", "running", "success", "partial", "failed"], default: "idle" },
    lastSyncError: { type: String, default: null },
    lastSyncSummary: { type: Schema.Types.Mixed, default: null },
    // High-water mark for incremental outbound sync.
    outboundCursor: { type: Date, default: null },
    inboundCursor: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.accessToken;
        delete ret.refreshToken;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// One live connection per company, one live company per Xero org.
XeroConnectionSchema.index(
  { companyId: 1 },
  { unique: true, partialFilterExpression: { status: "connected" } }
);
XeroConnectionSchema.index(
  { tenantId: 1 },
  { unique: true, partialFilterExpression: { status: "connected" } }
);

module.exports =
  mongoose.models.XeroConnection ||
  mongoose.model("XeroConnection", XeroConnectionSchema);
module.exports.XERO_CONNECTION_STATUS = XERO_CONNECTION_STATUS;
