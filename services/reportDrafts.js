// services/reportDrafts.js
//
// Builds a draft ECDD / SMR / GFS / RFI for a case: **facts from our own
// models, prose from the AI service** (docs/74 §4 and §6.3, phase C3).
//
// Every field written here comes from one of three places, and the builders
// below are deliberately explicit about which:
//   • the Case and its Alerts            — identity, linkage, risk, rules
//   • services/caseAnalysis              — totals, counterparties, evidence, POIs
//   • services/aiReports narrative       — prose only, from a fixed whitelist
//
// A draft is saved even when the AI call fails; the numbers are the part a
// filing cannot do without, and `aiMeta.error` records why the prose is absent.

const Case = require('../models/Case');
const Alert = require('../models/Alert');
const Client = require('../models/Client');
const EcddReport = require('../models/EcddReport');
const SMR = require('../models/SmrReport');
const GFS = require('../models/gfsReport');
const RFI = require('../models/Rfi');
const AlertDismissal = require('../models/AlertDismissal');
const { dismissalTypeByCode, GENERIC } = require('../utils/dismissalTypes');
const { analyseCase } = require('./caseAnalysis');
// Required as a module (not destructured) so the AI call can be stubbed in
// tests without reaching the network.
const aiReports = require('./aiReports');
const { idStr } = require('./caseLinking');
const { suspicionReasonsForFlags } = require('../utils/smrFormOptions');

// A filing lists its transactions; it does not carry a ledger. Beyond this the
// analyst works from the case's Transactions tab.
const MAX_REPORT_TRANSACTIONS = 100;
// RFI response window used for the draft; sending re-stamps the deadlines.
const RFI_RESPONSE_DAYS = 14;

const DAY = 86400e3;

/* ── shared helpers ─────────────────────────────────────────────────────── */

const subjectOf = (analysis) =>
  analysis.pois.find((p) => p.role === 'subject') || analysis.pois[0] || {};

const yesNo = (value) => (value ? 'Yes' : 'No');

/** Alert evidence frozen as it stood when the draft was written. */
const alertSnapshots = (alerts) =>
  alerts.map((a) => ({
    alert: a._id,
    uid: a.uid,
    ruleId: a.ruleId,
    ruleName: a.ruleName,
    ruleVersion: a.ruleVersion ?? null,
    caseType: a.caseType,
    riskScore: a.riskScore ?? null,
    riskLabel: a.riskLabel,
    alertOrigin: a.alertOrigin,
    explanation: a.explanation,
    status: a.status,
    triggeredAt: a.createdAt || null,
  }));

/** Withdrawal total for one crypto currency, exact (never AUD-converted). */
const withdrawalsIn = (analysis, code) => analysis.byCurrency.withdrawals?.[code] ?? 0;

/** Client address → the {street, city, state, postcode, country} reports use. */
const reportAddress = (address = {}) => ({
  street: address.street || '',
  city: address.city || '',
  state: address.state || '',
  postcode: address.zipcode || address.postcode || '',
  country: address.country || '',
});

/* ── ECDD (docs/74 §4.1) ────────────────────────────────────────────────── */

function buildEcddFacts({ caseDoc, analysis, user }) {
  const subject = subjectOf(analysis);
  const { totals, window } = analysis;

  return {
    // who prepared it
    analystName: user?.name || '',
    date: new Date(),

    // subject identity
    userId: subject.uid || '',
    fullName: subject.name || '',
    customerName: subject.name || '',
    onboardingDate: subject.onboardedAt || null,
    accountCreationDate: subject.onboardedAt || null,
    accountPurpose: subject.accountPurpose || '',
    // A declared range ("$1,000 – $5,000 per month") stays text; forcing it to
    // a number would invent precision the customer never gave.
    expectedVolumeText: subject.expectedVolumeText || '',
    registeredAddress: subject.residentialAddress || '',

    // screening flags
    isPEP: yesNo(subject.isPep),
    isSanctioned: yesNo(subject.sanction),
    relatedParty: `${totals.relatedPartyTxnCount} related-party transaction(s) identified`,

    // review window + totals
    analysisStartDate: window.start,
    analysisEndDate: window.end,
    totalDepositsAUD: totals.depositsAUD,
    totalWithdrawalsAUD: totals.withdrawalsAUD,
    totalWithdrawalsUSDT: withdrawalsIn(analysis, 'USDT'),
    totalWithdrawalsETH: withdrawalsIn(analysis, 'ETH'),
    totalWithdrawalsBTC: withdrawalsIn(analysis, 'BTC'),

    // deterministic restatements of the numbers above
    depositDetails: analysis.narrativeFacts.depositDetails,
    withdrawalDetails: analysis.narrativeFacts.withdrawalDetails,
    additionalInfo: analysis.narrativeFacts.additionalInfo,

    // behavioural evidence
    ipLocations: analysis.ipAddresses.length,
    ipAddresses: analysis.ipAddresses.map((ip) => ({
      ip: ip.ip,
      location: ip.country || null,
      count: (ip.transactionCount || 0) + (ip.deviceCount || 0),
    })),

    // risk as the CASE derived it from its alerts — not the AI's own score
    riskScore: caseDoc.riskScore ?? null,
    riskLabel: caseDoc.riskLabel ?? null,

    analysisSnapshot: analysis,
  };
}

/* ── SMR (docs/74 §4.2) ─────────────────────────────────────────────────── */

function buildSmrFacts({ caseDoc, analysis, alerts, client, user, previousReports }) {
  const subject = subjectOf(analysis);
  const flags = Object.keys(analysis.riskFlags || {});

  return {
    partA: {
      // Which designated services apply is a reporting-entity decision.
      designatedServices: [],
      serviceStatus: 'provided',
      suspicionReasons: suspicionReasonsForFlags(flags),
      otherReasons: [],
      suspiciousIndicators: {
        pep: !!subject.isPep,
        sanctions: !!subject.sanction,
        adverseMedia: (subject.amlRiskLabels || []).includes('adverseMedia'),
        structuringCandidates: analysis.structuring.candidates,
        relatedPartyTransactions: analysis.totals.relatedPartyTxnCount,
        highRiskJurisdictions: analysis.jurisdictions.filter((j) => j.highRisk).map((j) => j.code),
        rulesTriggered: analysis.rulesTriggered.map((r) => r.ruleName).filter(Boolean),
      },
    },

    partC: {
      personOrganisation: {
        name: subject.name || '',
        personDetails: {
          dateOfBirth: subject.dateOfBirth || null,
          nationality: subject.country || '',
        },
        businessAddress: reportAddress(subject.residentialAddressParts),
        phoneNumbers: [subject.phone].filter(Boolean),
        emails: [subject.email].filter(Boolean),
        occupation: subject.occupation || '',
        identityVerification: {
          documents: subject.identificationNumber
            ? [{ number: subject.identificationNumber, country: subject.country || '' }]
            : [],
        },
        isCustomer: true,
      },
    },

    // Everyone else on the case's transactions.
    partD: {
      hasOtherParties: analysis.counterparties.length > 0,
      otherParties: analysis.counterparties.slice(0, 20).map((c) => ({
        name: c.name || c.account || '',
        businessAddress: { country: c.institutionCountry || '' },
        accounts: c.account ? [{ number: c.account, institution: c.institution || '' }] : [],
        isCustomer: !!c.customer,
      })),
    },

    partF: {
      transactions: analysis.transactions.slice(0, MAX_REPORT_TRANSACTIONS).map((t) => {
        const counterpartyName = t.counterparty?.name || '';
        const outbound = t.direction === 'out';
        return {
          date: t.date,
          type: t.type,
          completed: t.status === 'completed',
          referenceNumber: t.uid || t.reference || '',
          totalAmount: { currencyCode: t.currency, amount: t.amount },
          // Only a cash leg carries a cash amount.
          cashAmount:
            t.subtype === 'cash' ? { currencyCode: t.currency, amount: t.amount } : undefined,
          sender: { name: outbound ? subject.name || '' : counterpartyName },
          payee: { name: outbound ? counterpartyName : subject.name || '' },
          beneficiary: { name: outbound ? counterpartyName : subject.name || '' },
        };
      }),
    },

    partG: {
      // The offence is the analyst's legal characterisation, not ours.
      likelyOffence: [],
      previousReports,
      otherGovernmentBodies: [],
      attachments: [],
    },

    partH: {
      reportingEntity: {
        name: client?.name || '',
        address: reportAddress(client?.address),
        internalReference: caseDoc.uid || String(caseDoc._id),
        completedBy: { name: user?.name || '', email: user?.email || '' },
      },
    },

    alerts: alertSnapshots(alerts),
  };
}

/* ── GFS (docs/74 §4.3) ─────────────────────────────────────────────────── */

function buildGfsFacts({ caseDoc, analysis, linkedToSMR }) {
  const subject = subjectOf(analysis);
  const { totals, window } = analysis;

  return {
    customerName: subject.name || '',
    customerUID: subject.uid || '',
    customerCountry: subject.country || '',
    customerType: subject.customerType || '',
    occupation: subject.occupation || '',
    kycStatus: subject.kycStatus || '',
    amlRiskLabels: subject.amlRiskLabels || [],
    pepFlag: !!subject.isPep,
    sanctionsFlag: !!subject.sanction,
    adverseMediaFlag: (subject.amlRiskLabels || []).includes('adverseMedia'),
    expectedTradingVolume: subject.expectedVolumeText || '',
    residentialAddress: subject.residentialAddress || '',
    accountOpeningDate: subject.onboardedAt || null,
    sourceOfFunds: subject.sourceOfFunds || '',
    sourceOfWealth: subject.sourceOfWealth || '',
    accountOpeningPurpose: subject.accountPurpose || '',

    reviewStartDate: window.start,
    reviewEndDate: window.end,
    totalDeposited: totals.depositsAUD,
    totalWithdrawn: totals.withdrawalsAUD,
    // What the case is actually about: the value that moved, in AUD terms.
    totalSuspicionAmount: totals.volumeAUD,
    netFlowAUD: totals.netFlowAUD,
    passThroughRatio: analysis.ratios.passThrough,
    peakDailyVolumeAUD: totals.peakDailyVolumeAUD,
    activeDays: totals.activeDays,
    transactionCount: totals.transactionCount,
    structuringCandidates: analysis.structuring.candidates,
    unconvertedCount: totals.unconvertedCount,
    jurisdictionsInvolved: analysis.jurisdictions.map((j) => j.code),
    riskFlags: Object.keys(analysis.riskFlags || {}),

    transactions: analysis.transactions.slice(0, MAX_REPORT_TRANSACTIONS).map((t) => ({
      transaction: t.transactionId,
      uid: t.uid,
      date: t.date,
      type: t.type,
      subtype: t.subtype,
      amount: t.amount,
      currency: t.currency,
      amountAUD: t.amountAUD,
      status: t.status,
      channel: t.channel,
      direction: t.direction,
      counterparty: t.counterparty?.name || '',
      counterpartyCountry: t.counterparty?.country || '',
      purpose: t.purpose || '',
      riskFlags: t.riskFlags || [],
      relatedParty: t.relatedParty,
      reference: t.reference || '',
      cryptoAddress: t.cryptoAddress || '',
    })),

    ofis: analysis.institutions.map((i) => ({
      name: i.name,
      country: i.country,
      bic: i.bic,
      transactionCount: i.transactionCount,
    })),

    // POIs = the case's own customers plus the counterparties they dealt with.
    pois: [
      ...analysis.pois.map((p) => ({
        customer: p.customer,
        name: p.name || p.uid || '',
        relationship: p.role === 'subject' ? 'Subject' : 'Linked customer',
        country: p.country || '',
      })),
      ...analysis.counterparties.map((c) => ({
        name: c.name || '',
        relationship: 'Counterparty',
        country: c.institutionCountry || '',
        institution: c.institution || '',
        account: c.account || '',
        transactionCount: c.transactionCount,
        totalAmountAUD: c.totalAmountAUD,
      })),
    ],

    cryptoAddresses: [...new Set(analysis.cryptoAddresses.map((c) => c.address).filter(Boolean))],
    cryptoLegs: analysis.cryptoAddresses,

    ipAddresses: analysis.ipAddresses.map((ip) => ({
      address: ip.ip,
      country: ip.country || '',
      count: (ip.transactionCount || 0) + (ip.deviceCount || 0),
    })),

    linkedToSMR,
    riskScore: caseDoc.riskScore ?? null,
    riskLabel: caseDoc.riskLabel ?? null,
  };
}

/* ── RFI (docs/74 §4.4) ─────────────────────────────────────────────────── */

function buildRfiFacts({ analysis, client, tippingOff }) {
  const subject = subjectOf(analysis);
  const now = Date.now();

  return {
    // First name only — the letter opens "Dear <name>".
    primaryContactName: (subject.name || '').split(' ')[0] || subject.name || '',
    replyToEmail: client?.email || process.env.FROM_EMAIL || '',
    responseDeadline: new Date(now + RFI_RESPONSE_DAYS * DAY),
    followupDeadline: new Date(now + RFI_RESPONSE_DAYS * 2 * DAY),
    finalDeadline: new Date(now + RFI_RESPONSE_DAYS * 3 * DAY),
    // Our own tipping-off control, not the AI's hint.
    tippingOffWarning: tippingOff.warning,
    deliveryBlocked: tippingOff.blocked,
    deliveryBlockReason: tippingOff.reason,
    status: 'Draft',
  };
}

/* ── Dismissal (docs/74 §4.5) ───────────────────────────────────────────── */

/**
 * The evidence considered, and OUR view of whether dismissing is safe.
 *
 * `requiresEscalation` is decided here, not by the AI: a dismissal is a
 * decision to stop looking, so the conditions that should stop it are ours to
 * state. The AI's own opinion informs the prose only.
 */
function buildDismissalFacts({ caseDoc, analysis, alerts, alert, dismissalType, liveSmr, user }) {
  const subject = subjectOf(analysis);
  const template = dismissalTypeByCode(dismissalType);

  const blockingConditions = [];
  if (subject.kycStatus && subject.kycStatus !== 'verified') {
    blockingConditions.push(`KYC status is '${subject.kycStatus}', not verified.`);
  }
  if (subject.sanction) blockingConditions.push('Customer is a sanctions match.');
  if (liveSmr) {
    blockingConditions.push(`SMR ${liveSmr.uid} is ${liveSmr.status} on this case.`);
  }
  if (analysis.jurisdictions.some((j) => j.highRisk)) {
    blockingConditions.push(
      `Activity touches a high-risk jurisdiction (${analysis.jurisdictions
        .filter((j) => j.highRisk)
        .map((j) => j.code)
        .join(', ')}).`
    );
  }

  return {
    alert: alert._id,
    dismissalType: dismissalType || GENERIC,
    templateKey: template?.templateKey || null,
    // The AI supplies its own title/category; the template's are the fallback.
    title: template?.title || '',
    category: template?.group || '',

    evidenceReviewed: {
      alertsReviewed: alerts.length,
      transactionsReviewed: analysis.totals.transactionCount,
      totalInflowAUD: analysis.totals.depositsAUD,
      totalOutflowAUD: analysis.totals.withdrawalsAUD,
      unconvertedCount: analysis.totals.unconvertedCount,
      jurisdictions: analysis.jurisdictions.map((j) => j.code),
      counterpartiesReviewed: analysis.counterparties.length,
      riskFlags: Object.keys(analysis.riskFlags || {}),
      rulesTriggered: analysis.rulesTriggered.map((r) => r.ruleName).filter(Boolean),
      reviewPeriod: { start: analysis.window.start, end: analysis.window.end },
      analystNotes: [],
    },

    requiresEscalation: blockingConditions.length > 0,
    blockingConditions,
    closedBy: user?._id || null,
    status: 'draft',
  };
}

/* ── narrative application ──────────────────────────────────────────────── */

/**
 * Merge the AI prose into a payload, respecting analyst edits.
 * Returns the keys actually applied so `aiMeta.sectionsUsed` stays honest.
 */
function applyNarrative(type, payload, narrative, editedFields = []) {
  const applied = [];
  const take = (key) => {
    if (narrative[key] === undefined) return undefined;
    if (editedFields.includes(key)) return undefined; // analyst owns it now
    applied.push(key);
    return narrative[key];
  };

  if (type === 'ecdd') {
    for (const key of [
      'profileSummary', 'transactionAnalysis', 'behavioralAnalysis', 'recommendation',
      'recommendationType', 'decisionRationale', 'immediateActions', 'keyIndicators', 'typologies',
    ]) {
      const value = take(key);
      if (value !== undefined) payload[key] = value;
    }
  }

  if (type === 'smr') {
    payload.partB = payload.partB || {};
    const grounds = take('groundsForSuspicion');
    if (grounds !== undefined) payload.partB.groundsForSuspicion = grounds;
    const list = take('groundsList');
    if (list !== undefined) payload.partB.groundsList = list;
    const notes = take('investigationNotes');
    if (notes !== undefined) payload.partB.investigationNotes = notes;
  }

  if (type === 'gfs') {
    const summary = take('suspicionSummary');
    if (summary !== undefined) {
      payload.suspicionSummary = summary;
      // The legacy single-line field the existing form and PDF read.
      if (!payload.suspicionReason) payload.suspicionReason = summary;
    }
    const change = take('behavioralChangeDescription');
    if (change !== undefined) payload.behavioralChangeDescription = change;
  }

  if (type === 'rfi') {
    const items = take('requestedItems');
    if (items !== undefined) payload.requestedItems = items.map((text) => ({ text }));
    for (const key of ['itemsRationale', 'draftSubject', 'draftBody']) {
      const value = take(key);
      if (value !== undefined) payload[key] = value;
    }
  }

  if (type === 'dismissal') {
    for (const key of ['title', 'category', 'intro', 'profile', 'transactionAnalysis', 'additionalInfo', 'conclusion']) {
      const value = take(key);
      // Title and category have a template fallback already in the payload —
      // only let the AI's version win when it actually sent one.
      if (value !== undefined) payload[key] = value;
    }
  }

  return applied;
}

/* ── model registry ─────────────────────────────────────────────────────── */

// `perAlert` types are scoped to one alert rather than to the case, so a case
// with several alerts can hold several of them — one per alert.
const REGISTRY = {
  ecdd: { Model: EcddReport, hubField: 'caseId', label: 'ECDD' },
  smr: { Model: SMR, hubField: 'caseId', label: 'SMR' },
  gfs: { Model: GFS, hubField: 'case', label: 'GFS' },
  rfi: { Model: RFI, hubField: 'case', label: 'RFI' },
  dismissal: { Model: AlertDismissal, hubField: 'case', label: 'Dismissal', perAlert: true },
};

const SUPPORTED_TYPES = Object.keys(REGISTRY);

/* ── entry point ────────────────────────────────────────────────────────── */

/**
 * Draft (or re-draft) one report for a case.
 *
 * @param {Object}  opts
 * @param {Object}  opts.caseDoc     lean Case
 * @param {string}  opts.type        ecdd | smr | gfs | rfi
 * @param {string}  [opts.alertId]   narrow the AI narrative to one alert
 * @param {boolean} [opts.regenerate] refresh an existing draft in place
 * @param {Object}  opts.user        req.user
 * @returns {Promise<{report: Object, created: boolean, regenerated: boolean, analysis: Object}>}
 */
async function draftReport({ caseDoc, type, alertId, dismissalType, regenerate = false, user }) {
  const entry = REGISTRY[type];
  const { Model, hubField, perAlert } = entry;

  // Case-scoped types have one draft per case; alert-scoped types have one per
  // alert, so the same case can hold a dismissal for each of its alerts.
  const scope = perAlert ? { alert: alertId } : { [hubField]: caseDoc._id };

  // An existing draft is returned untouched unless the caller asks for a rebuild
  // — regenerating silently would discard whatever the analyst had written.
  const existing = await Model.findOne(scope).sort({ createdAt: -1 });
  if (existing && !regenerate) {
    return { report: existing.toObject(), created: false, regenerated: false, analysis: null };
  }

  // 1. Facts. Reuse the cached snapshot when the case has one that is current.
  const cached = caseDoc.analysis || {};
  const analysis =
    cached.snapshot && cached.computedAt && new Date(cached.computedAt) >= new Date(caseDoc.updatedAt)
      ? cached.snapshot
      : await analyseCase(caseDoc);

  const [alerts, client] = await Promise.all([
    Alert.find({ _id: { $in: caseDoc.linkedAlerts || [] }, isDeleted: { $ne: true } })
      .select('uid ruleId ruleName ruleVersion caseType riskScore riskLabel status alertOrigin explanation createdAt customer')
      .lean(),
    caseDoc.client ? Client.findById(caseDoc.client).select('name email address registrationNumber clientType').lean() : null,
  ]);

  // 2. Prose. Never throws — a failure leaves the narrative empty.
  //
  // The tenant goes with the request and our own counts go with it: the service
  // does not scope its reads by client, so comparing what it saw against what
  // this client's case actually holds is how a cross-tenant narrative is caught
  // (docs/74 C15).
  const { narrative, meta } = await aiReports.draftNarrative(type, {
    caseId: caseDoc._id,
    alertId,
    dismissalType,
    client: caseDoc.client || null,
    branch: caseDoc.branch || null,
    requestedBy: user?._id || null,
    expected: {
      transactions: analysis.totals.transactionCount,
      alerts: alerts.length,
      // How many of this case's POIs another reporting entity also holds. Above
      // zero explains a wider read rather than leaving it a mystery.
      sharedCustomers: analysis.tenancy?.poisSharedWithOtherClients ?? 0,
    },
  });

  // 3. Type-specific facts.
  let payload;
  if (type === 'ecdd') {
    payload = buildEcddFacts({ caseDoc, analysis, user });
  } else if (type === 'smr') {
    const previousReports = await SMR.find({
      customer: caseDoc.customer,
      status: 'approved',
      caseId: { $ne: caseDoc._id },
    })
      .select('uid createdAt metadata.austracReference')
      .lean();
    payload = buildSmrFacts({
      caseDoc, analysis, alerts, client, user,
      previousReports: previousReports.map((r) => ({
        date: r.createdAt,
        referenceNumber: r.metadata?.austracReference || r.uid,
      })),
    });
  } else if (type === 'gfs') {
    const linkedToSMR = !!(await SMR.exists({ caseId: caseDoc._id }));
    payload = buildGfsFacts({ caseDoc, analysis, linkedToSMR });
  } else if (type === 'dismissal') {
    const alert = alerts.find((a) => String(a._id) === String(alertId));
    // A live SMR is a blocking condition for closing an alert as unremarkable.
    const liveSmr = await SMR.findOne({
      caseId: caseDoc._id,
      status: { $in: ['review', 'approved'] },
    })
      .select('uid status')
      .lean();
    payload = buildDismissalFacts({ caseDoc, analysis, alerts, alert, dismissalType, liveSmr, user });
  } else {
    // An RFI can tip off a customer who is the subject of a suspicious matter
    // report (AML/CTF Act s123), so a live SMR blocks delivery.
    const liveSmr = await SMR.findOne({
      caseId: caseDoc._id,
      status: { $in: ['review', 'approved'] },
    })
      .select('uid status')
      .lean();
    payload = buildRfiFacts({
      analysis,
      client,
      tippingOff: liveSmr
        ? {
            warning: true,
            blocked: true,
            reason: `SMR ${liveSmr.uid} is ${liveSmr.status} on this case — sending may tip off the subject.`,
          }
        : { warning: false, blocked: false, reason: '' },
    });
  }

  // 4. Linkage, evidence and provenance are the same for every type.
  const subject = subjectOf(analysis);
  Object.assign(payload, {
    [hubField]: caseDoc._id,
    caseNumber: caseDoc.uid || null,
    client: caseDoc.client || null,
    branch: caseDoc.branch || null,
    customer: caseDoc.customer || subject.customer || null,
    alert: alertId || alerts[0]?._id || null,
    analysisComputedAt: analysis.computedAt || null,
  });
  // A dismissal freezes only the alert it closes; the others freeze the set.
  payload.alerts = alertSnapshots(
    type === 'dismissal' ? alerts.filter((a) => String(a._id) === String(alertId)) : alerts
  );

  // 5. Prose, honouring anything the analyst has rewritten.
  const editedFields = existing?.editedFields || [];
  const applied = applyNarrative(type, payload, narrative, editedFields);
  payload.aiMeta = { ...meta, sectionsUsed: applied, sectionsRejected: meta.sectionsRejected || [] };

  // 6. Persist.
  if (existing) {
    existing.set(payload);
    await existing.save();
    return { report: existing.toObject(), created: false, regenerated: true, analysis };
  }

  if (type === 'ecdd') payload.generatedBy = user?._id || null;
  if (type === 'rfi') payload.sentBy = null;
  const report = await Model.create(payload);
  return { report: report.toObject(), created: true, regenerated: false, analysis };
}

module.exports = {
  draftReport,
  SUPPORTED_TYPES,
  REGISTRY,
  // exported for tests
  buildEcddFacts,
  buildSmrFacts,
  buildGfsFacts,
  buildRfiFacts,
  applyNarrative,
};
