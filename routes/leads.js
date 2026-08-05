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

const { protect, authorizePermission } = require("../middleware/auth");

// Public endpoint: create lead
router.route("/new").post(createLead);

// Admin: list / manage leads
router.use(protect); // protect subsequent routes
router.use(authorizePermission("LEAD.GET", "LEAD.DELETE"));

router.route("/").get(advancedResults(Lead, null), getLeads);

router
  .route("/:id")
  .get(authorizePermission("LEAD.GET"), getLead)
  .delete(authorizePermission("LEAD.DELETE"), deleteLead);

module.exports = router;
