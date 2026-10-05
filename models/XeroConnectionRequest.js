const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// XeroConnectionRequest — "someone at Xero wants to connect this organisation
// to an EXISTING Dooit client; the client must say yes first."
//
// This is the security boundary of the Xero marketplace flow: a Xero identity
// (or knowing an organisation's name) never grants access to an existing
// client. Only the client's own administrator approving a request does.
//
// Two independent secrets, both random 256-bit values stored ONLY as SHA-256:
//   tokenHash           — emailed to the client's registered address (approver)
//   requesterTokenHash  — held by the Xero user's browser (status / continue)
//
// The Xero tokens needed to finish the link are AES-256-GCM ciphertext,
// `select:false`, and removed as soon as the request reaches a final state.
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST_STATUS = {
  PENDING: "PENDING_CONFIRMATION",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
};

const XeroConnectionRequestSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true, index: true },

    xeroTenantId: { type: String, required: true },
    xeroConnectionId: { type: String, default: null },
    xeroOrganisationName: { type: String, trim: true },

    requesterEmail: { type: String, lowercase: true, trim: true, required: true },
    requesterName: { type: String, trim: true },
    requesterXeroUserId: { type: String, default: null },

    // Where the approval email went (the client's registered address).
    targetEmail: { type: String, lowercase: true, trim: true, required: true },
    // How the client was identified — tenant is authoritative; the others are
    // best-effort and only ever lead to an email, never to access.
    matchedBy: { type: String, enum: ["tenant", "registrationNumber", "name"], required: true },

    status: {
      type: String,
      enum: Object.values(REQUEST_STATUS),
      default: REQUEST_STATUS.PENDING,
      index: true,
    },

    tokenHash: { type: String, required: true, unique: true, select: false },
    requesterTokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },

    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    emailSentAt: { type: Date, default: null },
    // Once the approved requester has continued into the app (single use).
    continuedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },

    accessToken: { type: String, select: false },
    refreshToken: { type: String, select: false },
    scopes: { type: [String], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ["tokenHash", "requesterTokenHash", "accessToken", "refreshToken", "__v"].forEach((k) => delete ret[k]);
        return ret;
      },
    },
  }
);

// At most one live request per (client, organisation) — repeated attempts reuse
// or supersede it instead of piling up approval emails.
XeroConnectionRequestSchema.index(
  { clientId: 1, xeroTenantId: 1 },
  { unique: true, partialFilterExpression: { status: REQUEST_STATUS.PENDING } }
);
XeroConnectionRequestSchema.index({ status: 1, expiresAt: 1 }); // expiry sweep
XeroConnectionRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports =
  mongoose.models.XeroConnectionRequest ||
  mongoose.model("XeroConnectionRequest", XeroConnectionRequestSchema);
module.exports.REQUEST_STATUS = REQUEST_STATUS;
