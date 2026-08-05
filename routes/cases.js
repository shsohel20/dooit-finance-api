const express = require('express');
const {
  getCases,
  getCaseById,
  createCase,
  updateCase,
  updateCaseStatus,
  assignInvestigators,
  updateWatchers,
  getCaseAlerts,
  getCaseReports,
  getCaseAnalytics,
  fileSAR,
  linkAlerts,
  unlinkAlert,
  deleteCase,
  addNote,
  getCaseNotes,
  getAuditLog,
  getInvestigators,
} = require('../controllers/caseController');

const { protect, authorizePermission } = require('../middleware/auth');
const {
  validateCreateCase,
  validateUpdateCase,
  validateStatusUpdate,
  validateAddNote,
  validateAssignment,
  validateLinkAlerts,
} = require('../middleware/caseValidation');

const router = express.Router();
router.use(express.json({ limit: '100kb' }));
router.use(protect);
// Every case route needs a CASE grant; each route below narrows by verb.
router.use(
  authorizePermission('CASE.GET', 'CASE.ADD', 'CASE.EDIT', 'CASE.DELETE', 'CASE.ASSIGN'),
);

// ── Investigators list (before /:id to avoid routing conflict) ────────────────
router
  .route('/investigators')
  .get(authorizePermission('CASE.ASSIGN', 'CASE.EDIT'), getInvestigators);

// ── Analytics for the Case Manager dashboard (before /:id) ────────────────────
router.route('/analytics').get(authorizePermission('CASE.GET'), getCaseAnalytics);

// ── Case list + creation ──────────────────────────────────────────────────────
router
  .route('/')
  .get(authorizePermission('CASE.GET'), getCases)
  .post(authorizePermission('CASE.ADD'), validateCreateCase, createCase);

// ── Single case ───────────────────────────────────────────────────────────────
router
  .route('/:id')
  .get(authorizePermission('CASE.GET'), getCaseById)
  .put(authorizePermission('CASE.EDIT'), validateUpdateCase, updateCase)
  .delete(authorizePermission('CASE.DELETE'), deleteCase);

// ── Status transition ─────────────────────────────────────────────────────────
router
  .route('/:id/status')
  .patch(authorizePermission('CASE.EDIT'), validateStatusUpdate, updateCaseStatus);

// ── Investigator assignment ───────────────────────────────────────────────────
router
  .route('/:id/assign')
  .patch(authorizePermission('CASE.ASSIGN'), validateAssignment, assignInvestigators);

// ── Watchers ──────────────────────────────────────────────────────────────────
router
  .route('/:id/watchers')
  .patch(authorizePermission('CASE.ASSIGN', 'CASE.EDIT'), updateWatchers);

// ── Alert linkage ─────────────────────────────────────────────────────────────
// GET  → list alerts linked to this case
// POST → link additional alerts to this case
router
  .route('/:id/alerts')
  .get(authorizePermission('CASE.GET'), getCaseAlerts)
  .post(authorizePermission('CASE.EDIT'), validateLinkAlerts, linkAlerts);

// DELETE → unlink a single alert
router
  .route('/:id/alerts/:alertId')
  .delete(authorizePermission('CASE.EDIT'), unlinkAlert);

// ── Reports (ECDD/SMR/TTR/IFTI/GFS/RFI attached to this case) ─────────────────
router.route('/:id/reports').get(authorizePermission('CASE.GET'), getCaseReports);

// ── Record a SAR/SMR filing decision on the case ──────────────────────────────
router.route('/:id/sar').post(authorizePermission('CASE.EDIT'), fileSAR);

// ── Notes ─────────────────────────────────────────────────────────────────────
router
  .route('/:id/notes')
  .get(authorizePermission('CASE.GET'), getCaseNotes)
  .post(authorizePermission('CASE.EDIT'), validateAddNote, addNote);

// ── Audit trail ───────────────────────────────────────────────────────────────
router.route('/:id/audit').get(authorizePermission('CASE.GET'), getAuditLog);

module.exports = router;
