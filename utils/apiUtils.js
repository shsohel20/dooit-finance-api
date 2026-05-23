/**
 * utils/apiUtils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic HTTP / third-party API helpers.
 * Framework-agnostic — no Express dependency.
 *
 * Exports:
 *   extractUpstreamMessage(body)    — human-readable error string from any response body
 *   isTransientNetworkError(err)    — true for connection/timeout errors worth a 503
 *   parseApiResponseData(data)      — normalise string|object response data → plain object
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

/**
 * extractUpstreamMessage — extract a human-readable error string from
 * various upstream API response body shapes.
 *
 * Handles: plain string, { error }, { detail }, { message }, { msg },
 * { errors: string[] }, { errors: [{ msg }] }
 *
 * @param {*} body — parsed response body (string | object | array | null)
 * @returns {string}
 */
const extractUpstreamMessage = (body) => {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body !== "object") return String(body);

  const candidate =
    body.error || body.detail || body.message || body.msg || body.errors || null;

  if (!candidate) return "";
  if (typeof candidate === "string") return candidate;
  if (Array.isArray(candidate)) {
    return candidate
      .map((c) =>
        typeof c === "string"
          ? c
          : c?.msg || c?.message || c?.detail || JSON.stringify(c),
      )
      .join("; ");
  }
  if (typeof candidate === "object") {
    return candidate.msg || candidate.message || JSON.stringify(candidate);
  }
  return String(candidate);
};

/**
 * isTransientNetworkError — returns true when an axios error represents a
 * transient network condition (connection refused, timeout, DNS failure, etc.)
 * that warrants a 503 response rather than a 502.
 *
 * @param {Error} err — axios error object
 * @returns {boolean}
 */
const TRANSIENT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNRESET",
]);

const isTransientNetworkError = (err) =>
  !err?.response && TRANSIENT_CODES.has(err?.code);

/**
 * parseApiResponseData — normalise response.data from axios into a plain
 * object.  Handles the case where the body arrives as a JSON string (some
 * proxies/APIs do this) and falls back to { raw: <string> } on parse failure.
 *
 * @param {string|object|null} data — response.data from axios
 * @returns {object}
 */
const parseApiResponseData = (data) => {
  if (data === null || data === undefined) return {};
  if (typeof data !== "string") return data || {};
  try {
    return JSON.parse(data);
  } catch (_) {
    return { raw: data };
  }
};

module.exports = {
  extractUpstreamMessage,
  isTransientNetworkError,
  parseApiResponseData,
};
