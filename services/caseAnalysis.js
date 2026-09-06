// services/caseAnalysis.js
//
// The in-house transaction analysis for a Case — every number an ECDD / SMR /
// GFS / RFI / Dismissal report needs, computed from OUR models.
// docs/74 §6.2 (phase C2). The AI reports service only ever contributes prose;
// totals, counts, counterparties, jurisdictions and evidence come from here.
//
// Scope of a case's activity
//   linkedTransactions (always, even outside the window)
//   ∪ every transaction in the review window where any party
//     (sender / receiver / beneficiary / intermediary) is a POI of the case.
//
// Review window
//   1. explicit { from, to } passed by the caller
//   2. else Case.reviewWindow when an analyst has set one
//   3. else (earliest linked alert / transaction, else case creation) − 30 days → now
//
// Money
//   Every AUD figure uses `convertedAmountAUD`, falling back to `amount` only
//   when the transaction is already in AUD. A foreign-currency transaction with
//   no conversion is NEVER counted as AUD — it is excluded from AUD totals and
//   counted in `totals.unconvertedCount` so the gap is visible (doc 74 C11).
//   `byCurrency` always carries the exact per-currency amounts, so nothing is
//   lost when conversion is missing.

const Alert = require('../models/Alert');
const Transaction = require('../models/Transaction');
const Customer = require('../models/Customer');
const Device = require('../models/Device');
const { getCountry } = require('../utils/countryUtils');
const { getJurisdictionRisk } = require('../utils/highRiskCountries');
const { idStr, uniqueIds } = require('./caseLinking');

// ── Tunables ────────────────────────────────────────────────────────────────

// AUSTRAC threshold transaction reporting (TTR) limit — cash ≥ A$10,000.
const TTR_THRESHOLD_AUD = 10000;
// A deposit between 80% of the threshold and the threshold is "sub-threshold":
// the classic structuring shape (A$8,000–A$9,999.99).
const STRUCTURING_FLOOR = 0.8;
// Deposits inside this many hours of each other form one structuring cluster.
const STRUCTURING_WINDOW_HOURS = 24;
// Default review window when neither the caller nor an analyst chose one.
const DEFAULT_LOOKBACK_DAYS = 30;
// Hard cap so one enormous case cannot pull the whole collection into memory.
// When hit, `truncated` is set — the caller must not present the numbers as complete.
const MAX_TRANSACTIONS = 2000;

const PARTY_PATHS = ['sender', 'receiver', 'beneficiary', 'intermediary'];
// Where money lands: a POI on any of these slots means value came IN to the case.
const INBOUND_PATHS = ['receiver', 'beneficiary'];

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// ── Small helpers ───────────────────────────────────────────────────────────

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Sort an object's entries by value, descending, back into a plain object. */
const sortedByCount = (obj) =>
  Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));

/** UTC calendar day key, so "peak day" does not drift with the server timezone. */
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * AUD value of a transaction, or null when it cannot be known.
 * Never guesses an FX rate — an unconverted foreign amount stays unknown.
 */
function audValue(txn) {
  if (typeof txn.convertedAmountAUD === 'number' && txn.convertedAmountAUD > 0) {
    return txn.convertedAmountAUD;
  }
  if (String(txn.currency || '').toUpperCase() === 'AUD') return Number(txn.amount) || 0;
  return null;
}

/** Money for the deterministic report strings: "104,511.00". */
const money = (n) =>
  new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

/** "3 deposits" / "1 deposit" — the strings read as English either way. */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "branch-counter (2), online (1)" from a { key: count } map. */
const describeCounts = (counts) =>
  Object.entries(counts)
    .map(([key, n]) => `${key} (${n})`)
    .join(', ');

// ── Review window ───────────────────────────────────────────────────────────

/**
 * Decide which period the analysis covers.
 * @returns {{start: Date, end: Date, source: 'request'|'analyst'|'default'}}
 */
function resolveWindow(caseDoc, { from, to } = {}, anchors = []) {
  const end = to ? new Date(to) : new Date();

  if (from) return { start: new Date(from), end, source: 'request' };

  const saved = caseDoc.reviewWindow || {};
  if (saved.start) {
    return { start: new Date(saved.start), end: saved.end ? new Date(saved.end) : end, source: 'analyst' };
  }

  // Reach back from the first thing that happened on this case.
  const times = anchors.filter(Boolean).map((d) => new Date(d).getTime());
  const earliest = times.length ? Math.min(...times) : Date.now();
  return { start: new Date(earliest - DEFAULT_LOOKBACK_DAYS * DAY), end, source: 'default' };
}

// ── Transaction collection ──────────────────────────────────────────────────

// Only the paths the analysis reads — keeps the working set small on big cases.
const TXN_FIELDS = [
  'uid', 'timestamp', 'type', 'subtype', 'channel', 'status', 'purpose',
  'amount', 'currency', 'convertedAmountAUD', 'reference',
  'riskScore', 'riskFlags', 'relatedPartyFlag', 'crypto', 'forensic',
  'investigation.flagged', 'metadata',
  ...PARTY_PATHS.flatMap((p) => [
    `${p}.customer`, `${p}.name`, `${p}.account`, `${p}.institution`,
    `${p}.institutionCountry`, `${p}.bic`,
  ]),
].join(' ');

/**
 * Every transaction in scope: the ones explicitly linked to the case, plus the
 * POIs' activity inside the window. `autopopulate: false` keeps party customers
 * as plain ids (we only need to compare them to the POI list).
 */
async function collectTransactions({ linkedIds, poiIds, window, client, branch }) {
  const clauses = [];
  if (linkedIds.length) clauses.push({ _id: { $in: linkedIds } });
  if (poiIds.length) {
    clauses.push({
      timestamp: { $gte: window.start, $lte: window.end },
      $or: PARTY_PATHS.map((p) => ({ [`${p}.customer`]: { $in: poiIds } })),
    });
  }
  if (!clauses.length) return { transactions: [], truncated: false };

  const filter = { $or: clauses };
  if (client) filter.client = client;

  // A branch-scoped case sees its own branch's activity plus anything recorded
  // without a branch — the same rule the rule engine's tenant filter uses. It
  // lives in `$and` so it cannot collide with the `$or` above.
  if (branch) {
    filter.$and = [
      { $or: [{ branch }, { branch: null }, { branch: { $exists: false } }] },
    ];
  }

  const transactions = await Transaction.find(filter)
    .select(TXN_FIELDS)
    .sort({ timestamp: -1 })
    .limit(MAX_TRANSACTIONS + 1)
    .lean({ autopopulate: false });

  const truncated = transactions.length > MAX_TRANSACTIONS;
  return { transactions: truncated ? transactions.slice(0, MAX_TRANSACTIONS) : transactions, truncated };
}

// ── Per-transaction classification ──────────────────────────────────────────

/**
 * Which way value moved relative to the case's POIs.
 *   in          — a POI received (receiver / beneficiary)
 *   out         — a POI sent
 *   internal    — POIs on both sides; counts as volume, not as inflow or outflow
 *   third_party — linked to the case but no POI is a party
 */
function directionOf(txn, poiSet) {
  const isPoi = (path) => poiSet.has(idStr(txn[path] && txn[path].customer));
  const inbound = INBOUND_PATHS.some(isPoi);
  const outbound = isPoi('sender');

  if (!inbound && !outbound) return 'third_party';

  // `deposit` and `withdrawal` state the direction outright, so they win over
  // the party slots. Real records often disagree — the sandbox stores the
  // account holder as the *sender* of their own cash deposit — and a report
  // that called a deposit an outflow because of that would be wrong.
  if (txn.type === 'deposit') return 'in';
  if (txn.type === 'withdrawal') return 'out';

  if (inbound && outbound) return 'internal';
  return inbound ? 'in' : 'out';
}

// ── Aggregations ────────────────────────────────────────────────────────────

/** Counterparties = parties on the case's transactions that are NOT a POI. */
function buildCounterparties(rows, poiSet) {
  const byKey = new Map();

  for (const { txn, amountAUD } of rows) {
    for (const path of PARTY_PATHS) {
      const party = txn[path];
      if (!party) continue;
      const partyCustomer = idStr(party.customer);
      if (partyCustomer && poiSet.has(partyCustomer)) continue;      // that's a POI, not a counterparty
      if (!party.name && !party.account && !party.institution) continue; // empty slot

      // The institution country is part of the identity on purpose: the same
      // name routed through a different jurisdiction is a different exposure,
      // and merging them would hide a high-risk country from the report.
      const key = [party.name, party.account, party.institution, party.institutionCountry]
        .map((v) => v || '')
        .join('|');
      const entry = byKey.get(key) || {
        name: party.name || null,
        account: party.account || null,
        institution: party.institution || null,
        institutionCountry: party.institutionCountry || null,
        bic: party.bic || null,
        role: path,                       // slot it was first seen in
        customer: partyCustomer || null,  // set when the counterparty is also our customer
        transactionCount: 0,
        totalAmountAUD: 0,
      };
      entry.transactionCount += 1;
      entry.totalAmountAUD += amountAUD || 0;
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()]
    .map((c) => ({ ...c, totalAmountAUD: round2(c.totalAmountAUD) }))
    .sort((a, b) => b.totalAmountAUD - a.totalAmountAUD || b.transactionCount - a.transactionCount);
}

/**
 * Other financial institutions (OFIs) and the jurisdictions they sit in —
 * derived from the counterparty side only, which is what a GFS/SMR asks for.
 */
function buildInstitutionsAndJurisdictions(counterparties) {
  const institutions = new Map();
  const jurisdictions = new Map();

  for (const c of counterparties) {
    if (c.institution) {
      const key = `${c.institution}|${c.institutionCountry || ''}`;
      const inst = institutions.get(key) || {
        name: c.institution,
        country: c.institutionCountry || null,
        bic: c.bic || null,
        transactionCount: 0,
      };
      inst.transactionCount += c.transactionCount;
      institutions.set(key, inst);
    }

    if (c.institutionCountry) {
      const country = getCountry(c.institutionCountry);
      const code = country ? country.alpha2 : String(c.institutionCountry).toUpperCase();
      const risk = getJurisdictionRisk(country ? country.name : c.institutionCountry);
      const j = jurisdictions.get(code) || {
        code,
        name: country ? country.name : c.institutionCountry,
        riskCategory: risk.value,
        // UHRC / HRC are the bands a report must call out.
        highRisk: /^(UHRC|HRC)/.test(risk.value),
        transactionCount: 0,
        totalAmountAUD: 0,
      };
      j.transactionCount += c.transactionCount;
      j.totalAmountAUD += c.totalAmountAUD;
      jurisdictions.set(code, j);
    }
  }

  return {
    institutions: [...institutions.values()].sort((a, b) => b.transactionCount - a.transactionCount),
    jurisdictions: [...jurisdictions.values()]
      .map((j) => ({ ...j, totalAmountAUD: round2(j.totalAmountAUD) }))
      .sort((a, b) => b.totalAmountAUD - a.totalAmountAUD),
  };
}

/** Crypto legs, with the forensic score recorded against the transaction. */
function buildCryptoAddresses(rows) {
  return rows
    .filter(({ txn }) => txn.crypto && txn.crypto.walletAddress)
    .map(({ txn, amountAUD, direction }) => ({
      address: txn.crypto.walletAddress,
      txHash: txn.crypto.txHash || null,
      network: txn.crypto.network || null,
      cluster: txn.crypto.cluster || (txn.forensic && txn.forensic.walletCluster) || null,
      hops: typeof txn.crypto.hops === 'number' ? txn.crypto.hops : null,
      chainalysisScore: (txn.forensic && txn.forensic.chainalysisScore) ?? null,
      direction,
      amount: txn.amount,
      currency: txn.currency,
      amountAUD,
      transactionUid: txn.uid || null,
    }));
}

/**
 * IPs seen on the case: recorded on the transactions themselves plus the
 * devices registered against the POIs.
 */
async function buildIpAddresses(rows, poiIds) {
  const byIp = new Map();

  const add = (ip, country, key) => {
    if (!ip) return;
    const entry = byIp.get(ip) || { ip, country: country || null, transactionCount: 0, deviceCount: 0 };
    entry[key] += 1;
    if (!entry.country && country) entry.country = country;
    byIp.set(ip, entry);
  };

  for (const { txn } of rows) {
    const meta = txn.metadata || {};
    add(meta.ip || meta.ipAddress, meta.ipCountry || meta.geolocation, 'transactionCount');
  }

  if (poiIds.length) {
    const devices = await Device.find({ customer: { $in: poiIds } })
      .select('ipAddress country')
      .lean();
    for (const d of devices) add(d.ipAddress, d.country, 'deviceCount');
  }

  return [...byIp.values()].sort(
    (a, b) => b.transactionCount + b.deviceCount - (a.transactionCount + a.deviceCount)
  );
}

/**
 * Sub-threshold cash-in behaviour. `candidates` counts deposits sitting just
 * under the TTR limit; `clusters` counts groups of two or more of them inside
 * a 24-hour window — the pattern that actually suggests structuring.
 */
function buildStructuring(rows) {
  const floor = TTR_THRESHOLD_AUD * STRUCTURING_FLOOR;
  const subThreshold = rows
    .filter(({ txn, amountAUD, direction }) =>
      direction === 'in' && txn.type === 'deposit' && amountAUD !== null &&
      amountAUD >= floor && amountAUD < TTR_THRESHOLD_AUD)
    .map(({ txn, amountAUD }) => ({ at: new Date(txn.timestamp).getTime(), uid: txn.uid, amountAUD }))
    .sort((a, b) => a.at - b.at);

  // Walk the sorted deposits and close a cluster whenever the next one falls
  // outside the window of the first deposit in the current group.
  let clusters = 0;
  let groupStart = null;
  let groupSize = 0;
  for (const d of subThreshold) {
    if (groupStart !== null && d.at - groupStart <= STRUCTURING_WINDOW_HOURS * HOUR) {
      groupSize += 1;
    } else {
      if (groupSize >= 2) clusters += 1;
      groupStart = d.at;
      groupSize = 1;
    }
  }
  if (groupSize >= 2) clusters += 1;

  return {
    candidates: subThreshold.length,
    clusters,
    thresholdAUD: TTR_THRESHOLD_AUD,
    bandFromAUD: floor,
    transactions: subThreshold.map((d) => d.uid).filter(Boolean),
  };
}

/** The rules behind the case, from its alerts — one row per rule. */
function buildRulesTriggered(alerts) {
  const byRule = new Map();
  for (const a of alerts) {
    const key = a.ruleId || idStr(a.ruleRef) || a.ruleName || String(a._id);
    const entry = byRule.get(key) || {
      ruleId: a.ruleId || null,
      ruleName: a.ruleName || null,
      ruleVersion: a.ruleVersion ?? null,
      caseType: a.caseType || null,
      riskLabel: a.riskLabel || null,
      alertUids: [],
      alertCount: 0,
    };
    entry.alertCount += 1;
    if (a.uid) entry.alertUids.push(a.uid);
    byRule.set(key, entry);
  }
  return [...byRule.values()].sort((a, b) => b.alertCount - a.alertCount);
}

/**
 * The people the case is about. Customers are read hydrated (not lean) so the
 * role-encryption plugin can decrypt the KYC name, and `decryptForRole()`
 * returns the object with virtuals — which is where the CRA risk lives.
 */
async function buildPois(caseDoc) {
  const primaryId = idStr(caseDoc.customer);
  const caseClient = idStr(caseDoc.client);
  const caseBranch = idStr(caseDoc.branch);
  const ids = uniqueIds([caseDoc.customer, ...(caseDoc.linkedCustomers || [])]);
  if (!ids.length) return [];

  const docs = await Customer.find({ _id: { $in: ids } }).populate('user', 'name email');

  // A customer's `relations[]` are what actually bind them to a client and
  // branch — the same person can be onboarded by several reporting entities.
  // That is precisely the shape that makes an unscoped read leak (docs/74 C15),
  // so each POI carries the relation THIS case is about, and a count of the
  // other clients that also hold them.
  const tenancyOf = (relations = []) => {
    const forClient = relations.filter((r) => idStr(r.client) === caseClient);
    // Prefer the relation for this case's branch; fall back to a branch-less
    // one, which belongs to every branch of the client.
    const relation =
      forClient.find((r) => caseBranch && idStr(r.branch) === caseBranch) ||
      forClient.find((r) => !idStr(r.branch)) ||
      forClient[0] ||
      null;

    const otherClients = [
      ...new Set(relations.map((r) => idStr(r.client)).filter((c) => c && c !== caseClient)),
    ];

    return {
      client: relation ? idStr(relation.client) : null,
      branch: relation ? idStr(relation.branch) : null,
      type: relation?.type || null,
      registeredAt: relation?.registeredAt || null,
      onboardedVia: relation?.source || null,
      // False when the customer has no relation to this case's client at all —
      // worth seeing, because their activity is then being read for a tenant
      // that never onboarded them.
      relatedToCaseTenant: !!relation,
      otherClientCount: otherClients.length,
    };
  };

  return docs.map((doc) => {
    const c = typeof doc.decryptForRole === 'function' ? doc.decryptForRole() : doc.toObject();
    const form = c.personalKyc?.personal_form || {};
    const details = form.customer_details || {};
    const contact = form.contact_details || {};
    const address = form.residential_address || {};
    const funds = c.personalKyc?.funds_wealth || {};
    const employment = form.employment_details || {};
    const fullName = [details.given_name, details.middle_name, details.surname]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      customer: c._id,
      uid: c.uid || null,
      name: fullName || c.user?.name || c.uid || null,
      role: idStr(c._id) === primaryId ? 'subject' : 'linked',
      country: c.country || null,
      // Identity block — the reports (SMR Part C, RFI addressee) need these,
      // and they are already decrypted here.
      dateOfBirth: details.date_of_birth || null,
      email: contact.email || c.user?.email || null,
      phone: contact.phone || null,
      identificationNumber: form.identificationNo || null,
      residentialAddress:
        [address.address, address.suburb, address.state, address.postcode, address.country]
          .filter(Boolean)
          .join(', ') || null,
      // Same address in parts, for report forms that hold a structured address
      // (SMR Part C) rather than one line.
      residentialAddressParts: {
        street: address.address || '',
        city: address.suburb || '',
        state: address.state || '',
        postcode: address.postcode || '',
        country: address.country || c.country || '',
      },
      industry: employment.industry || null,
      kycStatus: c.kycStatus || null,
      isPep: !!c.isPep,
      sanction: !!c.sanction,
      amlStatus: c.amlStatus || null,
      amlRiskLabels: c.amlRiskLabels || [],
      occupation: employment.occupation || null,
      sourceOfFunds: funds.source_of_funds || null,
      sourceOfWealth: funds.source_of_wealth || null,
      accountPurpose: funds.account_purpose || null,
      expectedVolumeText: funds.estimated_trading_volume || null,
      // CRA virtuals — computed by utils/riskAssessment, not stored on the doc.
      riskScore: c.riskScore ?? null,
      riskLabel: c.riskLabel ?? null,
      // Earliest relation is when this customer joined the reporting entity.
      onboardedAt:
        (c.relations || [])
          .map((r) => r.registeredAt)
          .filter(Boolean)
          .sort((a, b) => new Date(a) - new Date(b))[0] || null,
      // Which client/branch onboarded them, and whether anyone else did.
      tenancy: tenancyOf(c.relations),
    };
  });
}

// ── Deterministic report strings ────────────────────────────────────────────
//
// These are the ECDD `depositDetails` / `withdrawalDetails` / `additionalInfo`
// fields. They are pure restatements of the numbers above — never AI prose.

function buildDepositDetails(analysis) {
  const { totals, byCurrency, counts } = analysis;
  if (!totals.depositCount) return 'No inflows recorded in the review period.';

  const lines = [
    `Total inflow (AUD-normalised): AUD ${money(totals.depositsAUD)} across ${plural(totals.depositCount, 'deposit transaction')}.`,
    ...Object.entries(byCurrency.deposits).map(([code, amt]) => `- ${code}: ${money(amt)}`),
  ];
  if (Object.keys(counts.byChannel).length) {
    lines.push(`Channels observed: ${describeCounts(counts.byChannel)}.`);
  }
  if (totals.unconvertedCount) {
    lines.push(
      `${plural(totals.unconvertedCount, 'transaction')} had no AUD conversion and are excluded from the AUD total.`
    );
  }
  return lines.join('\n');
}

function buildWithdrawalDetails(analysis) {
  const { totals, byCurrency, ratios, cryptoAddresses } = analysis;
  if (!totals.withdrawalCount) return 'No outflows recorded in the review period.';

  const lines = [
    `Total outflow (AUD-normalised): AUD ${money(totals.withdrawalsAUD)} across ${plural(totals.withdrawalCount, 'transaction')}.`,
    ...Object.entries(byCurrency.withdrawals).map(([code, amt]) => `- ${code}: ${money(amt)}`),
  ];
  if (cryptoAddresses.length) {
    const wallets = new Set(cryptoAddresses.map((c) => c.address)).size;
    lines.push(`Crypto legs recorded against ${plural(wallets, 'distinct wallet reference')}.`);
  }
  if (ratios.passThrough !== null) {
    lines.push(`Pass-through ratio (outflow ÷ inflow): ${(ratios.passThrough * 100).toFixed(2)}%.`);
  }
  return lines.join('\n');
}

function buildAdditionalInfo(caseDoc, analysis) {
  const parts = [
    `${plural(analysis.rulesTriggered.reduce((n, r) => n + r.alertCount, 0), 'alert')} linked to case ${caseDoc.uid || caseDoc._id}.`,
    `Case status: ${caseDoc.status}.`,
    `Priority: ${caseDoc.priority}.`,
  ];
  if (analysis.pois.length > 1) parts.push(`${plural(analysis.pois.length, 'person')} of interest on the case.`);
  if (analysis.truncated) {
    parts.push(`Only the ${MAX_TRANSACTIONS} most recent transactions were analysed — figures are a lower bound.`);
  }
  return parts.join(' ');
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Analyse a case's activity.
 *
 * @param {Object} caseDoc  a Case (lean or hydrated) with customer / linkedCustomers /
 *                          linkedAlerts / linkedTransactions
 * @param {Object} [opts]   { from, to } — override the review window
 * @returns {Promise<Object>} the analysis object (see docs/74 §6.2)
 */
async function analyseCase(caseDoc, opts = {}) {
  const poiIds = uniqueIds([caseDoc.customer, ...(caseDoc.linkedCustomers || [])]);
  const poiSet = new Set(poiIds);
  const linkedIds = uniqueIds(caseDoc.linkedTransactions || []);

  // 1. The case's own alerts and transactions — they also anchor the window.
  const [alerts, linkedTxns] = await Promise.all([
    Alert.find({ _id: { $in: uniqueIds(caseDoc.linkedAlerts || []) }, isDeleted: { $ne: true } })
      .select('uid ruleId ruleName ruleVersion ruleRef caseType riskScore riskLabel status alertOrigin createdAt')
      .lean(),
    linkedIds.length
      ? Transaction.find({ _id: { $in: linkedIds } }).select('timestamp').lean({ autopopulate: false })
      : [],
  ]);

  const window = resolveWindow(caseDoc, opts, [
    ...alerts.map((a) => a.createdAt),
    ...linkedTxns.map((t) => t.timestamp),
    caseDoc.createdAt,
  ]);

  // 2. Everything in scope.
  const { transactions, truncated } = await collectTransactions({
    linkedIds,
    poiIds,
    window,
    client: caseDoc.client || null,
    branch: caseDoc.branch || null,
  });

  // 3. Classify each transaction once; every aggregate below reads these rows.
  const rows = transactions.map((txn) => ({
    txn,
    amountAUD: audValue(txn),
    direction: directionOf(txn, poiSet),
  }));

  // 4. Totals, per-currency exactness and the count breakdowns.
  const totals = {
    transactionCount: rows.length,
    depositCount: 0,
    withdrawalCount: 0,
    depositsAUD: 0,
    withdrawalsAUD: 0,
    netFlowAUD: 0,
    averageAUD: 0,
    peakDailyVolumeAUD: 0,
    activeDays: 0,
    unconvertedCount: 0,
    flaggedTxnCount: 0,
    relatedPartyTxnCount: 0,
  };
  const byCurrency = { deposits: {}, withdrawals: {}, volume: {} };
  const counts = { byType: {}, byStatus: {}, byChannel: {}, byDirection: {} };
  const riskFlagCounts = {};
  const perDayAUD = {};
  let volumeAUD = 0;
  let largest = null;

  for (const row of rows) {
    const { txn, amountAUD, direction } = row;
    const currency = String(txn.currency || 'UNKNOWN').toUpperCase();

    counts.byDirection[direction] = (counts.byDirection[direction] || 0) + 1;
    if (txn.type) counts.byType[txn.type] = (counts.byType[txn.type] || 0) + 1;
    if (txn.status) counts.byStatus[txn.status] = (counts.byStatus[txn.status] || 0) + 1;
    if (txn.channel) counts.byChannel[txn.channel] = (counts.byChannel[txn.channel] || 0) + 1;
    for (const flag of txn.riskFlags || []) riskFlagCounts[flag] = (riskFlagCounts[flag] || 0) + 1;
    if (txn.investigation && txn.investigation.flagged) totals.flaggedTxnCount += 1;
    if (txn.relatedPartyFlag) totals.relatedPartyTxnCount += 1;

    // Raw per-currency amounts are always exact, conversion or not.
    byCurrency.volume[currency] = round2((byCurrency.volume[currency] || 0) + (Number(txn.amount) || 0));
    if (direction === 'in') {
      byCurrency.deposits[currency] = round2((byCurrency.deposits[currency] || 0) + (Number(txn.amount) || 0));
    } else if (direction === 'out') {
      byCurrency.withdrawals[currency] = round2((byCurrency.withdrawals[currency] || 0) + (Number(txn.amount) || 0));
    }

    if (amountAUD === null) {
      totals.unconvertedCount += 1;
      continue; // no AUD figure — excluded from every AUD aggregate below
    }

    volumeAUD += amountAUD;
    perDayAUD[dayKey(txn.timestamp)] = (perDayAUD[dayKey(txn.timestamp)] || 0) + amountAUD;
    if (!largest || amountAUD > largest.amountAUD) {
      largest = {
        transactionId: txn._id,
        uid: txn.uid || null,
        date: txn.timestamp,
        amount: txn.amount,
        currency,
        amountAUD,
        type: txn.type || null,
        direction,
      };
    }
    if (direction === 'in') {
      totals.depositCount += 1;
      totals.depositsAUD += amountAUD;
    } else if (direction === 'out') {
      totals.withdrawalCount += 1;
      totals.withdrawalsAUD += amountAUD;
    }
  }

  const convertedCount = rows.length - totals.unconvertedCount;
  totals.depositsAUD = round2(totals.depositsAUD);
  totals.withdrawalsAUD = round2(totals.withdrawalsAUD);
  totals.netFlowAUD = round2(totals.depositsAUD - totals.withdrawalsAUD);
  totals.averageAUD = convertedCount ? round2(volumeAUD / convertedCount) : 0;
  totals.peakDailyVolumeAUD = round2(Math.max(0, ...Object.values(perDayAUD)));
  totals.activeDays = new Set(rows.map(({ txn }) => dayKey(txn.timestamp))).size;
  totals.volumeAUD = round2(volumeAUD);

  // 5. Entity-level aggregates.
  const counterparties = buildCounterparties(rows, poiSet);
  const { institutions, jurisdictions } = buildInstitutionsAndJurisdictions(counterparties);
  const [pois, ipAddresses] = await Promise.all([buildPois(caseDoc), buildIpAddresses(rows, poiIds)]);

  const analysis = {
    case: { _id: caseDoc._id, uid: caseDoc.uid || null, status: caseDoc.status, priority: caseDoc.priority },
    // Whose data this is. Every figure below was read within this scope, which
    // is what makes a wider read by the summary service detectable (docs/74 C15).
    tenancy: {
      client: caseDoc.client || null,
      branch: caseDoc.branch || null,
      // POIs this reporting entity shares with another one. Above zero means an
      // unscoped read of this customer WILL pull in another client's activity.
      poisSharedWithOtherClients: pois.filter((p) => p.tenancy.otherClientCount > 0).length,
      // POIs with no relation to this case's client at all.
      poisNotRelatedToTenant: pois.filter((p) => !p.tenancy.relatedToCaseTenant).length,
    },
    window,
    totals,
    byCurrency,
    counts,
    ratios: {
      // Outflow ÷ inflow. Above ~1 the account is passing funds through rather
      // than holding them. Null when there is no inflow to divide by.
      passThrough: totals.depositsAUD > 0 ? round2(totals.withdrawalsAUD / totals.depositsAUD) : null,
    },
    largestTransaction: largest,
    structuring: buildStructuring(rows),
    riskFlags: sortedByCount(riskFlagCounts),
    rulesTriggered: buildRulesTriggered(alerts),
    counterparties,
    institutions,
    jurisdictions,
    cryptoAddresses: buildCryptoAddresses(rows),
    ipAddresses,
    pois,
    transactions: rows.map(({ txn, amountAUD, direction }) => ({
      transactionId: txn._id,
      uid: txn.uid || null,
      date: txn.timestamp,
      type: txn.type || null,
      subtype: txn.subtype || null,
      channel: txn.channel || null,
      status: txn.status || null,
      purpose: txn.purpose || null,
      reference: txn.reference || null,
      amount: txn.amount,
      currency: String(txn.currency || '').toUpperCase(),
      amountAUD,
      direction,
      riskFlags: txn.riskFlags || [],
      relatedParty: !!txn.relatedPartyFlag,
      flagged: !!(txn.investigation && txn.investigation.flagged),
      counterparty: (() => {
        // The most useful single name for a table row: the first non-POI party.
        for (const path of PARTY_PATHS) {
          const p = txn[path];
          if (p && p.name && !poiSet.has(idStr(p.customer))) {
            return { name: p.name, country: p.institutionCountry || null, role: path };
          }
        }
        return null;
      })(),
      cryptoAddress: (txn.crypto && txn.crypto.walletAddress) || null,
    })),
    truncated,
    computedAt: new Date(),
  };

  // 6. The deterministic strings the reports paste in verbatim.
  analysis.narrativeFacts = {
    depositDetails: buildDepositDetails(analysis),
    withdrawalDetails: buildWithdrawalDetails(analysis),
    additionalInfo: buildAdditionalInfo(caseDoc, analysis),
  };

  return analysis;
}

module.exports = {
  analyseCase,
  // exported for reuse + tests
  resolveWindow,
  audValue,
  directionOf,
  buildStructuring,
  buildDepositDetails,
  buildWithdrawalDetails,
  buildAdditionalInfo,
  TTR_THRESHOLD_AUD,
  MAX_TRANSACTIONS,
  DEFAULT_LOOKBACK_DAYS,
};
