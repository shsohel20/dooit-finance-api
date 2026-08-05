// routes/smrs.js
const express = require("express");
const {
  getSMRs,
  getSMRsPost,
  createSMR,
  createDummySMR,
  getSMR,
  updateSMR,
  deleteSMR,
  submitSMR,
  approveSMR,
  filterSMRSection,
  exportSmrReportPdf,
} = require("../controllers/smrReportController");

const SMR = require("../models/SmrReport");
const advancedResults = require("../middleware/advancedResults");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const { protect, authorizePermission } = require("../middleware/auth");

// protect all SMR routes — access is the REPORT.SMR grant
router.use(protect);
router.use(authorizePermission("REPORT.SMR"));

// list (GET query / POST body-filter)
router
  .route("/")
  .get(
    advancedResults(
      SMR,
      ["partC.personOrganisation", "partF.transactions"],
      null,
    ),
    getSMRs,
  )
  .post(
    advancedResults(
      SMR,
      ["partC.personOrganisation", "partF.transactions"],
      filterSMRSection,
    ),
    getSMRsPost,
  );

// create
router.route("/new").post(createSMR);

// create dummy
router.route("/dummy").post(createDummySMR);

// submit & approve
router.route("/:id/submit").put(submitSMR);
router.route("/:id/approve").put(approveSMR);

// filing-grade PDF of a single report
router.route("/:id/export-pdf").get(exportSmrReportPdf);

// CRUD
router.route("/:id").get(getSMR).put(updateSMR).delete(deleteSMR);

module.exports = router;
