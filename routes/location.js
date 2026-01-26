const express = require("express");

const { getLocations } = require("../controllers/locationController");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

router.route("/").get(getLocations);

module.exports = router;
