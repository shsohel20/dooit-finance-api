const express = require("express");
const {
  postJourneyStep,
  getJourneyByCustomer,
  reviewJourneyStep,
  livenessDetection,
  verifyDocAndFace,
  ocrDocument,
} = require("../controllers/onboardingJourneyController");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "15mb" }));

// Public: customer posts every onboarding step here using their relation invite token
router.post("/", protect, postJourneyStep);

// Public: liveness verification via third-party API (uses relation invite token)
router.post("/liveness-detection", protect, livenessDetection);

// Public: document + face verification via AI API (uses relation invite token)
router.post("/verify-doc-face", protect, verifyDocAndFace);

// Public: OCR document data extraction via AFC KYC OCR API (uses relation invite token)
router.post("/ocr-document", protect, ocrDocument);

// Admin view: fetch journey(s) for a customer (used in customer details page tab)
router.get(
  "/customer/:customerId",
  protect,
  // authorize("admin", "client", "branch", "manager"),
  getJourneyByCustomer
);

// Admin action: approve/reject a single step (populates event.actor with the reviewer)
router.patch(
  "/:journeyId/step/:stepType",
  protect,
  authorize("admin", "client", "branch", "manager"),
  reviewJourneyStep
);

module.exports = router;
