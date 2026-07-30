/**
 * routes/sumsub.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sumsub KYC + AML routes
 *
 * IMPORTANT — webhook route:
 *   Must use express.raw() NOT express.json() so that the raw Buffer is
 *   available on req.body for HMAC verification.
 *   It is mounted BEFORE the json() middleware via the rawBodyParser below.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const express = require("express");
const {
  createApplicant,
  uploadDocument,
  requestCheck,
  getApplicantStatus,
  triggerAml,
  getAmlCase,
  sumsubWebhook,
  getVerificationResult,
} = require("../controllers/sumsubController");

const {
  getAmlMatches,
  updateAmlMatch,
  bulkUpdateAmlMatches,
} = require("../controllers/amlMatchController");

const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// ── Webhook — raw body REQUIRED for HMAC ─────────────────────────────────────
// Mount this BEFORE any json() middleware on the router
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  sumsubWebhook,
);

// ── Public routes (customer uses invite token) ────────────────────────────────
// Apply JSON parsing only for non-webhook routes
router.use(express.json({ limit: "15mb" }));

// Step 1: Create Sumsub applicant  (public — invite token OR admin customerId)
router.post("/applicant", createApplicant);

// Step 2: Upload documents / selfie to Sumsub
router.post("/upload-document", uploadDocument);

// Step 3: Trigger Sumsub AI verification
router.post("/request-check", requestCheck);

// ── Protected routes (admin / client / manager) ───────────────────────────────

// Step 4: Get current KYC status from Sumsub
router.get(
  "/status/:customerId",
  protect,
  authorize("admin", "client", "branch", "manager"),
  getApplicantStatus,
);

// Step 5: Manually trigger AML check (also auto-triggered after KYC GREEN webhook)
router.post(
  "/aml-check/:customerId",
  protect,
  authorize("admin", "client", "manager"),
  triggerAml,
);

// Step 6: Get full AML case data
router.get(
  "/aml-case/:customerId",
  protect,
  authorize("admin", "client", "branch", "manager"),
  getAmlCase,
);

// Step 7: Per-match compliance review (analyst dispositions)
router.get(
  "/aml-matches/:customerId",
  protect,
  authorize("admin", "client", "branch", "manager"),
  getAmlMatches,
);
// Bulk disposition — MUST be declared before "/aml-matches/:id" so the literal
// "bulk" segment is not captured as an :id param.
router.patch(
  "/aml-matches/bulk",
  protect,
  authorize("admin", "client", "branch", "manager"),
  bulkUpdateAmlMatches,
);
router.patch(
  "/aml-matches/:id",
  protect,
  authorize("admin", "client", "branch", "manager"),
  updateAmlMatch,
);
router.get(
  "/resources/checks/latest/:applicantId",
  protect,
  authorize("admin", "client", "branch", "manager"),
  getVerificationResult,
);

module.exports = router;
