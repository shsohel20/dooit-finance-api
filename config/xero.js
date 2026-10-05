"use strict";

// config/xero.js
//
// Single reader of the XERO_* environment. Everything else asks this module
// rather than touching process.env, so tests can change the environment and
// the startup check has one place to look.

const DEFAULT_SCOPES = [
  "offline_access",
  "accounting.contacts",
  "accounting.transactions",
  "accounting.settings",
];

// OpenID Connect scopes added for "Sign up with Xero" (identity + email).
const SIGNUP_IDENTITY_SCOPES = ["openid", "profile", "email"];

const REQUIRED = ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_REDIRECT_URI"];

const env = () => process.env;

const getConfig = () => {
  const e = env();
  const scopes = (e.XERO_SCOPES || "")
    .split(/[\s,]+/)
    .filter(Boolean);
  // offline_access is what makes Xero issue a refresh token — never optional.
  const finalScopes = scopes.length ? scopes : [...DEFAULT_SCOPES];
  if (!finalScopes.includes("offline_access")) finalScopes.unshift("offline_access");

  return {
    clientId: e.XERO_CLIENT_ID || "",
    clientSecret: e.XERO_CLIENT_SECRET || "",
    redirectUri: e.XERO_REDIRECT_URI || "",
    webhookKey: e.XERO_WEBHOOK_KEY || "",
    scopes: finalScopes,
    // Where the browser lands after the OAuth callback (the Settings page).
    postConnectUrl: e.XERO_POST_CONNECT_URL || "",
    // Web page that finishes "Sign up with Xero" (receives ?ticket / ?loginCode / ?error).
    signupUrl: e.XERO_SIGNUP_URL || "",
    // Chart-of-accounts codes Xero needs on invoice lines and payments.
    salesAccountCode: e.XERO_SALES_ACCOUNT_CODE || "200",
    paymentAccountCode: e.XERO_PAYMENT_ACCOUNT_CODE || "",
    syncIntervalMs: (Number(e.XERO_SYNC_INTERVAL_MIN) || 15) * 60 * 1000,
    maxJobAttempts: Number(e.XERO_JOB_MAX_ATTEMPTS) || 5,
    identityUrl: e.XERO_IDENTITY_URL || "https://identity.xero.com",
    loginUrl: e.XERO_LOGIN_URL || "https://login.xero.com",
    apiUrl: e.XERO_API_URL || "https://api.xero.com",
  };
};

/**
 * Validate the configuration. Never throws: a half-configured optional
 * integration must not take the whole API down, it must disable itself loudly.
 *
 * @returns {{ enabled: boolean, errors: string[], warnings: string[] }}
 */
const validateXeroConfig = () => {
  const e = env();
  const present = REQUIRED.filter((k) => e[k]);
  const errors = [];
  const warnings = [];

  if (present.length === 0 && !e.XERO_WEBHOOK_KEY) {
    return { enabled: false, errors, warnings: ["Xero integration disabled (no XERO_* variables set)"] };
  }

  REQUIRED.filter((k) => !e[k]).forEach((k) => errors.push(`${k} is required`));

  if (e.XERO_REDIRECT_URI) {
    try {
      const u = new URL(e.XERO_REDIRECT_URI);
      const local = ["localhost", "127.0.0.1"].includes(u.hostname);
      if (u.protocol !== "https:" && !local) {
        errors.push("XERO_REDIRECT_URI must use https (http is only allowed for localhost)");
      }
    } catch {
      errors.push("XERO_REDIRECT_URI is not a valid URL");
    }
  }

  if (!e.ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(e.ENCRYPTION_KEY)) {
    errors.push("ENCRYPTION_KEY (64 hex chars) is required to encrypt Xero refresh tokens");
  }

  if (!e.XERO_WEBHOOK_KEY) {
    warnings.push("XERO_WEBHOOK_KEY not set — POST /xero/webhook will reject all deliveries");
  }
  if (!e.XERO_PAYMENT_ACCOUNT_CODE) {
    warnings.push("XERO_PAYMENT_ACCOUNT_CODE not set — outbound payments will be skipped");
  }

  return { enabled: errors.length === 0, errors, warnings };
};

const isXeroEnabled = () => validateXeroConfig().enabled;

module.exports = { SIGNUP_IDENTITY_SCOPES, getConfig, validateXeroConfig, isXeroEnabled, DEFAULT_SCOPES };
