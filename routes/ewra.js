const express = require("express");
const {
  listAssessments, createAssessment, getAssessment, updateAssessment, deleteAssessment,
  getFactors, addFactor, updateFactor, deleteFactor,
  getScenarios, addScenario, updateScenario, deleteScenario,
  addSection, deleteSection,
  getControlAssessments, addControlsFromLibrary, updateControlAssessment,
  calculate, submitForReview, approve, getResults,
  createAmendment, getAmendmentDiff,
} = require("../controllers/ewraController");
const {
  exportRiskRegisterExcel, exportAssessmentExcel, exportAssessmentRiskRegisterExcel,
  exportConsolidatedExcel,
} = require("../controllers/raExportController");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use(protect);
// Router-level floor: any EWRA grant gets in; each route below narrows by verb.
router.use(
  authorizePermission("EWRA.GET", "EWRA.ADD", "EWRA.EDIT", "EWRA.DELETE", "EWRA.APPROVE"),
);

// ── RA Report Excel exports (must be before /:id to avoid route collision) ────
router
  .route("/risk-register/export")
  .get(authorizePermission("EWRA.GET"), exportRiskRegisterExcel);

// Assessment list & create
router
  .route("/")
  .get(authorizePermission("EWRA.GET"), listAssessments)
  .post(authorizePermission("EWRA.ADD"), createAssessment);

// Single assessment CRUD
router
  .route("/:id")
  .get(authorizePermission("EWRA.GET"), getAssessment)
  .put(authorizePermission("EWRA.EDIT"), updateAssessment)
  .delete(authorizePermission("EWRA.DELETE"), deleteAssessment);

// Risk factors
router
  .route("/:id/factors")
  .get(authorizePermission("EWRA.GET"), getFactors)
  .post(authorizePermission("EWRA.EDIT"), addFactor);
router
  .route("/:id/factors/:factorId")
  .put(authorizePermission("EWRA.EDIT"), updateFactor)
  .delete(authorizePermission("EWRA.EDIT"), deleteFactor);

// Risk register scenarios (micro layer — VDG register format)
router
  .route("/:id/scenarios")
  .get(authorizePermission("EWRA.GET"), getScenarios)
  .post(authorizePermission("EWRA.EDIT"), addScenario);
router
  .route("/:id/scenarios/:scenarioId")
  .put(authorizePermission("EWRA.EDIT"), updateScenario)
  .delete(authorizePermission("EWRA.EDIT"), deleteScenario);

// Risk register sections (dynamic taxonomy — custom sections)
router.route("/:id/sections").post(authorizePermission("EWRA.EDIT"), addSection);
router
  .route("/:id/sections/:code")
  .delete(authorizePermission("EWRA.EDIT"), deleteSection);

// Live risk-register Excel export (scenario data; template fallback)
router
  .route("/:id/risk-register/export")
  .get(authorizePermission("EWRA.GET"), exportAssessmentRiskRegisterExcel);

// Control assessments
router
  .route("/:id/controls")
  .get(authorizePermission("EWRA.GET"), getControlAssessments);
router
  .route("/:id/controls/add-from-library")
  .post(authorizePermission("EWRA.EDIT"), addControlsFromLibrary);
router
  .route("/:id/controls/:controlAssessId")
  .put(authorizePermission("EWRA.EDIT"), updateControlAssessment);

// Workflow
router.route("/:id/calculate").post(authorizePermission("EWRA.EDIT"), calculate);
router.route("/:id/submit").post(authorizePermission("EWRA.EDIT"), submitForReview);
// Sign-off is a separate grant from editing: the author of an assessment
// should not be able to approve their own work.
router.route("/:id/approve").post(authorizePermission("EWRA.APPROVE"), approve);
router.route("/:id/results").get(authorizePermission("EWRA.GET"), getResults);

// Amendment
router.route("/:id/amend").post(authorizePermission("EWRA.EDIT"), createAmendment);
router.route("/:id/amend-diff").get(authorizePermission("EWRA.GET"), getAmendmentDiff);

// EWRA assessment Excel export
router
  .route("/:id/risk-report/export")
  .get(authorizePermission("EWRA.GET"), exportAssessmentExcel);

// Consolidated workbook: Overview + Factors + Risk Register + Controls + Matrix
router
  .route("/:id/consolidated/export")
  .get(authorizePermission("EWRA.GET"), exportConsolidatedExcel);

module.exports = router;
