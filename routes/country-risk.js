const express = require("express");
const { getCountries, getCountry, updateCountry, bulkImport, lookup } = require("../controllers/countryRiskController");
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "500kb" }));
router.use(protect);

router.route("/bulk-import").post(bulkImport);
router.route("/lookup/:code").get(lookup);
router.route("/").get(getCountries);
router.route("/:code").get(getCountry).put(updateCountry);

module.exports = router;
