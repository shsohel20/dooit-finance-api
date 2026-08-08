"use strict";

/**
 * KYB compliance audit writer (docs/65 Step 31) — mirrors utils/craAudit.js.
 *
 * Writes to the shared AuditLog collection with service "kyb":
 *   • KYB_CREATED          — afterValue: the whitelisted create payload
 *   • KYB_UPDATED          — before/after snapshots of the changed registers only
 *   • KYB_REVIEW_<STATUS>  — review-status transitions (approved/escalated/…)
 *   • KYB_DOCUMENT_ADDED / KYB_DOCUMENT_REMOVED
 *
 * Never throws — an audit write failure must not break the compliance action
 * itself; it is logged to the console instead.
 */

const AuditLog = require("../models/AuditLog");
const { auditContext } = require("./auditContext");

/**
 * logKybEvent({ req, company, action, before, after, target })
 *  req            — Express request (actor taken from req.user)
 *  company        — CompanyKyc doc (or plain object with _id / customer)
 *  action         — e.g. KYB_CREATED, KYB_UPDATED, KYB_REVIEW_APPROVED
 *  before / after — JSON snapshots of the changed values
 */
async function logKybEvent({
  req = {},
  company = {},
  action,
  before = null,
  after = null,
  target = "",
}) {
  try {
    const user = req.user || {};
    await AuditLog.create({
      service: "kyb",
      action,
      status: "success",
      target,

      companyKyc: company._id || null,
      customer: company.customer || null,
      client: user.client?._id || user.clientBelongs || null,
      branch: user.branch?._id || user.branchBelongs || null,

      actor: user._id || user.id || null,
      actorName: user.name || "system",
      actorRole: user.role || "system",

      beforeValue: before,
      afterValue: after,

      ...auditContext(req.headers ? req : undefined),
    });
  } catch (err) {
    console.error(`KYB audit write failed (${action}):`, err.message);
  }
}

module.exports = { logKybEvent };
