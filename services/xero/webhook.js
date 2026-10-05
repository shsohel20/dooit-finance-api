"use strict";

// Xero webhook intake. Xero requires: verify x-xero-signature over the RAW body
// (HMAC-SHA256, base64), answer 200 for valid / 401 for invalid, and answer
// inside 5 seconds — so processing is queued, never done inline.

const crypto = require("crypto");
const XeroConnection = require("../../models/XeroConnection");
const { getConfig } = require("../../config/xero");
const { enqueue } = require("./jobQueue");
const { logSync } = require("./syncLog");

const SUPPORTED = new Set(["CONTACT", "INVOICE", "PAYMENT"]);

/** Constant-time signature check. `rawBody` must be the exact bytes received. */
const verifySignature = (rawBody, signature, key = getConfig().webhookKey) => {
  if (!key || !signature || !rawBody) return false;
  const expected = crypto.createHmac("sha256", key).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Turn a verified payload into queued jobs. Never throws for a single bad
 * event — one malformed entry must not make Xero redeliver the whole batch.
 * @returns {Promise<{ received: number, queued: number }>}
 */
const processPayload = async (payload) => {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  let queued = 0;

  for (const ev of events) {
    const category = String(ev.eventCategory || "").toUpperCase();
    try {
      if (!SUPPORTED.has(category) || !ev.resourceId || !ev.tenantId) {
        await logSync({ tenantId: ev.tenantId || null, entity: "webhook", entityId: ev.resourceId || null, action: "ignore", direction: "inbound", status: "skipped", error: `unsupported event ${category || "?"}` });
        continue;
      }
      const conn = await XeroConnection.findOne({ tenantId: ev.tenantId, status: "connected" }).select("companyId").lean();
      if (!conn) {
        await logSync({ tenantId: ev.tenantId, entity: "webhook", entityId: ev.resourceId, action: "ignore", direction: "inbound", status: "skipped", error: "no connected organisation" });
        continue;
      }
      const { duplicate } = await enqueue("inbound_event", {
        tenantId: ev.tenantId,
        companyId: conn.companyId,
        payload: { category, resourceId: ev.resourceId, eventType: ev.eventType, eventDateUtc: ev.eventDateUtc },
        // Redelivery of the same event collapses into the pending job.
        dedupeKey: `wh:${ev.tenantId}:${category}:${ev.resourceId}:${ev.eventDateUtc || ""}`,
      });
      if (!duplicate) queued += 1;
      await logSync({ tenantId: ev.tenantId, companyId: conn.companyId, entity: "webhook", entityId: ev.resourceId, action: duplicate ? "duplicate" : "queued", direction: "inbound", status: duplicate ? "skipped" : "success" });
    } catch (err) {
      await logSync({ tenantId: ev.tenantId || null, entity: "webhook", entityId: ev.resourceId || null, action: "queue", direction: "inbound", status: "failed", error: err.message });
    }
  }
  return { received: events.length, queued };
};

module.exports = { verifySignature, processPayload };
