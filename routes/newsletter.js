// routes/newsletter.js
const express = require("express");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const NewsletterSubscription = require("../models/NewsletterSubscription");
const advancedResults = require("../middleware/advancedResults");

const {
  subscribe,
  getSubscriptions,
  getSubscription,
  deleteSubscription,
} = require("../controllers/newsletterController");

const { protect, authorizePermission } = require("../middleware/auth");

// Public endpoint: subscribe
router.route("/subscribe").post(subscribe);

// Admin: list / manage subscriptions
router.use(protect);
router.use(authorizePermission("NEWSLETTER.GET", "NEWSLETTER.DELETE"));

router
  .route("/")
  .get(advancedResults(NewsletterSubscription, null), getSubscriptions);

router
  .route("/:id")
  .get(authorizePermission("NEWSLETTER.GET"), getSubscription)
  .delete(authorizePermission("NEWSLETTER.DELETE"), deleteSubscription);

module.exports = router;
