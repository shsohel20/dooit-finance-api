const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth");

const {
    getMyProgress,
    getAllMyProgress,
    startModule,
    submitAttempts,
    updateWatchProgress,
    completeModule,
    grantRetake,
    getProgressReport,
    getModuleLearnerProgress,
} = require("../controllers/trainingProgressController");

router.use(express.json({ limit: "100kb" }));

router.use(protect);

// ── Learner routes ────────────────────────────────────────────────────────────

// GET  /api/v1/progress                  → all my progress records
// GET  /api/v1/progress/:moduleId        → my progress for one module
// POST /api/v1/progress/:moduleId/start  → start / resume a module
// POST /api/v1/progress/:moduleId/attempts → submit part answers
// PUT  /api/v1/progress/:moduleId/watch  → update video watch time
// POST /api/v1/progress/:moduleId/complete → finish module & calculate result

router.get("/", getAllMyProgress);
router.get("/report", authorize("admin", "manager"), getProgressReport);

router.get("/:moduleId", getMyProgress);
router.post("/:moduleId/start", startModule);
router.post("/:moduleId/attempts", submitAttempts);
router.put("/:moduleId/watch", updateWatchProgress);
router.post("/:moduleId/complete", completeModule);

// ── Manager / Admin routes ────────────────────────────────────────────────────

// POST /api/v1/progress/:moduleId/retake   → grant learner a retake
// GET  /api/v1/progress/:moduleId/learners → all learner progress for module
router.post(
    "/:moduleId/retake",
    authorize("admin", "manager"),
    grantRetake
);
router.get(
    "/:moduleId/learners",
    authorize("admin", "manager"),
    getModuleLearnerProgress
);

module.exports = router;