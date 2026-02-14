const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth");
const {
  getRiskFactors,
  getJurisdictions,
  getCustomerDropdown,
  assessFromBody,
  assessCustomerById,
  getIndividualRiskAssessments,
  assessFromBodySave,
} = require("../controllers/riskassessmentController");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const advancedResults = require("../middleware/advancedResults");
router.use(express.json({ limit: "100kb" }));

router.use(protect);

router
  .route("/")
  .get(
    advancedResults(IndividualRiskAssessment, "customer"),
    getIndividualRiskAssessments,
  );

router.get("/utils/risk-factors", getRiskFactors);
router.get("/utils/jurisdictions", getJurisdictions);
router.get("/utils/customers", getCustomerDropdown);

// risk
router.post("/risk/assess", assessFromBody);
router.post("/risk/assess/save", assessFromBodySave);
router.get("/customers/:id/risk", assessCustomerById);

module.exports = router;
