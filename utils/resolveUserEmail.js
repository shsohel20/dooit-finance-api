"use strict";

// utils/resolveUserEmail.js
//
// Get a real, sendable email address for a user.
//
// User emails are encrypted at rest by roleEncryptionPlugin, and reads are
// auto-decrypted ONLY when the requesting role holds an active RolePermission
// grant — otherwise the value is masked to "***". That is correct for display,
// and wrong for delivery: whether a client receives their invoice must not
// depend on which operator pressed send.
//
// So the address is resolved the way utils/craReviewNotifications.js already
// resolves it for reminders — read through the NATIVE collection to bypass the
// plugin middleware, then decrypt here. This is a delivery path, not a
// disclosure path: callers send TO the address and must never return it to the
// operator. Use maskEmail() for anything that goes back in a response.

const mongoose = require("mongoose");

/** AES-256-GCM ciphertext format used by roleEncryptionPlugin: iv:tag:data */
function looksEncrypted(val) {
  if (!val || typeof val !== "string") return false;
  const parts = val.split(":");
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

/**
 * Turn a stored email value into a usable address.
 * Returns null when it is missing, undecryptable or not an address — callers
 * must treat null as "cannot deliver" rather than guessing.
 */
function resolveEmail(raw) {
  if (!raw || typeof raw !== "string") return null;
  if (raw === "***") return null; // masked by the plugin; no address to recover
  if (looksEncrypted(raw)) {
    try {
      const { decrypt } = require("./encryption");
      const plain = decrypt(raw);
      return /@/.test(plain) ? plain : null;
    } catch {
      return null; // missing/invalid ENCRYPTION_KEY — skip rather than fail
    }
  }
  return /@/.test(raw) ? raw : null;
}

/**
 * Resolve one user's address by id, bypassing the encryption middleware.
 * @returns {Promise<{ email: string|null, name: string|null }>}
 */
async function resolveUserEmailById(userId) {
  if (!userId) return { email: null, name: null };

  const user = await mongoose
    .model("Users")
    .collection.findOne(
      { _id: new mongoose.Types.ObjectId(String(userId)) },
      { projection: { email: 1, name: 1 } }
    );

  if (!user) return { email: null, name: null };
  return { email: resolveEmail(user.email), name: user.name || null };
}

/**
 * Mask an address for display back to an operator: sarah@coinflip.test →
 * s****@coinflip.test. Enough to confirm where a document went without
 * disclosing an address the caller may not be entitled to read.
 */
function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

module.exports = { looksEncrypted, resolveEmail, resolveUserEmailById, maskEmail };
