// routes/dismissal-report.js
//
// Alert dismissal records (docs/74 §4.5, phase C5). Creation lives with the
// other reports — POST /cases/:id/reports/dismissal/draft — because a
// dismissal is built from the case's own facts; this router owns the rest of
// the lifecycle.
//
// Permissions follow the alert lifecycle rather than the REPORT.* grants:
// dismissing an alert is an analyst action, and the record is its evidence.

const express = require("express");
const {
  getDismissalTypes,
  getDismissals,
  getDismissal,
  updateDismissal,
  approveDismissal,
  withdrawDismissal,
  exportDismissalPdf,
} = require("../controllers/dismissalController");

const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));
router.use(protect);
router.use(authorizePermission("ALERT.GET", "ALERT.EDIT"));

// The industry templates (before /:id so the word "types" is not read as an id)
router.route("/types").get(authorizePermission("ALERT.GET"), getDismissalTypes);

// List
router.route("/").get(authorizePermission("ALERT.GET"), getDismissals);

// Read + edit one
router
  .route("/:id")
  .get(authorizePermission("ALERT.GET"), getDismissal)
  .put(authorizePermission("ALERT.EDIT"), updateDismissal);

// Four-eyes sign-off, and undoing one
router.route("/:id/approve").put(authorizePermission("ALERT.EDIT"), approveDismissal);
router.route("/:id/withdraw").put(authorizePermission("ALERT.EDIT"), withdrawDismissal);

// The artefact handed to an auditor
router.route("/:id/export-pdf").get(authorizePermission("ALERT.GET"), exportDismissalPdf);

module.exports = router;
