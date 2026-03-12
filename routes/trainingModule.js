const express = require("express");
const router = express.Router();

const {
  createModule,
  getModules,
  getModule,
  updateModule,
  deleteModule,
  createPart,
  getPartsByModule,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  getPart,
  updatePart,
  getQuestion,
  deletePart,
  getManagerModule,  // GET  /assigned-by-me (kept for backward compat)
} = require("../controllers/trainingModuleController");

// Assignment controller (replaces the old inline assignModule in trainingModuleController)
const {
  assignModule,
} = require("../controllers/trainingAssignmentController");

// Progress controller (retake + per-module learner view)
const {
  grantRetake,
  getModuleLearnerProgress,
} = require("../controllers/trainingProgressController");

const TrainingModule = require("../models/TrainingModule");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

router.use(express.json({ limit: "100kb" }));
router.use(protect);

// ── Modules ────────────────────────────────────────────────────────────────────
router
  .route("/")
  .get(advancedResults(TrainingModule), getModules)
  .post(authorize("admin", "manager"), createModule);

// Backward-compat: manager's assigned list
router.get("/assigned-by-me", authorize("admin", "manager"), getManagerModule);

router
  .route("/:id")
  .get(getModule)
  .put(authorize("admin", "manager"), updateModule)
  .delete(authorize("admin"), deleteModule);

// ── Parts ──────────────────────────────────────────────────────────────────────
router
  .route("/:moduleId/parts")
  .post(authorize("admin", "manager"), createPart)
  .get(getPartsByModule);

router
  .route("/parts/:partId")
  .get(getPart)
  .put(authorize("admin", "manager"), updatePart)
  .delete(authorize("admin", "manager"), deletePart);

// ── Questions ──────────────────────────────────────────────────────────────────
router
  .route("/parts/:partId/questions")
  .post(authorize("admin", "manager"), createQuestion);

router
  .route("/questions/:id")
  .get(getQuestion)
  .put(authorize("admin", "manager"), updateQuestion)
  .delete(authorize("admin", "manager"), deleteQuestion);

// ── Assignments (module-scoped) ────────────────────────────────────────────────
// POST /api/v1/training-modules/:moduleId/assign
router.post(
  "/:moduleId/assign",
  authorize("admin", "manager"),
  assignModule
);

// ── Progress (module-scoped) ───────────────────────────────────────────────────
// GET  /api/v1/training-modules/:moduleId/learners  → per-learner progress breakdown
// POST /api/v1/training-modules/:moduleId/retake    → grant retake
router.get(
  "/:moduleId/learners",
  authorize("admin", "manager"),
  getModuleLearnerProgress
);
router.post(
  "/:moduleId/retake",
  authorize("admin", "manager"),
  grantRetake
);

module.exports = router;