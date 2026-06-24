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
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use(protect);

// ── RA Report Excel exports (must be before /:id to avoid route collision) ────
router.route("/risk-register/export").get(exportRiskRegisterExcel);

// Assessment list & create
router.route("/").get(listAssessments).post(createAssessment);

// Single assessment CRUD
router.route("/:id").get(getAssessment).put(updateAssessment).delete(deleteAssessment);

// Risk factors
router.route("/:id/factors").get(getFactors).post(addFactor);
router.route("/:id/factors/:factorId").put(updateFactor).delete(deleteFactor);

// Risk register scenarios (micro layer — VDG register format)
router.route("/:id/scenarios").get(getScenarios).post(addScenario);
router.route("/:id/scenarios/:scenarioId").put(updateScenario).delete(deleteScenario);

// Risk register sections (dynamic taxonomy — custom sections)
router.route("/:id/sections").post(addSection);
router.route("/:id/sections/:code").delete(deleteSection);

// Live risk-register Excel export (scenario data; template fallback)
router.route("/:id/risk-register/export").get(exportAssessmentRiskRegisterExcel);

// Control assessments
router.route("/:id/controls").get(getControlAssessments);
router.route("/:id/controls/add-from-library").post(addControlsFromLibrary);
router.route("/:id/controls/:controlAssessId").put(updateControlAssessment);

// Workflow
router.route("/:id/calculate").post(calculate);
router.route("/:id/submit").post(submitForReview);
router.route("/:id/approve").post(approve);
router.route("/:id/results").get(getResults);

// Amendment
router.route("/:id/amend").post(createAmendment);
router.route("/:id/amend-diff").get(getAmendmentDiff);

// EWRA assessment Excel export
router.route("/:id/risk-report/export").get(exportAssessmentExcel);

// Consolidated workbook: Overview + Factors + Risk Register + Controls + Matrix
router.route("/:id/consolidated/export").get(exportConsolidatedExcel);

module.exports = router;
