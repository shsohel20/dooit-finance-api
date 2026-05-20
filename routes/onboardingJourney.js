const express = require("express");
const {
  postJourneyStep,
  getJourneyByCustomer,
} = require("../controllers/onboardingJourneyController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "200kb" }));

// Public: customer posts every onboarding step here using their relation invite token
router.post("/", postJourneyStep);

// Admin view: fetch journey(s) for a customer (used in customer details page tab)
router.get(
  "/customer/:customerId",
  protect,
  authorize("admin", "client", "branch", "manager"),
  getJourneyByCustomer
);

module.exports = router;
