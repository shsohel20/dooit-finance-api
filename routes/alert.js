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

module.exports = router;
