// routes/contact.js
const express = require("express");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const Contact = require("../models/Contact");
const advancedResults = require("../middleware/advancedResults");

const {
  createContact,
  getContacts,
  getContact,
  deleteContact,
} = require("../controllers/contactController");

const { protect, authorize } = require("../middleware/auth");

// Public endpoint: submit contact form
router.route("/new").post(createContact);

// Admin: list / manage contacts
router.use(protect);
router.use(authorize("admin"));

router.route("/").get(advancedResults(Contact, null), getContacts);

router.route("/:id").get(getContact).delete(deleteContact);

module.exports = router;
