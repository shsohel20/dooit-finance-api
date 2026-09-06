/**
 * TBML Screening Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Base path: /api/v1/tbml
 *
 * Trade-based money laundering screening performed by the OSINT Engine
 * (https://osint.dooit.ai/docs — "TBML OSINT"), fronted by this service so the
 * engine's shared API key never leaves it, runs are scoped to a tenant and a
 * case, and finished reports are served from our own cache.
 *
 * Endpoint summary
 * ────────────────────────────────────────────────
 * POST /cases/:caseId/screen                 Screen a trade document
 * GET  /cases/:caseId/reports                Runs recorded against a case
 * GET  /reports/:reportId                    Cached run in full
 * POST /reports/:reportId/refresh            Re-read from the engine
 * GET  /reports/:reportId/trail              Every search result the run saw
 * GET  /reports/:reportId/files/:fileId      Stream a screened document
 */

const express = require('express');
const multer = require('multer');

const {
  screenCaseDocument,
  getCaseTbmlReports,
  getTbmlReport,
  refreshTbmlReport,
  getTbmlTrail,
  downloadTbmlFile,
} = require('../controllers/tbmlController');

const { protect, authorizePermission } = require('../middleware/auth');

// ── JSON parser — ONLY for routes whose body is application/json ─────────────
// NEVER mount express.json() at router level here: /screen takes a
// multipart/form-data upload, and a router-level JSON parser can consume the
// raw body stream before multer reads it. Same rule as routes/fileVault.js.
const jsonBody = express.json({ limit: '100kb' });

// Trade documents are invoices and letters of credit — a handful of pages.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

const router = express.Router();

router.use(protect);
// A screening run is case evidence; touching one needs the same grant a case does.
router.use(authorizePermission('CASE.GET', 'CASE.ADD', 'CASE.EDIT'));

// ── Screening a case's trade document ────────────────────────────────────────
// Accepts either a new file (multipart, field `file`) or the id of a document
// already attached to the case (JSON, `documentId`). multer passes a JSON
// request through untouched, and jsonBody ignores a multipart one.
router
  .route('/cases/:caseId/screen')
  .post(authorizePermission('CASE.EDIT'), upload.single('file'), jsonBody, screenCaseDocument);

router.route('/cases/:caseId/reports').get(authorizePermission('CASE.GET'), getCaseTbmlReports);

// ── Reading a run ────────────────────────────────────────────────────────────
router.route('/reports/:reportId').get(authorizePermission('CASE.GET'), getTbmlReport);

router
  .route('/reports/:reportId/refresh')
  .post(authorizePermission('CASE.EDIT'), jsonBody, refreshTbmlReport);

router.route('/reports/:reportId/trail').get(authorizePermission('CASE.GET'), getTbmlTrail);

router
  .route('/reports/:reportId/files/:fileId')
  .get(authorizePermission('CASE.GET'), downloadTbmlFile);

module.exports = router;
