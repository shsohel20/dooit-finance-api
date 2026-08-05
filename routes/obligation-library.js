const express = require("express");
const {
  getObligations,
  getObligation,
  createObligation,
  updateObligation,
  deleteObligation,
  bulkImport,
  getCategories,
} = require("../controllers/obligationLibraryController");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "5mb" }));
router.use(protect);
// Router-level floor: any GRC grant gets in; each route below narrows by verb.
router.use(authorizePermission("GRC.GET", "GRC.ADD", "GRC.EDIT", "GRC.DELETE"));

router
  .route("/")
  .get(authorizePermission("GRC.GET"), getObligations)
  .post(authorizePermission("GRC.ADD"), createObligation);
router.route("/bulk-import").post(authorizePermission("GRC.ADD"), bulkImport);
router.route("/categories").get(authorizePermission("GRC.GET"), getCategories);
router
  .route("/:obligationId")
  .get(authorizePermission("GRC.GET"), getObligation)
  .put(authorizePermission("GRC.EDIT"), updateObligation)
  .delete(authorizePermission("GRC.DELETE"), deleteObligation);

module.exports = router;
