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
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "5mb" }));
router.use(protect);

router.route("/").get(getObligations).post(createObligation);
router.route("/bulk-import").post(bulkImport);
router.route("/categories").get(getCategories);
router.route("/:obligationId").get(getObligation).put(updateObligation).delete(deleteObligation);

module.exports = router;
