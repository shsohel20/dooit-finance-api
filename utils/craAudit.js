"use strict";

/**
 * CRA compliance audit writer — CRA_Scoring_Method.md Section 4:
 * "Every CRA score change, status change, ECDD decision: creates audit_log
 *  entry with {timestamp, actor_name, actor_role, action_type, before_value,
 *  after_value, linked_matter_id}."
 *
 * Writes to the shared AuditLog collection with service "cra".
 * Never throws — an audit write failure must not break the compliance action
 * itself; it is logged to the console instead.
 */

const AuditLog = require("../models/AuditLog");
const { auditContext } = require("./auditContext");

/**
 * logCraEvent({ req, assessment, action, before, after, target, linkedMatterId })
 *  req            — Express request (actor taken from req.user)
 *  assessment     — IndividualRiskAssessment doc (or plain object with _id)
 *  action         — e.g. CRA_CREATED, CRA_RISK_UPDATED, CRA_NOTES_UPDATED,
 *                   ECDD_APPROVED, ECDD_DECLINED, ESCALATION_RAISED
 *  before / after — JSON snapshots of the changed values
 */
async function logCraEvent({
  req = {},
  assessment = {},
  action,
  before = null,
  after = null,
  target = "",
  linkedMatterId = "",
}) {
  try {
    const user = req.user || {};
    await AuditLog.create({
      service: "cra",
      action,
      status: "success",
      target,

      assessment: assessment._id || null,
      customer: assessment.customer || null,
      client: assessment.client || user.client?._id || null,
      branch: assessment.branch || user.branch?._id || null,

      actor: user._id || user.id || null,
      actorName: user.name || "system",
      actorRole: user.role || "system",

      beforeValue: before,
      afterValue: after,
      linkedMatterId,

      ...auditContext(req.headers ? req : undefined),
    });
  } catch (err) {
    console.error(`CRA audit write failed (${action}):`, err.message);
  }
}

module.exports = { logCraEvent };
