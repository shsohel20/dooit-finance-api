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
  userId: { type: Schema.Types.ObjectId, ref: "Users", required: true },
  companyId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 },
});

module.exports =
  mongoose.models.XeroOAuthState ||
  mongoose.model("XeroOAuthState", XeroOAuthStateSchema);
