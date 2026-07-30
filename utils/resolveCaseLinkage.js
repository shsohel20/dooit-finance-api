// utils/resolveCaseLinkage.js
const mongoose = require("mongoose");

/**
 * Resolve canonical investigation linkage — Case = hub, Alert = provenance —
 * from whatever identifier the UI sends.
 *
 * Background: historically the report/RFI UI sent the *Alert* uid (AL-…) or
 * _id in `caseNumber`/`caseId`, and those fields were `ref: 'Alert'`. Reports
 * now reference the **Case** (see docs/66-CORE-ENTITY-LINKING-ROADMAP.md), so
 * this helper accepts the legacy identifiers, finds the Alert, and derives the
 * owning Case from `Alert.linkedCase`. It also accepts a real Case uid/_id, so
 * callers can migrate without breaking older clients.
 *
 * Requires inside the function to avoid model load-order / circular deps.
 *
 * @param {Object}  input
 * @param {string=} input.caseNumber  Alert.uid (AL-…) or Case.uid (CA-…)
 * @param {string=} input.caseId      ObjectId of an Alert (legacy) or a Case
 * @param {string=} input.alertId     explicit Alert ObjectId (wins if present)
 * @returns {Promise<{caseId: (ObjectId|null), alert: (ObjectId|null),
 *   customer: (ObjectId|null), client: (ObjectId|null), branch: (ObjectId|null),
 *   caseNumber: (string|null), alertDoc: (Object|null), caseDoc: (Object|null)}>}
 */
async function resolveCaseLinkage(input = {}) {
  const Alert = require("../models/Alert");
  const Case = require("../models/Case");

  const { caseNumber, caseId, alertId } = input;
  const isObjId = (v) => v != null && mongoose.Types.ObjectId.isValid(String(v));

  let alertDoc = null;
  let caseDoc = null;

  // 1) Explicit alert id wins.
  if (isObjId(alertId)) alertDoc = await Alert.findById(alertId);

  // 2) Generic ref may be a Case OR an Alert, by uid or by _id.
  const ref = caseId != null ? caseId : caseNumber;
  if (!alertDoc && ref != null) {
    const s = String(ref);
    if (/^CA-/i.test(s)) {
      caseDoc = await Case.findOne({ uid: s });
    } else if (/^AL-/i.test(s)) {
      alertDoc = await Alert.findOne({ uid: s });
    } else if (isObjId(s)) {
      // Legacy: the same field used to hold an Alert _id — try Alert first.
      alertDoc = await Alert.findById(s);
      if (!alertDoc) caseDoc = await Case.findById(s);
    } else {
      // Bare string → treat as an Alert uid (legacy default).
      alertDoc = await Alert.findOne({ uid: s });
    }
  }

  // 3) Derive the owning Case from the Alert when not resolved directly.
  if (!caseDoc && alertDoc && alertDoc.linkedCase) {
    caseDoc = await Case.findById(alertDoc.linkedCase);
  }

  const firstLinkedCustomer =
    caseDoc && Array.isArray(caseDoc.linkedCustomers)
      ? caseDoc.linkedCustomers[0]
      : null;

  return {
    caseId: (caseDoc && caseDoc._id) || null,
    alert: (alertDoc && alertDoc._id) || null,
    customer: firstLinkedCustomer || (alertDoc && alertDoc.customer) || null,
    client:
      (caseDoc && caseDoc.client) || (alertDoc && alertDoc.client) || null,
    branch:
      (caseDoc && caseDoc.branch) || (alertDoc && alertDoc.branch) || null,
    caseNumber:
      (caseDoc && caseDoc.uid) ||
      (alertDoc && alertDoc.uid) ||
      (typeof ref === "string" ? ref : null),
    alertDoc,
    caseDoc,
  };
}

/**
 * True if the request body carries any identifier we can resolve linkage from.
 */
function hasLinkageRef(body = {}) {
  return [
    body.caseId, body.case, body.caseNumber,
    body.referenceNumber, body.alert, body.alertId,
  ].some((v) => v != null && v !== "");
}

/**
 * Resolved linkage overrides for an UPDATE, keyed to the model's hub field
 * (`caseId` for ECDD/SMR, `case` for TTR/IFTI/GFS/RFI). Only includes fields
 * that actually resolved, so an unresolvable ref never wipes existing linkage.
 */
async function linkageOverrides(body = {}, hubField = "case") {
  const link = await resolveCaseLinkage({
    caseId: body.caseId != null ? body.caseId : body.case,
    caseNumber: body.caseNumber != null ? body.caseNumber : body.referenceNumber,
    alertId: body.alert != null ? body.alert : body.alertId,
  });
  const out = {};
  if (link.caseId) out[hubField] = link.caseId;
  if (link.alert) out.alert = link.alert;
  if (link.customer) out.customer = link.customer;
  if (link.client) out.client = link.client;
  if (link.branch) out.branch = link.branch;
  return out;
}

module.exports = { resolveCaseLinkage, hasLinkageRef, linkageOverrides };
