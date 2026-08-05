const express = require("express");
const router  = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");
const { getLawyerDashboardSummary } = require("../controllers/lawyerDashboardController");

router.use(express.json({ limit: "100kb" }));
router.use(protect);

router.get("/summary", authorizePermission("GRC.GET"), getLawyerDashboardSummary);

module.exports = router;
