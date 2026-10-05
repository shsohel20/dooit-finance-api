"use strict";

const crypto = require("crypto");
const XeroSyncLog = require("../../models/XeroSyncLog");

/** Stable SHA-256 of a payload (keys sorted) — used for change detection. */
const hashPayload = (payload) => {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.keys(v)
        .sort()
        .reduce((o, k) => ((o[k] = canon(v[k])), o), {});
    }
    return v;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canon(payload))).digest("hex");
};

/**
 * Append a sync-log row. Logging must never break the operation being logged,
 * so failures are swallowed (and reported to the console).
 */
const logSync = async ({
  tenantId = null,
  companyId = null,
  entity,
  entityId = null,
  action,
  direction = "system",
  status,
  error = null,
  payload,
  payloadHash = null,
  actor = null,
}) => {
  try {
    await XeroSyncLog.create({
      tenantId,
      companyId,
      entity,
      entityId: entityId == null ? null : String(entityId),
      action,
      direction,
      status,
      error: error ? String(error).slice(0, 1000) : null,
      payloadHash: payloadHash || (payload !== undefined ? hashPayload(payload) : null),
      actor,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error("[xero] failed to write sync log:", err.message);
  }
};

module.exports = { logSync, hashPayload };
