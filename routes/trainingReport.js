const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth");

const {
    getOverview,
    getModuleReport,
    getLearnerReport,
    getSingleModuleReport,
} = require("../controllers/trainingReportsController");

router.use(express.json({ limit: "100kb" }));
router.use(protect);
router.use(authorize("admin", "manager"));

// GET /api/v1/reports/overview          → KPI snapshot
// GET /api/v1/reports/modules           → per-module stats table
// GET /api/v1/reports/learners          → per-learner progress table
// GET /api/v1/reports/module/:moduleId  → deep-dive for one module

router.get("/overview", getOverview);
router.get("/modules", getModuleReport);
router.get("/learners", getLearnerReport);
router.get("/module/:moduleId", getSingleModuleReport);

module.exports = router;