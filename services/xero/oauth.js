"use strict";

// OAuth2 authorization-code flow against Xero's identity server.

const crypto = require("crypto");
const XeroOAuthState = require("../../models/XeroOAuthState");
const ErrorResponse = require("../../utils/errorResponse");
const { getConfig } = require("../../config/xero");
const http = require("./http");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const basicAuth = ({ clientId, clientSecret }) =>
  `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

/** Create + persist a one-time state bound to this user and company. */
const createState = async (userId, companyId) => {
  const state = crypto.randomBytes(32).toString("hex");
  await XeroOAuthState.create({ stateHash: sha256(state), userId, companyId });
  return state;
};

/** Atomically consume a state. Returns the stored row, or null if unknown/expired/replayed. */
const consumeState = async (state) => {
  if (!state || typeof state !== "string" || state.length > 256) return null;
  return XeroOAuthState.findOneAndDelete({ stateHash: sha256(state) }).lean();
};

const buildAuthUrl = (state) => {
  const cfg = getConfig();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(" "),
    state,
  });
  return `${cfg.loginUrl}/identity/connect/authorize?${params.toString()}`;
};

/** POST to the token endpoint. Returns { status, data }. */
const tokenRequest = async (form) => {
  const cfg = getConfig();
  const res = await http.send({
    method: "POST",
    url: `${cfg.identityUrl}/connect/token`,
    headers: {
      Authorization: basicAuth(cfg),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    data: new URLSearchParams(form).toString(),
  });
  return { status: res.status, data: res.data || {} };
};

const normaliseTokens = (data) => ({
  accessToken: data.access_token,
  refreshToken: data.refresh_token,
  expiresAt: new Date(Date.now() + (Number(data.expires_in) || 1800) * 1000),
  scopes: typeof data.scope === "string" ? data.scope.split(" ").filter(Boolean) : [],
});

const exchangeCode = async (code) => {
  const cfg = getConfig();
  const { status, data } = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });
  if (status !== 200 || !data.access_token || !data.refresh_token) {
    throw new ErrorResponse(
      `Xero rejected the authorization code${data.error ? ` (${data.error})` : ""}`,
      400
    );
  }
  return normaliseTokens(data);
};

/** Organisations the user authorised for this app. */
const fetchConnections = async (accessToken) => {
  const cfg = getConfig();
  const res = await http.send({
    method: "GET",
    url: `${cfg.apiUrl}/connections`,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (res.status !== 200 || !Array.isArray(res.data)) {
    throw new ErrorResponse("Could not list Xero organisations", 502);
  }
  return res.data.filter((c) => !c.tenantType || c.tenantType === "ORGANISATION");
};

/** Pick the organisation that was just authorised (most recently updated). */
const pickNewestTenant = (connections) =>
  [...connections].sort(
    (a, b) =>
      new Date(b.updatedDateUtc || b.createdDateUtc || 0) -
      new Date(a.updatedDateUtc || a.createdDateUtc || 0)
  )[0] || null;

module.exports = {
  createState,
  consumeState,
  buildAuthUrl,
  tokenRequest,
  normaliseTokens,
  exchangeCode,
  fetchConnections,
  pickNewestTenant,
  sha256,
};
