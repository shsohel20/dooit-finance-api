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
  // assignModuleAccess,
  getModuleAccess,
  deleteModuleAccess,
  assignAccess,
} = require("../controllers/trainingModuleController");

const {
  assignModule,
  getAssignedByMe,
} = require("../controllers/trainingAssignmentController");

// Progress controller (retake + per-module learner view)
const {
  grantRetake,
  getModuleLearnerProgress,
} = require("../controllers/trainingProgressController");

const TrainingModule = require("../models/TrainingModule");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorizePermission } = require("../middleware/auth");

router.use(express.json({ limit: "100kb" }));
router.use(protect);

// ── Modules ────────────────────────────────────────────────────────────────────
router
  .route("/")
  .get(advancedResults(TrainingModule), getModules)
  .post(authorizePermission("TRAINING.MANAGE"), createModule);

router.get("/assigned-by-me", authorizePermission("TRAINING.ASSIGN"), getAssignedByMe);

router
  .route("/:id")
  .get(getModule)
  .put(authorizePermission("TRAINING.MANAGE"), updateModule)
  // Destructive + scope-granting routes carry TRAINING.ADMIN, which the module
  // authors' TRAINING.MANAGE grant deliberately does not include.
  .delete(authorizePermission("TRAINING.ADMIN"), deleteModule);

// ── Parts ──────────────────────────────────────────────────────────────────────
router
  .route("/:moduleId/parts")
  .post(authorizePermission("TRAINING.MANAGE"), createPart)
  .get(getPartsByModule);

router
  .route("/parts/:partId")
  .get(getPart)
  .put(authorizePermission("TRAINING.MANAGE"), updatePart)
  .delete(authorizePermission("TRAINING.MANAGE"), deletePart);

// ── Questions ──────────────────────────────────────────────────────────────────
router
  .route("/parts/:partId/questions")
  .post(authorizePermission("TRAINING.MANAGE"), createQuestion);

router
  .route("/questions/:id")
  .get(getQuestion)
  .put(authorizePermission("TRAINING.MANAGE"), updateQuestion)
  .delete(authorizePermission("TRAINING.MANAGE"), deleteQuestion);

// ── Module Access (admin assigns module to client/branch/role scopes) ─────────
router
  .route("/:moduleId/access")
  .post(authorizePermission("TRAINING.ADMIN"), assignAccess)
  // .put(authorizePermission("TRAINING.MANAGE"), assignModuleAccess)
  .get(authorizePermission("TRAINING.MANAGE"), getModuleAccess);

router.delete(
  "/access/:accessId",
  authorizePermission("TRAINING.ADMIN"),
  deleteModuleAccess,
);

// ── Assignments (module-scoped) ────────────────────────────────────────────────
// POST /api/v1/training-modules/:moduleId/assign
router.post("/:moduleId/assign", authorizePermission("TRAINING.ASSIGN"), assignModule);

// ── Progress (module-scoped) ───────────────────────────────────────────────────
// GET  /api/v1/training-modules/:moduleId/learners  → per-learner progress breakdown
// POST /api/v1/training-modules/:moduleId/retake    → grant retake
router.get(
  "/:moduleId/learners",
  authorizePermission("TRAINING.REPORT"),
  getModuleLearnerProgress,
);
router.post("/:moduleId/retake", authorizePermission("TRAINING.ASSIGN"), grantRetake);

module.exports = router;
