// utils/transactionCaseLink.js
//
// Keeps Transaction.investigation.{case,caseId,flagged} in sync with
// Case.linkedTransactions[]. Phase 5 of docs/43-CORE-ENTITY-LINKING-ROADMAP.md.

/**
 * Point the given transactions at a Case (sets investigation.case + caseId + flagged).
 * Safe to call with an empty/missing list.
 *
 * @param {Array}  transactionIds  ObjectIds (or strings) of transactions to link
 * @param {Object} caseDoc         a Case document/lean object with `_id` (and ideally `uid`)
 * @returns {Promise<number>} number of transactions modified
 */
async function linkTransactionsToCase(transactionIds = [], caseDoc) {
  const Transaction = require("../models/Transaction");
  const ids = (transactionIds || []).filter(Boolean);
  if (!ids.length || !caseDoc || !caseDoc._id) return 0;

  const res = await Transaction.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        "investigation.case": caseDoc._id,
        "investigation.caseId": String(caseDoc.uid || caseDoc._id),
        "investigation.flagged": true,
      },
    }
  );
  return res.modifiedCount || 0;
}

/**
 * Clear the case link from the given transactions (investigation.case = null, flagged = false).
 * Provided for future unlink flows; not wired today (there is no unlink-transaction endpoint).
 *
 * @param {Array} transactionIds
 * @returns {Promise<number>}
 */
async function unlinkTransactionsFromCase(transactionIds = []) {
  const Transaction = require("../models/Transaction");
  const ids = (transactionIds || []).filter(Boolean);
  if (!ids.length) return 0;

  const res = await Transaction.updateMany(
    { _id: { $in: ids } },
    { $set: { "investigation.case": null, "investigation.flagged": false } }
  );
  return res.modifiedCount || 0;
}

module.exports = { linkTransactionsToCase, unlinkTransactionsFromCase };
