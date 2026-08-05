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

const { protect, authorizePermission } = require("../middleware/auth");

// Public endpoint: submit contact form
router.route("/new").post(createContact);

// Admin: list / manage contacts
router.use(protect);
router.use(authorizePermission("CONTACT.GET", "CONTACT.DELETE"));

router.route("/").get(advancedResults(Contact, null), getContacts);

router
  .route("/:id")
  .get(authorizePermission("CONTACT.GET"), getContact)
  .delete(authorizePermission("CONTACT.DELETE"), deleteContact);

module.exports = router;
