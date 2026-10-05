const mongoose = require("mongoose");
const { Schema } = mongoose;

// XeroSignup — the short-lived bridge of "Sign up with Xero".
//
//   callback ──▶ ticket (anonymous visitor, nothing created yet)
//   complete ──▶ account + client + connection created, one-time loginCode issued
//   redeem   ──▶ JWT handed to the web app's NextAuth session
//
// An existing client admin signing in with Xero skips straight to a loginCode.
// Ticket and loginCode are random 256-bit values stored only as SHA-256 hashes;
// the Xero tokens it carries are AES-256-GCM ciphertext and `select: false`.
// The TTL index removes the row an hour after creation whatever its state.

const XeroSignupSchema = new Schema(
  {
    ticketHash: { type: String, unique: true, sparse: true },
    ticketUsed: { type: Boolean, default: false },

    loginCodeHash: { type: String, unique: true, sparse: true },
    loginCodeExpiresAt: { type: Date, default: null },
    loginCodeUsed: { type: Boolean, default: false },

    identity: {
      email: { type: String, lowercase: true, trim: true },
      givenName: String,
      familyName: String,
      xeroUserId: String,
    },
    tenant: {
      tenantId: String,
      connectionId: String,
      tenantName: String,
    },
    // What the registration form is pre-filled with (editable by the user).
    prefill: { type: Schema.Types.Mixed, default: {} },

    accessToken: { type: String, select: false },
    refreshToken: { type: String, select: false },
    tokenExpiresAt: Date,
    scopes: { type: [String], default: [] },

    // Set once the account exists (new or pre-existing).
    userId: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    clientId: { type: Schema.Types.ObjectId, ref: "Client", default: null },
    membershipId: { type: Schema.Types.ObjectId, ref: "UserType", default: null },

    createdAt: { type: Date, default: Date.now, expires: 3600 },
  },
  { versionKey: false }
);

module.exports = mongoose.models.XeroSignup || mongoose.model("XeroSignup", XeroSignupSchema);
