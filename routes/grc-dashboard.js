const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const { getDashboardSummary } = require("../controllers/grcDashboardController");

router.use(express.json({ limit: "100kb" }));
router.use(protect);

router.get("/summary", getDashboardSummary);

module.exports = router;
