/**
 * TBML screening orchestration
 * ─────────────────────────────────────────────────────────────────────────────
 * Screening is asynchronous: submitting a trade document answers in
 * milliseconds, and the analysis lands minutes later. This module owns that
 * gap — it submits, records the run, chases the result in the background, and
 * decides when a cached report may be served instead of calling the engine.
 *
 * Everything that knows the wire format lives in tbmlOsintService.js.
 */

const TbmlReport = require('../models/TbmlReport');
const osint = require('./tbmlOsintService');

const TERMINAL = TbmlReport.TERMINAL_STATUSES;

// How often the background sweep runs, and how long it keeps chasing one run.
const POLL_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 20_000;
// A run that has not settled within this long is almost certainly never going
// to. Polling stops; a read can still refresh it on demand.
const MAX_CHASE_MS = 6 * 60 * 60 * 1000; // 6 hours
// A read of a still-running report refreshes it if the last check is older than
// this, so an analyst watching the tab is not served a stale "PROCESSING".
const READ_REFRESH_AFTER_MS = 15_000;
// Ceiling on how many runs one sweep touches, so a backlog cannot stall the
// event loop or spend the whole rate budget in one pass.
const SWEEP_LIMIT = 25;

const isTerminal = (status) => TERMINAL.includes(status);

// The engine's status response and its full report carry the same headline
// fields; both are folded onto the document the same way.
const applyHeadline = (doc, payload = {}) => {
  if (payload.status) doc.status = payload.status;
  if (payload.environment) doc.environment = payload.environment;
  if (payload.overall_risk_level !== undefined) doc.overallRiskLevel = payload.overall_risk_level;
  if (payload.overall_risk_score !== undefined) doc.overallRiskScore = payload.overall_risk_score;
  if (payload.products_detected !== undefined) doc.productsDetected = payload.products_detected;
  if (payload.requires_analyst_review !== undefined) {
    doc.requiresAnalystReview = payload.requires_analyst_review;
  }
  if (payload.error_message !== undefined) doc.errorMessage = payload.error_message;
  if (payload.completed_at) doc.completedAt = new Date(payload.completed_at);
};

/**
 * Brings one stored run up to date with the engine.
 *
 * A finished report never changes, so once the full payload is cached this is a
 * no-op — that is the whole point of the cache. `force` re-reads anyway, for
 * the rare case where the engine amended a report.
 *
 * Never throws: a polling failure is recorded on the document and the run is
 * left in whatever state it was in. Losing contact with the engine must not
 * turn into a lost report.
 */
async function refreshReport(doc, { force = false, withTrail = false } = {}) {
  if (!doc) return null;

  const cached = isTerminal(doc.status) && doc.report;
  if (cached && !force && !(withTrail && !doc.trail)) return doc;

  try {
    if (!cached || force) {
      const status = await osint.getStatus(doc.reportId);
      applyHeadline(doc, status);

      // Only a settled run has an extract, research and a narrative worth
      // storing; fetching the full payload mid-run would cache a blank.
      if (isTerminal(doc.status)) {
        const [report, files] = await Promise.all([
          osint.getReport(doc.reportId),
          // The file list is a nicety — losing it costs the "view document"
          // link, not the report.
          osint.getDocuments(doc.reportId).catch(() => null),
        ]);
        applyHeadline(doc, report);
        doc.report = report;
        if (files) doc.files = files;
      }
    }

    // Large, and only some runs are ever audited this closely — fetched on the
    // first request that actually wants it, then kept.
    if (withTrail && !doc.trail && isTerminal(doc.status)) {
      doc.trail = await osint.getTrail(doc.reportId).catch(() => null);
    }

    doc.lastPollError = null;
  } catch (error) {
    doc.lastPollError = error.response?.data?.detail
      ? String(error.response.data.detail)
      : error.message;
  }

  doc.pollAttempts += 1;
  doc.refreshedAt = new Date();
  await doc.save();
  return doc;
}

/**
 * Serves a run for reading. Cached when it can be, refreshed when the answer
 * would otherwise be stale.
 */
async function readReport(doc, { withTrail = false } = {}) {
  if (!doc) return null;

  const stale =
    !isTerminal(doc.status) &&
    (!doc.refreshedAt || Date.now() - doc.refreshedAt.getTime() > READ_REFRESH_AFTER_MS);

  // A terminal run with no cached payload is one the poller never managed to
  // fetch — fill it in now rather than answering with an empty report.
  const missingPayload = isTerminal(doc.status) && !doc.report;

  if (stale || missingPayload || (withTrail && !doc.trail)) {
    return refreshReport(doc, { withTrail });
  }
  return doc;
}

/**
 * Submits one document and records the run.
 *
 * Returns as soon as the engine accepts the file. The analysis is picked up by
 * the background sweep — nothing downstream waits on it.
 */
async function submitScreening({
  buffer,
  filename,
  mimetype,
  caseDoc,
  customerId,
  caseDocumentId,
  documentName,
  user,
}) {
  // The engine files a run under whatever case reference it is given. Sending
  // the database id (not the CA-… uid) keeps the reference stable if a case is
  // ever renamed, and it is what the case list reads back by.

  // console.log(buffer)
  const submission = await osint.submitDocument({
    buffer,
    filename,
    mimetype,
    caseId: caseDoc ? String(caseDoc._id) : null,
    customerId: customerId ? String(customerId) : null,
  });



  if (!submission?.report_id) {
    throw new Error(submission?.message || 'The OSINT engine did not return a report id.');
  }

  const record = await TbmlReport.create({
    reportId:     submission.report_id,
    submissionId: submission.submission_id || null,
    dbSource:     submission.db_source ?? osint.dbSource(),
    environment:  submission.environment || null,
    client:       caseDoc?.client || null,
    branch:       caseDoc?.branch || null,
    case:         caseDoc?._id || null,
    customer:     customerId || null,
    caseDocument: caseDocumentId || null,
    documentName: documentName || filename || null,
    submittedBy:  user?._id || null,
    submittedAt:  new Date(),
    status:       'PENDING',
  });

  return { submission, record };
}

// ── Background sweep ──────────────────────────────────────────────────────────

/** Refreshes every run the engine is still working on. */
async function sweepPendingReports() {
  const cutoff = new Date(Date.now() - MAX_CHASE_MS);

  const pending = await TbmlReport.find({
    isDeleted: { $ne: true },
    status: { $nin: TERMINAL },
    submittedAt: { $gte: cutoff },
  })
    .sort({ refreshedAt: 1 })
    .limit(SWEEP_LIMIT);

  let settled = 0;
  let failed = 0;

  // Sequential on purpose: the engine is a shared, rate-limited service and a
  // slow sweep costs nothing here.
  for (const doc of pending) {
    await refreshReport(doc);
    if (isTerminal(doc.status)) settled += 1;
    if (doc.lastPollError) failed += 1;
  }

  return { scanned: pending.length, settled, failed };
}

/** Start the recurring sweep (called once from server.js). */
function startTbmlPollJob() {
  // Without a key there is nothing to poll, and a log line every minute saying
  // so would drown everything else.
  if (!process.env.OSINT_API_KEY) {
    console.log('[BG] tbml:poll — not started (OSINT_API_KEY is not set)'.yellow);
    return;
  }

  const run = async (label) => {
    try {
      const s = await sweepPendingReports();
      if (s.scanned) {
        console.log(
          `[BG] tbml:poll (${label}) — scanned ${s.scanned}, settled ${s.settled}, errors ${s.failed}`
            .cyan
        );
      }
    } catch (err) {
      console.error(`[BG] tbml:poll (${label}) — failed ✗`.red, err.message);
    }
  };

  setTimeout(() => run('startup'), INITIAL_DELAY_MS).unref();
  setInterval(() => run('interval'), POLL_INTERVAL_MS).unref();
}

module.exports = {
  refreshReport,
  readReport,
  submitScreening,
  sweepPendingReports,
  startTbmlPollJob,
  isTerminal,
};
