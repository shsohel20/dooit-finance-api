// routes/leads.js
const express = require("express");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const Lead = require("../models/Lead");
const advancedResults = require("../middleware/advancedResults");

const {
  createLead,
  getLeads,
  getLead,
  deleteLead,
} = require("../controllers/leadController");

const { protect, authorize } = require("../middleware/auth");

// Public endpoint: create lead
router.route("/new").post(createLead);

// Admin: list / manage leads
router.use(protect); // protect subsequent routes
router.use(authorize("admin")); // only admin (adjust roles as needed)

router.route("/").get(advancedResults(Lead, null), getLeads);

router.route("/:id").get(getLead).delete(deleteLead);

module.exports = router;
