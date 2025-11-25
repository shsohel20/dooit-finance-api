// routes/ecdd.js
const express = require("express");
const router = express.Router();

const EcddReport = require("../models/EcddReport"); // used by advancedResults middleware if needed
const advancedResults = require("../middleware/advancedResults"); // if you use this pattern

const { getSmrReport } = require("../controllers/smrReportController");

router.get(
  "/",
  // optional: use advancedResults to handle query / pagination. Remove if you don't have it.
  advancedResults(EcddReport, "customer analyst generatedBy transaction"),
  getSmrReport
);

module.exports = router;
