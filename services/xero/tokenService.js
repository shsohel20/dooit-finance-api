"use strict";

// Access/refresh token lifecycle for a XeroConnection.
//
// Xero refresh tokens are SINGLE USE: each refresh returns a new one and the
// old one dies (after a 30 min grace). So refreshes for one connection must be
// serialised — in-process by a promise map, across instances by a compare-and-
// swap on the stored ciphertext. The loser of a cross-instance race simply
// re-reads the winner's fresh access token.

const XeroConnection = require("../../models/XeroConnection");
const ErrorResponse = require("../../utils/errorResponse");
const { encrypt, decrypt } = require("../../utils/encryption");
const oauth = require("./oauth");
const { logSync } = require("./syncLog");

const EXPIRY_SKEW_MS = 60 * 1000;

const memoryCache = new Map(); // connectionId -> { token, expiresAt }
const inFlight = new Map(); // connectionId -> Promise<string>

const clearCache = (id) => {
  memoryCache.delete(String(id));
  inFlight.delete(String(id));
};

const loadWithSecrets = (id) =>
  XeroConnection.findById(id).select("+accessToken +refreshToken");

const isFresh = (expiresAt) =>
  expiresAt && new Date(expiresAt).getTime() - Date.now() > EXPIRY_SKEW_MS;

/** Store a token set: refresh token rotated + encrypted, expiry recalculated. */
const persistTokens = async (conn, tokens, previousCipher) => {
  const filter = { _id: conn._id };
  // CAS only when we are rotating an existing refresh token.
  if (previousCipher) filter.refreshToken = previousCipher;
  const res = await XeroConnection.updateOne(filter, {
    $set: {
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      ...(tokens.scopes?.length ? { scopes: tokens.scopes } : {}),
      status: "connected",
      lastSyncError: null,
    },
  });
  return res.modifiedCount === 1;
};

const markRevoked = async (conn, reason) => {
  await XeroConnection.updateOne(
    { _id: conn._id },
    {
      $set: {
        status: "revoked",
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        lastSyncStatus: "failed",
        lastSyncError: reason,
      },
    }
  );
  clearCache(conn._id);
  await logSync({
    tenantId: conn.tenantId,
    companyId: conn.companyId,
    entity: "connection",
    action: "revoked",
    status: "failed",
    error: reason,
  });
};

const doRefresh = async (connectionId) => {
  const conn = await loadWithSecrets(connectionId);
  if (!conn || conn.status === "disconnected") {
    throw new ErrorResponse("Xero is not connected", 409);
  }
  if (!conn.refreshToken) {
    throw new ErrorResponse("Xero authorisation is missing — please reconnect", 401);
  }

  const usedCipher = conn.refreshToken;
  const { status, data } = await oauth.tokenRequest({
    grant_type: "refresh_token",
    refresh_token: decrypt(usedCipher),
  });

  if (status === 200 && data.access_token && data.refresh_token) {
    const tokens = oauth.normaliseTokens(data);
    const won = await persistTokens(conn, tokens, usedCipher);
    if (!won) {
      // Another instance rotated first — use what it stored.
      const latest = await loadWithSecrets(connectionId);
      if (latest?.accessToken && isFresh(latest.expiresAt)) {
        memoryCache.set(String(connectionId), {
          token: decrypt(latest.accessToken),
          expiresAt: latest.expiresAt,
        });
        return decrypt(latest.accessToken);
      }
    }
    memoryCache.set(String(connectionId), {
      token: tokens.accessToken,
      expiresAt: tokens.expiresAt,
    });
    await logSync({
      tenantId: conn.tenantId,
      companyId: conn.companyId,
      entity: "connection",
      action: "refresh",
      status: "success",
    });
    return tokens.accessToken;
  }

  if (data.error === "invalid_grant") {
    // Maybe a concurrent instance already rotated this token.
    const latest = await loadWithSecrets(connectionId);
    if (latest?.refreshToken && latest.refreshToken !== usedCipher && latest.accessToken) {
      return decrypt(latest.accessToken);
    }
    await markRevoked(conn, "Xero access was revoked or the refresh token expired");
    throw new ErrorResponse("Xero access has been revoked or expired — please reconnect", 401);
  }

  await logSync({
    tenantId: conn.tenantId,
    companyId: conn.companyId,
    entity: "connection",
    action: "refresh",
    status: "failed",
    error: `token endpoint ${status} ${data.error || ""}`.trim(),
  });
  throw new ErrorResponse("Could not refresh the Xero access token", 502);
};

/** Force a refresh (serialised per connection). Resolves to the new access token. */
const refreshAccessToken = (connectionId) => {
  const key = String(connectionId);
  if (inFlight.has(key)) return inFlight.get(key);
  memoryCache.delete(key);
  const p = doRefresh(key).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
};

/** Return a valid access token, refreshing when it is near expiry. */
const getAccessToken = async (connectionId) => {
  const key = String(connectionId);
  const cached = memoryCache.get(key);
  if (cached && isFresh(cached.expiresAt)) return cached.token;

  const conn = await loadWithSecrets(key);
  if (!conn || conn.status === "disconnected") {
    throw new ErrorResponse("Xero is not connected", 409);
  }
  if (conn.status === "revoked") {
    throw new ErrorResponse("Xero access has been revoked — please reconnect", 401);
  }
  if (conn.accessToken && isFresh(conn.expiresAt)) {
    const token = decrypt(conn.accessToken);
    memoryCache.set(key, { token, expiresAt: conn.expiresAt });
    return token;
  }
  return refreshAccessToken(key);
};

module.exports = {
  getAccessToken,
  refreshAccessToken,
  persistTokens,
  clearCache,
  markRevoked,
};
