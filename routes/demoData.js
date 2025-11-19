// routes/demoDataes.js
const express = require("express");

const DemoData = require("../models/DemoData");
const advancedResults = require("../middleware/advancedResults");
const {
  getDemoDataes,
  getDemoData,
  filterDemoDataSection,
  createDemo,
} = require("../controllers/demoDataController");

const router = express.Router();

// list (supports GET with query params and POST with body-filter via advancedResults)
router
  .route("/")
  .post(advancedResults(DemoData, null, filterDemoDataSection), getDemoDataes)
  .get(advancedResults(DemoData), getDemoDataes);

// CRUD by id
router.route("/:id").get(getDemoData);
router.route("/create").post(createDemo);

module.exports = router;
