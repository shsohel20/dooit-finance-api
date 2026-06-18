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
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(protect);

// Special routes first (before /:id)
router.route("/domains").get(getDomains);
router.route("/bulk-import").post(bulkImport);
router.route("/assign-owner").put(assignOwner);
router.route("/sync-industry-tags").post(syncIndustryTags);
router.route("/by-obligation/:obligationId").get(getByObligation);

// CRUD
router.route("/").get(getControls).post(createControl);
router.route("/:id").get(getControl).put(updateControl).delete(deleteControl);

module.exports = router;
