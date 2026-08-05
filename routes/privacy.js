const express = require("express");
const {
  getUserPrivacyStatus,
  updateUserEncryption,
  bulkUpdateUserEncryption,
  getCustomerPrivacyStatus,
  updateCustomerEncryption,
  bulkUpdateCustomerEncryption,
  bulkUpdateAllEncryption,
  getSnapshots,
  getSnapshot,
  restoreSnapshot,
  getSnapshotVersions,
  bulkRestoreSnapshots,
} = require("../controllers/privacyController");

const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "10kb" }));

// All privacy routes require authentication and a PRIVACY grant
router.use(protect);
router.use(authorizePermission("PRIVACY.ENCRYPT", "PRIVACY.DECRYPT"));

// ── User encryption management ────────────────────────────────────────────────
// GET  /api/v1/privacy/user/:id            → encryption status
// PUT  /api/v1/privacy/user/:id            → { encrypted: true|false }
router
  .route("/user/:id")
  .get(authorizePermission("PRIVACY.ENCRYPTVIEW", "PRIVACY.ENCRYPT", "PRIVACY.DECRYPT"), getUserPrivacyStatus)
  .put(authorizePermission("PRIVACY.ENCRYPT", "PRIVACY.DECRYPT"), updateUserEncryption);

// PUT  /api/v1/privacy/users/bulk          → { encrypted: true|false }
router.route("/users/bulk").put(bulkUpdateUserEncryption);

// ── Customer encryption management ───────────────────────────────────────────
// GET  /api/v1/privacy/customer/:id        → encryption status
// PUT  /api/v1/privacy/customer/:id        → { encrypted: true|false }
router
  .route("/customer/:id")
  .get(getCustomerPrivacyStatus)
  .put(updateCustomerEncryption);

// PUT  /api/v1/privacy/customers/bulk      → { encrypted: true|false }
router.route("/customers/bulk").put(bulkUpdateCustomerEncryption);

// ── Combined ──────────────────────────────────────────────────────────────────
// PUT  /api/v1/privacy/all/bulk            → { encrypted: true|false }
router.route("/all/bulk").put(bulkUpdateAllEncryption);

// ── Snapshots ─────────────────────────────────────────────────────────────────
// GET  /api/v1/privacy/snapshots                      → list  (?modelType&operation&version&documentId&isRestored)
// GET  /api/v1/privacy/snapshots/versions             → version history for a document (?modelType&documentId)
// POST /api/v1/privacy/snapshots/bulk-restore         → bulk restore (?modelType, operation?, version?)
// GET  /api/v1/privacy/snapshots/:id                  → single snapshot
// POST /api/v1/privacy/snapshots/:id/restore          → single restore
// Static paths (/versions, /bulk-restore) MUST come before /:id to avoid param clash
router.route("/snapshots").get(getSnapshots);
router.route("/snapshots/versions").get(getSnapshotVersions);
router.route("/snapshots/bulk-restore").post(bulkRestoreSnapshots);
router.route("/snapshots/:id").get(getSnapshot);
router.route("/snapshots/:id/restore").post(restoreSnapshot);

module.exports = router;