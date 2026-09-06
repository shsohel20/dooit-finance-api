/**
 * TBML OSINT Service
 * ─────────────────────────────────────────────────────────────────────────────
 * The only place that knows how to talk to the OSINT Engine's TBML endpoints
 * (https://osint.dooit.ai/docs — "TBML OSINT"). Same shape as
 * utils/fileVaultService.js: a thin axios wrapper, no business logic.
 *
 * Env vars:
 *   OSINT_API_URL   – service root, e.g. https://osint.dooit.ai/api/v1
 *   OSINT_API_KEY   – shared secret, sent as the X-API-Key header
 *   OSINT_DB_SOURCE – 1 = production records, 2 = stage. Optional; defaults
 *                     to 2 (see dbSource below).
 */

const axios = require('axios');
const FormData = require('form-data');

const TBML = '/osint/tbml';

/**
 * The engine deliberately has no default for db_source and rejects a request
 * that omits it, rather than routing to production on the caller's behalf. We
 * hold the same line in the other direction: anything that is not an explicit
 * `1` resolves to stage, so a missing or malformed env var cannot silently
 * screen real customer records.
 */
const dbSource = () => (Number(process.env.OSINT_DB_SOURCE) === 1 ? 1 : 2);

const getConfig = () => {
  const baseURL = (process.env.OSINT_API_URL || 'https://osint.dooit.ai/api/v1').replace(/\/+$/, '');
  const apiKey = process.env.OSINT_API_KEY;

  if (!apiKey) {
    throw new Error('OSINT config missing. Set OSINT_API_KEY (and OSINT_API_URL).');
  }

  return { baseURL, apiKey };
};

const createClient = (extraHeaders = {}, timeout = 60_000) => {
  const { baseURL, apiKey } = getConfig();
  return axios.create({
    baseURL,
    headers: { 'X-API-Key': apiKey, ...extraHeaders },
    timeout,
  });
};

// ── Submit ────────────────────────────────────────────────────────────────────

/**
 * Queue a screening run for one trade document.
 *
 * Answers as soon as the document is accepted — the analysis itself takes
 * minutes. The caller stores `report_id` and lets the poller chase the result.
 *
 * @returns SubmitTBMLResponse — { success, message, submission_id, report_id,
 *          customer_id, case_id, db_source, environment,
 *          estimated_completion_minutes, status_endpoint }
 */
exports.submitDocument = async ({ buffer, filename, mimetype, caseId, customerId }) => {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimetype || 'application/octet-stream' });
  form.append('db_source', String(dbSource()));
  if (caseId) form.append('case_id', String(caseId));
  if (customerId) form.append('customer_id', String(customerId));

  // Upload plus acceptance; generous because the engine reads the document
  // enough to reject an unreadable one before answering.
  const client = createClient(form.getHeaders(), 120_000);
  // console.log(client)
  const { data } = await client.post(`${TBML}/submit`, form, { maxBodyLength: Infinity });
  console.log(data)
  return data;
};

// ── Read ──────────────────────────────────────────────────────────────────────

/** Cheap poll target: status, risk headline and error message only. */
exports.getStatus = async (reportId) => {
  const client = createClient({}, 30_000);
  const { data } = await client.get(`${TBML}/reports/${encodeURIComponent(reportId)}/status`, {
    params: { db_source: dbSource() },
  });
  return data;
};

/**
 * The full run: extract, per-product research, narrative and methodology.
 * `include_sources` brings back the individual pages the research pass read —
 * the references list and the market-evidence quotes are built from those, so
 * it is always on.
 */
exports.getReport = async (reportId) => {
  const client = createClient({}, 120_000);
  const { data } = await client.get(`${TBML}/reports/${encodeURIComponent(reportId)}`, {
    params: { db_source: dbSource(), include_sources: true },
  });
  return data;
};

/** The source files that were submitted (id, filename, size, content type). */
exports.getDocuments = async (reportId) => {
  const client = createClient({}, 30_000);
  const { data } = await client.get(`${TBML}/reports/${encodeURIComponent(reportId)}/documents`, {
    params: { db_source: dbSource() },
  });
  return data;
};

/**
 * Every search result the run saw, whether or not it was opened — the audit
 * answer to "what else did it look at, and why was that one skipped?".
 */
exports.getTrail = async (reportId, { selectedOnly = false } = {}) => {
  const client = createClient({}, 60_000);
  const { data } = await client.get(`${TBML}/reports/${encodeURIComponent(reportId)}/trail`, {
    params: { db_source: dbSource(), selected_only: selectedOnly },
  });
  return data;
};

/** Streams one submitted file back. Returns the raw axios response. */
exports.getDocumentFile = (reportId, fileId) => {
  const client = createClient({}, 120_000);
  return client.get(
    `${TBML}/reports/${encodeURIComponent(reportId)}/documents/${encodeURIComponent(fileId)}`,
    { params: { db_source: dbSource() }, responseType: 'stream' }
  );
};

exports.dbSource = dbSource;
