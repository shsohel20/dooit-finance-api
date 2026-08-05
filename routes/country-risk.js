const express = require("express");
const { getCountries, getCountry, updateCountry, bulkImport, lookup } = require("../controllers/countryRiskController");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "500kb" }));
router.use(protect);
// Reference data: readable with REFERENCE.GET, writable with REFERENCE.EDIT.
router.use(authorizePermission("REFERENCE.GET", "REFERENCE.EDIT"));

router.route("/bulk-import").post(authorizePermission("REFERENCE.EDIT"), bulkImport);
router.route("/lookup/:code").get(authorizePermission("REFERENCE.GET"), lookup);
router.route("/").get(authorizePermission("REFERENCE.GET"), getCountries);
router
  .route("/:code")
  .get(authorizePermission("REFERENCE.GET"), getCountry)
  .put(authorizePermission("REFERENCE.EDIT"), updateCountry);

module.exports = router;
