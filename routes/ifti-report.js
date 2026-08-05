// routes/ifti.js
const express = require("express");
const {
  getIFTIs,
  getIFTIsPost,
  createIFTI,
  createDummyIFTI,
  getIFTI,
  updateIFTI,
  deleteIFTI,
  generateReport,
  submitIFTI,
  approveIFTI,
  filterIFTISection,
} = require("../controllers/iftiController");

const IFTI = require("../models/IftiReport");
const advancedResults = require("../middleware/advancedResults");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const { protect, authorizePermission } = require("../middleware/auth");

// protect routes — access is the REPORT.IFTI grant
router.use(protect);
router.use(authorizePermission("REPORT.IFTI"));

// list
router
  .route("/")
  .get(advancedResults(IFTI, null), getIFTIs)
  .post(advancedResults(IFTI, null, filterIFTISection), getIFTIsPost);

// create
router.route("/new").post(createIFTI);
router.route("/dummy").post(createDummyIFTI);

// actions
router.route("/:id/generate-report").put(generateReport);
router.route("/:id/submit").put(submitIFTI);
router.route("/:id/approve").put(approveIFTI);

// CRUD
router.route("/:id").get(getIFTI).put(updateIFTI).delete(deleteIFTI);

module.exports = router;
