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
} = require("../controllers/smrReportController");

const SMR = require("../models/SmrReport");
const advancedResults = require("../middleware/advancedResults");
const router = express.Router();

const { protect, authorize } = require("../middleware/auth");

// protect all SMR routes and allow only admin by default
router.use(protect);
// router.use(authorize("admin"));

// list (GET query / POST body-filter)
router
  .route("/")
  .get(
    advancedResults(
      SMR,
      ["partC.personOrganisation", "partF.transactions"],
      null
    ),
    getSMRs
  )
  .post(
    advancedResults(
      SMR,
      ["partC.personOrganisation", "partF.transactions"],
      filterSMRSection
    ),
    getSMRsPost
  );

// create
router.route("/new").post(createSMR);

// create dummy
router.route("/dummy").post(createDummySMR);

// submit & approve
router.route("/:id/submit").put(submitSMR);
router.route("/:id/approve").put(approveSMR);

// CRUD
router.route("/:id").get(getSMR).put(updateSMR).delete(deleteSMR);

module.exports = router;
