const express = require("express");
const {
  getControls,
  getDomains,
  getControl,
  createControl,
  updateControl,
  deleteControl,
  bulkImport,
  assignOwner,
  getByObligation,
  syncIndustryTags,
} = require("../controllers/controlController");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(protect);
// Router-level floor: any GRC grant gets in; each route below narrows by verb.
router.use(authorizePermission("GRC.GET", "GRC.ADD", "GRC.EDIT", "GRC.DELETE"));

// Special routes first (before /:id)
router.route("/domains").get(authorizePermission("GRC.GET"), getDomains);
router.route("/bulk-import").post(authorizePermission("GRC.ADD"), bulkImport);
router.route("/assign-owner").put(authorizePermission("GRC.EDIT"), assignOwner);
router
  .route("/sync-industry-tags")
  .post(authorizePermission("GRC.EDIT"), syncIndustryTags);
router
  .route("/by-obligation/:obligationId")
  .get(authorizePermission("GRC.GET"), getByObligation);

// CRUD
router
  .route("/")
  .get(authorizePermission("GRC.GET"), getControls)
  .post(authorizePermission("GRC.ADD"), createControl);
router
  .route("/:id")
  .get(authorizePermission("GRC.GET"), getControl)
  .put(authorizePermission("GRC.EDIT"), updateControl)
  .delete(authorizePermission("GRC.DELETE"), deleteControl);

module.exports = router;
