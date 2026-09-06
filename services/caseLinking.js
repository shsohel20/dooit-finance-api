// services/caseLinking.js
//
// One home for "what happens to a Case when alerts or customers (POIs) are
// linked or unlinked". Before this file every entry point did its own partial
// version: escalateAlertToCase pulled the alert's customer + transaction,
// linkAlerts pulled nothing, createCase averaged the risk score and escalate
// copied it. docs/74 §6.1 (phase C1); closes doc 66 G11–G13 and doc 74 C1/C2/C10.
//
// Rules implemented here
//   • Linking an alert also links its customer, its transaction, and every
//     customer that is a party (sender / receiver / beneficiary / intermediary)
//     on that transaction — they are persons of interest (POIs) on the case.
//   • Case risk is DERIVED from its linked alerts: riskScore = the highest
//     alert score, riskLabel = that alert's label, caseType = the most common
//     alert caseType (only filled when the case has none yet), priority is
//     raised to match the label but never lowered (an analyst's bump sticks).
//   • Unlinking an alert drops its transaction only when no remaining alert
//     still points at it. POIs are never removed implicitly — use
//     removeCustomerFromCase, which refuses to remove the primary POI.
//   • The primary POI (`Case.customer`) is set once — the first customer that
//     arrives — and is never re-pointed by these helpers.
//
// Every function takes a HYDRATED Case document (not .lean()) so it can save
// it. Alerts may be lean objects or documents; ids may be strings, ObjectIds
// or populated objects — `idStr` normalises all of them.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const Alert = require('../models/Alert');
const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');
const ErrorResponse = require('../utils/errorResponse');
const { auditContext } = require('../utils/auditContext');
const { linkTransactionsToCase, unlinkTransactionsFromCase } = require('../utils/transactionCaseLink');
const {
  normalizeRiskLabel,
  normalizeCaseType,
  priorityForRiskLabel,
} = require('../models/schemas/riskShared');

// The four party slots on a Transaction that can reference a Customer.
const PARTY_PATHS = ['sender', 'receiver', 'beneficiary', 'intermediary'];

// Used to decide whether a derived priority is "higher" than the current one.
const PRIORITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

// ── Small id helpers ────────────────────────────────────────────────────────

/** ObjectId | string | populated doc | null → string id (or null). */
const idStr = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

/** De-duplicated list of string ids, blanks removed, order preserved. */
const uniqueIds = (list = []) => [...new Set(list.map(idStr).filter(Boolean))];

/** True when `list` (ObjectIds / docs) already contains id `id`. */
const includesId = (list = [], id) => list.some((x) => idStr(x) === idStr(id));

// ── Shared populate for every case response ─────────────────────────────────
// Moved here from caseController so alertController can return the same shape
// after an escalate / attach.

const populateCase = (query) =>
  query
    // The cached analysis blob can run to thousands of rows — it is served by
    // GET /cases/:id/analysis, never inlined in a case response.
    .select('-analysis.snapshot')
    .populate('createdBy', 'name email avatar')
    .populate('assignedTo', 'name email avatar')
    .populate('reviewer', 'name email avatar')
    .populate('watchers', 'name email avatar')
    // ruleId/ruleName/explanation drive the "Alert Type" and "Detection Rule"
    // stats on the case detail page.
    .populate(
      'linkedAlerts',
      'uid caseType riskScore riskLabel status createdAt ruleId ruleName explanation alertOrigin customer transaction'
    )
    .populate({
      // Primary customer (POI) — same shape as linkedCustomers below.
      path: 'customer',
      select: 'uid user personalKyc relations kycStatus isPep sanction country',
      populate: { path: 'user', select: 'name email photoUrl avatar' },
    })
    .populate({
      // kycStatus/isPep/sanction/country back the customer-profile screening
      // badges. Encrypted fields (name, phone) are deliberately excluded — a
      // lean() query bypasses decryptForRole and would return ciphertext.
      path: 'linkedCustomers',
      select: 'uid user personalKyc relations kycStatus isPep sanction country',
      populate: { path: 'user', select: 'name email photoUrl avatar' },
    })
    .populate(
      'linkedTransactions',
      'uid amount currency convertedAmountAUD type status timestamp sender receiver riskScore riskFlags channel'
    );

// ── Audit row on the case (same shape caseController writes) ───────────────

const audit = (caseDoc, user, action, details, req) =>
  AuditLog.create({
    case: caseDoc._id,
    user: user?._id || null,
    action,
    details,
    client: caseDoc.client || null,
    branch: caseDoc.branch || null,
    ...auditContext(req),
  });

const actorName = (user) => user?.name || (user?._id ? String(user._id) : 'system');

// ── Pull-through: customers that are parties on transactions ────────────────

/**
 * Every Customer referenced as a party on the given transactions.
 * @param {Array} transactionIds
 * @returns {Promise<string[]>} unique customer ids
 */
async function partyCustomersOf(transactionIds = []) {
  const ids = uniqueIds(transactionIds);
  if (!ids.length) return [];

  const txns = await Transaction.find({ _id: { $in: ids } })
    .select(PARTY_PATHS.map((p) => `${p}.customer`).join(' '))
    .lean({ autopopulate: false });

  const customers = [];
  for (const t of txns) {
    for (const p of PARTY_PATHS) {
      if (t[p] && t[p].customer) customers.push(t[p].customer);
    }
  }
  return uniqueIds(customers);
}

// ── Risk derivation ─────────────────────────────────────────────────────────

/**
 * Derive a case's risk from its alerts. Pure — no DB access.
 * @param {Array} alerts  alert docs with riskScore / riskLabel / caseType
 * @returns {{riskScore:number, riskLabel:string, caseType:string|null, priority:string}|null}
 */
function deriveCaseRisk(alerts = []) {
  const scored = alerts.filter((a) => a && a.riskScore != null);
  if (!scored.length) return null;

  // The top-scoring alert sets the case's score and label.
  const top = scored.reduce((best, a) => (a.riskScore > best.riskScore ? a : best), scored[0]);
  const riskLabel = normalizeRiskLabel(top.riskLabel);

  // The most common alert caseType becomes the case's domain.
  const counts = {};
  for (const a of alerts) {
    if (a && a.caseType) counts[a.caseType] = (counts[a.caseType] || 0) + 1;
  }
  const mostCommon = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0] || null;

  return {
    riskScore: top.riskScore,
    riskLabel,
    caseType: mostCommon ? normalizeCaseType(mostCommon) : null,
    priority: priorityForRiskLabel(riskLabel),
  };
}

/**
 * Write the derived risk onto a case document (does not save).
 * Priority is only ever raised; caseType is only filled when empty.
 */
function applyDerivedRisk(caseDoc, alerts = []) {
  const derived = deriveCaseRisk(alerts);
  if (!derived) return null;

  caseDoc.riskScore = derived.riskScore;
  caseDoc.riskLabel = derived.riskLabel;
  if (!caseDoc.caseType && derived.caseType) caseDoc.caseType = derived.caseType;

  const current = PRIORITY_RANK[caseDoc.priority] ?? PRIORITY_RANK.medium;
  if (PRIORITY_RANK[derived.priority] > current) caseDoc.priority = derived.priority;

  return derived;
}

/** Re-read every linked alert and re-derive the case's risk (does not save). */
async function rederiveRisk(caseDoc) {
  if (!caseDoc.linkedAlerts.length) return null;
  const alerts = await Alert.find({ _id: { $in: caseDoc.linkedAlerts }, isDeleted: { $ne: true } })
    .select('riskScore riskLabel caseType')
    .lean();
  return applyDerivedRisk(caseDoc, alerts);
}

// ── Finding the POI's open case ─────────────────────────────────────────────

/** Compact shape for "attach to this case?" choices in the UI. */
const summarizeCase = (c) => ({
  _id: c._id,
  uid: c.uid,
  title: c.title,
  status: c.status,
  priority: c.priority,
  caseType: c.caseType,
  riskLabel: c.riskLabel,
  alertCount: (c.linkedAlerts || []).length,
  poiCount: (c.linkedCustomers || []).length,
  createdAt: c.createdAt,
});

/**
 * Open (not closed, not deleted) cases in the tenant where this customer is a
 * POI — newest first. Used by escalate-or-attach and the escalate dialog.
 */
async function listAttachableCases({ customerId, tenant = {}, limit = 5 } = {}) {
  const cid = idStr(customerId);
  if (!cid) return [];

  const filter = {
    isDeleted: { $ne: true },
    status: { $ne: 'closed' },
    $or: [{ customer: cid }, { linkedCustomers: cid }],
  };
  if (tenant.client) filter.client = tenant.client;

  const cases = await Case.find(filter)
    .select('uid title status priority caseType riskLabel linkedAlerts linkedCustomers createdAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return cases.map(summarizeCase);
}

/** The single best case to attach to (newest open case of the POI), hydrated. */
async function findAttachableCase({ customerId, tenant = {} } = {}) {
  const [first] = await listAttachableCases({ customerId, tenant, limit: 1 });
  return first ? Case.findById(first._id) : null;
}

// ── Linking alerts ──────────────────────────────────────────────────────────

/**
 * Link alerts to a case and pull their entities through.
 *
 * Caller has already checked tenancy and that none of the alerts belongs to a
 * different case. Alerts already on this case are skipped.
 *
 * @param {Object} caseDoc        hydrated Case
 * @param {Array}  alerts         alert docs (lean or hydrated)
 * @param {Object} opts           { user, req, activityTitle }
 * @returns {Promise<{addedAlertIds:string[], addedCustomerIds:string[], addedTransactionIds:string[]}>}
 */
async function attachAlertsToCase(caseDoc, alerts = [], { user, req, activityTitle = 'Linked to case' } = {}) {
  const fresh = alerts.filter((a) => a && !includesId(caseDoc.linkedAlerts, a._id));
  const empty = { addedAlertIds: [], addedCustomerIds: [], addedTransactionIds: [] };
  if (!fresh.length) return empty;

  // ── Tenancy integrity ───────────────────────────────────────────────────
  // A case must never hold another client's alert: its analysis, its reports
  // and its filings all speak for one reporting entity. The controllers filter
  // by the caller's own tenant, which stops a client user — but an admin has no
  // tenant of their own, so the check has to live here (docs/74 C15).
  //
  // Branch follows the convention used across this codebase: it only narrows
  // when BOTH sides carry one, so a branch-less alert still belongs to any
  // branch of its client.
  const foreign = fresh.filter((a) => {
    const sameClient =
      !idStr(a.client) || !idStr(caseDoc.client) || idStr(a.client) === idStr(caseDoc.client);
    const sameBranch =
      !idStr(a.branch) || !idStr(caseDoc.branch) || idStr(a.branch) === idStr(caseDoc.branch);
    return !sameClient || !sameBranch;
  });

  if (foreign.length) {
    throw new ErrorResponse(
      `Alert(s) [${foreign.map((a) => a.uid || idStr(a._id)).join(', ')}] belong to a different client or branch than case ${caseDoc.uid || caseDoc._id}`,
      400
    );
  }

  // 1. Work out what the alerts bring with them.
  const addedAlertIds = uniqueIds(fresh.map((a) => a._id));
  const txnIds = uniqueIds(fresh.map((a) => a.transaction));
  const customerIds = uniqueIds([
    ...fresh.map((a) => a.customer),
    ...(await partyCustomersOf(txnIds)),
  ]);

  const addedCustomerIds = customerIds.filter((c) => !includesId(caseDoc.linkedCustomers, c));
  const addedTransactionIds = txnIds.filter((t) => !includesId(caseDoc.linkedTransactions, t));

  // 2. Update the case document.
  caseDoc.linkedAlerts.push(...addedAlertIds);
  caseDoc.linkedCustomers.push(...addedCustomerIds);
  caseDoc.linkedTransactions.push(...addedTransactionIds);
  if (!caseDoc.customer) {
    const firstAlertCustomer = fresh.find((a) => a.customer);
    caseDoc.customer = idStr(firstAlertCustomer && firstAlertCustomer.customer) || idStr(caseDoc.linkedCustomers[0]) || null;
  }
  await rederiveRisk(caseDoc);
  await caseDoc.save();

  // 3. Keep the other side in sync: transactions + alerts.
  await linkTransactionsToCase(addedTransactionIds, caseDoc);
  await Alert.updateMany(
    { _id: { $in: addedAlertIds } },
    {
      $set: { status: 'escalated_to_case', linkedCase: caseDoc._id },
      $push: {
        activity: {
          type: 'activity',
          title: activityTitle,
          message: `${activityTitle} "${caseDoc.title}" (${caseDoc.uid || caseDoc._id}) by ${actorName(user)}`,
          createdBy: user?._id || null,
        },
      },
    }
  );
  // Whoever attaches an unowned alert becomes its analyst.
  if (user && user._id) {
    await Alert.updateMany({ _id: { $in: addedAlertIds }, analyst: null }, { $set: { analyst: user._id } });
  }

  // 4. Audit.
  const uids = fresh.map((a) => a.uid || idStr(a._id));
  const details =
    `${addedAlertIds.length} alert(s) linked: [${uids.join(', ')}]` +
    (addedCustomerIds.length ? `; ${addedCustomerIds.length} customer(s) added as POI` : '') +
    (addedTransactionIds.length ? `; ${addedTransactionIds.length} transaction(s) linked` : '');
  await audit(caseDoc, user, 'alert_linked', details, req);

  return { addedAlertIds, addedCustomerIds, addedTransactionIds };
}

/**
 * Remove one alert from a case. Its transaction is unlinked only if no other
 * linked alert still references it; POIs are left in place.
 * @returns {Promise<{removedTransactionIds:string[]}>}
 */
async function detachAlertFromCase(caseDoc, alert, { user, req } = {}) {
  const alertId = idStr(alert._id);
  if (!includesId(caseDoc.linkedAlerts, alertId)) {
    throw new ErrorResponse('Alert is not linked to this case', 404);
  }

  caseDoc.linkedAlerts = caseDoc.linkedAlerts.filter((id) => idStr(id) !== alertId);

  let removedTransactionIds = [];
  if (alert.transaction) {
    const txnId = idStr(alert.transaction);
    const stillUsed = await Alert.exists({ _id: { $in: caseDoc.linkedAlerts }, transaction: txnId });
    if (!stillUsed && includesId(caseDoc.linkedTransactions, txnId)) {
      removedTransactionIds = [txnId];
      caseDoc.linkedTransactions = caseDoc.linkedTransactions.filter((id) => idStr(id) !== txnId);
    }
  }

  await rederiveRisk(caseDoc);
  await caseDoc.save();

  await unlinkTransactionsFromCase(removedTransactionIds);
  await Alert.findByIdAndUpdate(alertId, {
    $set: { linkedCase: null, status: 'under_review' },
    $push: {
      activity: {
        type: 'activity',
        title: 'Unlinked from case',
        message: `Unlinked from case "${caseDoc.title}" by ${actorName(user)}`,
        createdBy: user?._id || null,
      },
    },
  });

  await audit(caseDoc, user, 'alert_unlinked', `Alert ${alert.uid || alertId} unlinked from case`, req);
  return { removedTransactionIds };
}

// ── Linking customers (POIs) ────────────────────────────────────────────────

/**
 * Add customers as POIs. The first one becomes the primary POI when the case
 * has none. Caller validates the customers exist in the tenant.
 * @returns {Promise<{addedCustomerIds:string[]}>}
 */
async function addCustomersToCase(caseDoc, customerIds = [], { user, req } = {}) {
  const added = uniqueIds(customerIds).filter((c) => !includesId(caseDoc.linkedCustomers, c));
  if (!added.length) return { addedCustomerIds: [] };

  caseDoc.linkedCustomers.push(...added);
  if (!caseDoc.customer) caseDoc.customer = added[0];
  await caseDoc.save();

  await audit(caseDoc, user, 'customer_linked', `${added.length} customer(s) linked as POI`, req);
  return { addedCustomerIds: added };
}

/** Remove a POI. The primary POI (`Case.customer`) cannot be removed. */
async function removeCustomerFromCase(caseDoc, customerId, { user, req } = {}) {
  const cid = idStr(customerId);
  if (idStr(caseDoc.customer) === cid) {
    throw new ErrorResponse('The primary customer (POI) cannot be unlinked from its case', 400);
  }
  if (!includesId(caseDoc.linkedCustomers, cid)) {
    throw new ErrorResponse('Customer is not linked to this case', 404);
  }

  caseDoc.linkedCustomers = caseDoc.linkedCustomers.filter((id) => idStr(id) !== cid);
  await caseDoc.save();

  await audit(caseDoc, user, 'customer_unlinked', `Customer ${cid} unlinked from case`, req);
  return { removedCustomerId: cid };
}

module.exports = {
  // helpers
  idStr,
  uniqueIds,
  populateCase,
  summarizeCase,
  // derivation
  partyCustomersOf,
  deriveCaseRisk,
  applyDerivedRisk,
  rederiveRisk,
  // POI case lookup
  listAttachableCases,
  findAttachableCase,
  // link / unlink
  attachAlertsToCase,
  detachAlertFromCase,
  addCustomersToCase,
  removeCustomerFromCase,
};
