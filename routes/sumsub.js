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

const { protect, authorizePermission } = require("../middleware/auth");

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

// ── Protected routes (SUMSUB.* permission holders) ────────────────────────────

// Step 4: Get current KYC status from Sumsub
router.get(
  "/status/:customerId",
  protect,
  authorizePermission("SUMSUB.GET"),
  getApplicantStatus,
);

// Step 5: Manually trigger AML check (also auto-triggered after KYC GREEN webhook)
router.post(
  "/aml-check/:customerId",
  protect,
  authorizePermission("SUMSUB.EDIT"),
  triggerAml,
);

// Step 6: Get full AML case data
router.get(
  "/aml-case/:customerId",
  protect,
  authorizePermission("SUMSUB.GET"),
  getAmlCase,
);

// Step 7: Per-match compliance review (analyst dispositions)
router.get(
  "/aml-matches/:customerId",
  protect,
  authorizePermission("SUMSUB.GET"),
  getAmlMatches,
);
// Bulk disposition — MUST be declared before "/aml-matches/:id" so the literal
// "bulk" segment is not captured as an :id param.
router.patch(
  "/aml-matches/bulk",
  protect,
  authorizePermission("SUMSUB.EDIT"),
  bulkUpdateAmlMatches,
);
router.patch(
  "/aml-matches/:id",
  protect,
  authorizePermission("SUMSUB.EDIT"),
  updateAmlMatch,
);
router.get(
  "/resources/checks/latest/:applicantId",
  protect,
  authorizePermission("SUMSUB.GET"),
  getVerificationResult,
);

module.exports = router;
