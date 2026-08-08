"use strict";

/**
 * Canonical audit writer for the whole API (docs/71).
 *
 * One call per state-changing operation:
 *
 *   const { logEvent } = require("../utils/audit");
 *   logEvent({ req, service: "report", action: "smr_submitted",
 *              reportType: "SMR", target: smr.uid,
 *              beforeValue: { status: from }, afterValue: { status: to } });
 *
 * - Actor + tenant default from req.user; pass user/client/branch explicitly
 *   to override (e.g. the target user of an admin action goes in `user`,
 *   the acting admin is implied by actor fields or details).
 * - Device/network context (ip, userAgent, deviceId) is stamped automatically.
 * - Never throws and is NOT awaited by convention — an audit failure must not
 *   fail the operation. Await it only when a test needs the row.
 *
 * Services: case, cra, kyb, sumsub, auth, device, privacy, billing,
 *           transaction, report, alert, kyc, onboarding, rule, file.
 */

const AuditLog = require("../models/AuditLog");
const { auditContext } = require("./auditContext");

const logEvent = ({ req, service, action, status = "success", ...fields }) => {
  const u = req?.user || {};
  return AuditLog.create({
    service,
    action,
    status,
    user: u._id ?? u.id ?? null,
    actor: u._id ?? u.id ?? null,
    actorName: u.name ?? null,
    actorRole: u.role ?? null,
    client: u.client?._id ?? u.clientBelongs ?? null,
    branch: u.branch?._id ?? u.branchBelongs ?? null,
    ...fields, // explicit fields win over the defaults above
    ...auditContext(req),
  }).catch((err) =>
    console.error(`audit write failed (${service}/${action}):`, err.message)
  );
};

module.exports = { logEvent };
