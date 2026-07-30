const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const { getLawyerDashboardSummary } = require("../controllers/lawyerDashboardController");

router.use(express.json({ limit: "100kb" }));
router.use(protect);

router.get("/summary", getLawyerDashboardSummary);

module.exports = router;
