const express = require("express");
const {
  listAssessments, createAssessment, getAssessment, updateAssessment, deleteAssessment,
  getFactors, addFactor, updateFactor, deleteFactor,
  getControlAssessments, addControlsFromLibrary, updateControlAssessment,
  calculate, submitForReview, approve, getResults,
} = require("../controllers/ewraController");
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use(protect);

// Assessment list & create
router.route("/").get(listAssessments).post(createAssessment);

// Single assessment CRUD
router.route("/:id").get(getAssessment).put(updateAssessment).delete(deleteAssessment);

// Risk factors
router.route("/:id/factors").get(getFactors).post(addFactor);
router.route("/:id/factors/:factorId").put(updateFactor).delete(deleteFactor);

// Control assessments
router.route("/:id/controls").get(getControlAssessments);
router.route("/:id/controls/add-from-library").post(addControlsFromLibrary);
router.route("/:id/controls/:controlAssessId").put(updateControlAssessment);

// Workflow
router.route("/:id/calculate").post(calculate);
router.route("/:id/submit").post(submitForReview);
router.route("/:id/approve").post(approve);
router.route("/:id/results").get(getResults);

module.exports = router;
