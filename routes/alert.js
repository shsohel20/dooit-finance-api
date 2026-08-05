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

const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();

router.use(express.json({ limit: "100kb" }));

// Every alert route needs an ALERT grant; each route below narrows by verb.
router.use(protect);
router.use(
  authorizePermission("ALERT.GET", "ALERT.ADD", "ALERT.EDIT", "ALERT.DELETE"),
);

// List alerts (GET with query params, POST with body filter via advancedResults)
router
  .route("/")
  .get(
    authorizePermission("ALERT.GET"),
    advancedResults(Alert, "customer analyst transaction"),
    getAlerts,
  )
  .post(
    authorizePermission("ALERT.GET"),
    advancedResults(Alert, "customer analyst transaction", filterAlertSection),
    getAlertsPost,
  );

// Create new alert
router.route("/new").post(authorizePermission("ALERT.ADD"), createAlert);

// Create dummy alert
router.route("/dummy").post(authorizePermission("ALERT.ADD"), createDummyAlert);

// CRUD by id
router
  .route("/:id")
  .get(authorizePermission("ALERT.GET"), getAlert)
  .put(authorizePermission("ALERT.EDIT"), updateAlert)
  .delete(authorizePermission("ALERT.DELETE"), deleteAlert);

router
  .route("/:id/assign-analyst")
  .put(authorizePermission("ALERT.EDIT"), assignAnalyst);

// ── AML alert lifecycle ───────────────────────────────────────────────────────
// Analyst picks up an alert for review
router.route("/:id/review").put(authorizePermission("ALERT.EDIT"), reviewAlert);

// Dismiss an alert (dismissed | false_positive)
router.route("/:id/dismiss").put(authorizePermission("ALERT.EDIT"), dismissAlert);

// Promote an alert to a full investigation case
router
  .route("/:id/escalate")
  .post(authorizePermission("CASE.ADD", "ALERT.EDIT"), escalateAlertToCase);

router
  .route("/:caseNumber/eccd-dummy")
  .get(authorizePermission("ALERT.GET"), getDummyEccdData);

module.exports = router;
