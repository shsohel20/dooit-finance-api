// routes/alerts.js
const express = require("express");
const {
  getAlerts,
  getAlertsPost,
  createAlert,
  createDummyAlert,
  getAlert,
  updateAlert,
  deleteAlert,
  filterAlertSection,
  assignAnalyst,
  getDummyEccdData,
  reviewAlert,
  dismissAlert,
  escalateAlertToCase,
} = require("../controllers/alertController");

const Alert = require("../models/Alert");
const advancedResults = require("../middleware/advancedResults");

const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(express.json({ limit: "100kb" }));

// Protect all alert routes and allow only admin by default
router.use(protect);
// router.use(authorize("admin"));

// List alerts (GET with query params, POST with body filter via advancedResults)
router
  .route("/")
  .get(advancedResults(Alert, "customer analyst transaction"), getAlerts)
  .post(
    advancedResults(Alert, "customer analyst transaction", filterAlertSection),
    getAlertsPost,
  );

// Create new alert
router.route("/new").post(createAlert);

// Create dummy alert
router.route("/dummy").post(createDummyAlert);

// CRUD by id
router.route("/:id").get(getAlert).put(updateAlert).delete(deleteAlert);

router.route("/:id/assign-analyst").put(assignAnalyst);

// ── AML alert lifecycle ───────────────────────────────────────────────────────
// Analyst picks up an alert for review
router.route("/:id/review").put(reviewAlert);

// Dismiss an alert (dismissed | false_positive)
router.route("/:id/dismiss").put(dismissAlert);

// Promote an alert to a full investigation case
router.route("/:id/escalate").post(authorize("admin", "compliance_officer"), escalateAlertToCase);

router.route("/:caseNumber/eccd-dummy").get(getDummyEccdData);

module.exports = router;
