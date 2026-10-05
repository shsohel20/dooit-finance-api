"use strict";

// One-time login codes for the Xero entry flows. A code is the only thing the
// browser carries into the web app's NextAuth session: random 256-bit, stored
// as SHA-256, valid two minutes, single use (redeemed in signupService).

const crypto = require("crypto");
const XeroSignup = require("../../models/XeroSignup");
const { sha256 } = require("./oauth");

const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;

const randomToken = () => crypto.randomBytes(32).toString("hex");

/** Attach a fresh login code to an existing XeroSignup row. */
const issueLoginCode = async (signup, { userId, clientId, membershipId }) => {
  const loginCode = randomToken();
  await XeroSignup.updateOne(
    { _id: signup._id },
    {
      $set: {
        loginCodeHash: sha256(loginCode),
        loginCodeExpiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS),
        loginCodeUsed: false,
        userId,
        clientId,
        membershipId,
      },
    }
  );
  return loginCode;
};

/** Issue a login code for a session that has no signup row yet. */
const createLoginSession = async ({ identity, tenant, userId, clientId, membershipId }) => {
  const row = await XeroSignup.create({ identity, tenant });
  return issueLoginCode(row, { userId, clientId, membershipId });
};

module.exports = { randomToken, issueLoginCode, createLoginSession, LOGIN_CODE_TTL_MS };
