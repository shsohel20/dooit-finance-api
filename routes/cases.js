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

const { protect, authorize } = require('../middleware/auth');
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

// ── Investigators list (before /:id to avoid routing conflict) ────────────────
router.route('/investigators').get(authorize('admin', 'compliance_officer'), getInvestigators);

// ── Analytics for the Case Manager dashboard (before /:id) ────────────────────
router.route('/analytics').get(getCaseAnalytics);

// ── Case list + creation ──────────────────────────────────────────────────────
router
  .route('/')
  .get(getCases)
  .post(authorize('admin', 'compliance_officer'), validateCreateCase, createCase);

// ── Single case ───────────────────────────────────────────────────────────────
router
  .route('/:id')
  .get(getCaseById)
  .put(validateUpdateCase, updateCase)
  .delete(authorize('admin', 'compliance_officer'), deleteCase);

// ── Status transition ─────────────────────────────────────────────────────────
router.route('/:id/status').patch(validateStatusUpdate, updateCaseStatus);

// ── Investigator assignment ───────────────────────────────────────────────────
router
  .route('/:id/assign')
  .patch(authorize('admin', 'compliance_officer'), validateAssignment, assignInvestigators);

// ── Watchers ──────────────────────────────────────────────────────────────────
router
  .route('/:id/watchers')
  .patch(authorize('admin', 'compliance_officer'), updateWatchers);

// ── Alert linkage ─────────────────────────────────────────────────────────────
// GET  → list alerts linked to this case
// POST → link additional alerts to this case
router
  .route('/:id/alerts')
  .get(getCaseAlerts)
  .post(authorize('admin', 'compliance_officer'), validateLinkAlerts, linkAlerts);

// DELETE → unlink a single alert
router
  .route('/:id/alerts/:alertId')
  .delete(authorize('admin', 'compliance_officer'), unlinkAlert);

// ── Reports (ECDD/SMR/TTR/IFTI/GFS/RFI attached to this case) ─────────────────
router.route('/:id/reports').get(getCaseReports);

// ── Record a SAR/SMR filing decision on the case ──────────────────────────────
router.route('/:id/sar').post(fileSAR);

// ── Notes ─────────────────────────────────────────────────────────────────────
router.route('/:id/notes').get(getCaseNotes).post(validateAddNote, addNote);

// ── Audit trail ───────────────────────────────────────────────────────────────
router.route('/:id/audit').get(getAuditLog);

module.exports = router;
