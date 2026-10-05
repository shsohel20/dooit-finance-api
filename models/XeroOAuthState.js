const mongoose = require("mongoose");
const { Schema } = mongoose;

// XeroOAuthState — one-time CSRF state for the OAuth round-trip.
//
// The callback is a bare browser redirect with no Authorization header, so the
// state is what ties it back to the user + company that started the flow. Only
// a SHA-256 of the state is stored; it is consumed (deleted) on first use and
// expires after 10 minutes via the TTL index.

const XeroOAuthStateSchema = new Schema({
  stateHash: { type: String, required: true, unique: true },
  // "connect": an authenticated user linking Xero (userId + companyId set).
  // "signup":  an anonymous visitor signing up with Xero (neither is known yet).
  purpose: { type: String, enum: ["connect", "signup"], default: "connect" },
  userId: { type: Schema.Types.ObjectId, ref: "Users" },
  companyId: { type: Schema.Types.ObjectId, ref: "Client" },
  // OIDC nonce — must come back inside the id_token (signup only).
  nonce: { type: String },
  createdAt: { type: Date, default: Date.now, expires: 600 },
});

module.exports =
  mongoose.models.XeroOAuthState ||
  mongoose.model("XeroOAuthState", XeroOAuthStateSchema);
