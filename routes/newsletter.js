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

const { protect, authorize } = require("../middleware/auth");

// Public endpoint: subscribe
router.route("/subscribe").post(subscribe);

// Admin: list / manage subscriptions
router.use(protect);
router.use(authorize("admin"));

router
  .route("/")
  .get(advancedResults(NewsletterSubscription, null), getSubscriptions);

router
  .route("/:id")
  .get(getSubscription)
  .delete(deleteSubscription);

module.exports = router;
