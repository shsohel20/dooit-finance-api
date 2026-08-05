// routes/gfs.js
const express = require("express");
const {
  getGFSList,
  getGFSListPost,
  createGFS,
  createDummyGFS,
  getGFS,
  updateGFS,
  deleteGFS,
  generateReport,
  filterGFSSection,
  submitGFS,
  approveGFS,
  exportGfsReportPdf,
} = require("../controllers/gfsReportController");

const GFS = require("../models/gfsReport");
const advancedResults = require("../middleware/advancedResults");

const router = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");

// protect all routes — access is the REPORT.GFS grant
router.use(protect);
router.use(authorizePermission("REPORT.GFS"));
router.use(express.json({ limit: "100kb" }));

// list (GET with query params, POST body filter via advancedResults)
router
  .route("/")
  .get(advancedResults(GFS, null), getGFSList)
  .post(advancedResults(GFS, null, filterGFSSection), getGFSListPost);

// create new GFS
router.route("/new").post(createGFS);

// create dummy
router.route("/dummy").post(createDummyGFS);

// generate report
router.route("/:id/generate-report").put(generateReport);

router.route("/:id/submit").put(submitGFS);
router.route("/:id/approve").put(approveGFS);

// filing-grade PDF of a single report
router.route("/:id/export-pdf").get(exportGfsReportPdf);

// CRUD by id
router.route("/:id").get(getGFS).put(updateGFS).delete(deleteGFS);

module.exports = router;
