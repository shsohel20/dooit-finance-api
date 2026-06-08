const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload"); // multer instance for CSV import


const { protect } = require("../middleware/auth");
const {
  getRiskFactors,
  getJurisdictions,
  getCustomerDropdown,
  assessFromBody,
  assessCustomerById,
  getIndividualRiskAssessments,
  getIndividualRiskAssessment,
  updateIndividualRiskAssessment,
  assessFromBodySave,

  createCountryRisk,
  updateCountryRisk,
  getRiskFactorOptions,
  createRiskFactorOption,
  getCountryRisks,
  deleteCountryRisk,
  updateRiskFactorOption,
  deleteRiskFactorOption,
  exportCountryRiskCsv,
  importCountryRiskCsv,
  exportRiskFactorsCsv,
  importRiskFactorsCsv,
  ecddApprove,
  ecddDecline,
} = require("../controllers/riskassessmentController");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const advancedResults = require("../middleware/advancedResults");
const CountryRisk = require("../models/CountryRisk");
const RiskFactorOption = require("../models/RiskFactorOption");


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


///risk dynamic input 

// router.get("/risk/countries", getCountryRisks);
router.route("/risk/countries")
  .get(
    advancedResults(CountryRisk),
    getCountryRisks,
  );
router.post("/risk/countries", createCountryRisk);
router.put("/risk/countries/:id", updateCountryRisk);
router.delete("/risk/countries/:id", deleteCountryRisk);

// router.get("/risk/factors", getRiskFactorOptions);

router.route("/risk/factors")
  .get(
    advancedResults(RiskFactorOption),
    getRiskFactorOptions,
  );
router.post("/risk/factors", createRiskFactorOption);

router.put("/risk/factors/:id", updateRiskFactorOption);
router.delete("/risk/factors/:id", deleteRiskFactorOption);


router.get("/risk/countries/export", exportCountryRiskCsv);
router.post("/risk/countries/import", upload.single("file"), importCountryRiskCsv);

router.get("/risk/factors/export", exportRiskFactorsCsv);
router.post("/risk/factors/import", upload.single("file"), importRiskFactorsCsv);

// // Excel versions
// router.post("/risk/countries/import-excel", upload.single("file"), importCountryRiskExcel);
// router.post("/risk/factors/import-excel", upload.single("file"), importRiskFactorsExcel);



// ECDD gate decisions
router.post("/:id/ecdd-approve", ecddApprove);
router.post("/:id/ecdd-decline", ecddDecline);

// /:id must come after all named routes
router.route("/:id")
  .get(getIndividualRiskAssessment)
  .put(updateIndividualRiskAssessment);

module.exports = router;
