/**
 * services/sumsubService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure Sumsub business logic — no Express dependency.
 * Controllers stay thin; all Sumsub API orchestration lives here.
 *
 * Exports:
 *   ensureSumsubApplicant(customer)     — idempotent applicant creation
 *   buildApplicantPayload(customer)     — construct Sumsub API request body
 *   triggerAmlCheck(customer)          — POST /recheck/aml (safe, logs on fail)
 *   handleKycResult(customer, payload) — process KYC webhook result → save Customer + Journey
 *   handleAmlResult(customer, payload) — process AML webhook result → save Customer + Journey
 *   resolveCustomerByToken(token)      — resolve Customer from relation invite token
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const Customer = require("../models/Customer");
const OnboardingJourney = require("../models/OnboardingJourney");
const { hashToken } = require("../utils");
const ErrorResponse = require("../utils/errorResponse");
const { sumsubPost, sumsubGet } = require("../utils/sumsubClient");
const { toAlpha3 } = require("../utils/countryUtils");
const { syncJourneyStatus } = require("./journeyService");

const LEVEL_NAME = () => process.env.SUMSUB_LEVEL_NAME || "kyc-level";

// ─────────────────────────────────────────────────────────────────────────────
// 1. resolveCustomerByToken
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a Customer document from a relation-scoped invite token.
 * Returns { customer, relation, relationIndex } on success.
 * Returns { error: ErrorResponse } on failure — caller must handle.
 *
 * @param {string} token — plain invite token from the client
 * @returns {Promise<{ customer, relation, relationIndex } | { error: ErrorResponse }>}
 */
const resolveCustomerByToken = async (token) => {
  if (!token) {
    return { error: new ErrorResponse("Invite token is required", 400) };
  }

  const hashed = hashToken(token);
  const customer = await Customer.findOne({ "relations.inviteToken": hashed });
  if (!customer) {
    return { error: new ErrorResponse("Invite not found", 404) };
  }

  const match = customer.findRelationByHashedToken(hashed);
  if (!match) {
    return { error: new ErrorResponse("Invalid invite token", 400) };
  }

  const { relation, index: relationIndex } = match;

  if (
    !relation.inviteTokenExpire ||
    Date.now() > new Date(relation.inviteTokenExpire).getTime()
  ) {
    return { error: new ErrorResponse("Invite has expired", 410) };
  }

  return { customer, relation, relationIndex };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildApplicantPayload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Sumsub createApplicant request body from a Customer document.
 * Sumsub prefers OCR to extract name/address; we pass what we have.
 *
 * @param {Customer} customer
 * @returns {Object} — Sumsub API request payload
 */
const buildApplicantPayload = (customer) => {
  const pf = customer.personalKyc?.personal_form || {};
  const cd = pf.customer_details || {};
  const co = pf.contact_details || {};
  const cm = customer.metadata || {};

  return {
    externalUserId: customer._id.toString(), // our Customer._id — returned in every webhook
    email: co.email || cm.email || undefined,
    phone: co.phone || cm.phone || undefined,
    fixedInfo: {
      country: customer.country
        ? (toAlpha3(customer.country) ?? undefined)
        : undefined,
      dob: cd.date_of_birth
        ? new Date(cd.date_of_birth).toISOString().split("T")[0]
        : undefined,
    },
    lang: "en",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. ensureSumsubApplicant  (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Idempotent Sumsub applicant creation.
 *
 * Decision tree:
 *   A) sumsubApplicantId exists locally
 *      → verify it still exists in Sumsub (GET /one)
 *        ✓ alive   → return existing, no-op
 *        ✗ 404     → applicant was deleted; clear local ID, fall through to C
 *
 *   B) No local ID — check Sumsub by externalUserId
 *      (GET /applicants/-;externalUserId={id}/one)
 *        ✓ found   → save applicantId to Customer, return
 *        ✗ not found → fall through to C
 *
 *   C) Create new applicant in Sumsub
 *      → save applicantId + inspectionId to Customer
 *
 * @param {Customer} customer — mongoose document (will be mutated + saved)
 * @returns {Promise<{ created: boolean, applicantId: string, inspectionId?: string }>}
 * @throws {Error} if Sumsub API returns an error during creation
 */
const ensureSumsubApplicant = async (customer) => {
  // ── A: Local ID exists — verify it's still live in Sumsub ─────────────────
  if (customer.sumsubApplicantId) {
    const { status } = await sumsubGet(
      `/resources/applicants/${customer.sumsubApplicantId}/one`,
    );

    // return {
    //   created: false,
    //   applicantId: customer.sumsubApplicantId,
    //   inspectionId: customer.sumsubInspectionId,
    // };

    if (status === 201) {
      // Applicant is alive — nothing to create
      return {
        created: false,
        applicantId: customer.sumsubApplicantId,
        inspectionId: customer.sumsubInspectionId,
      };
    }

    // Applicant was deleted or not found — clear stale local reference
    if (status === 404) {
      customer.sumsubApplicantId = null;
      customer.sumsubInspectionId = null;
      // Do NOT save yet — will save after creation
    }
  }

  // ── B: Lookup by externalUserId in Sumsub ─────────────────────────────────
  const extId = encodeURIComponent(customer._id.toString());
  const { status: lookupStatus, data: lookupData } = await sumsubGet(
    `/resources/applicants/-;externalUserId=${extId}/one`,
  );

  if (lookupStatus === 200 && lookupData?.id) {
    // Found in Sumsub — sync local record
    customer.sumsubApplicantId = lookupData.id;
    customer.sumsubInspectionId = lookupData.inspectionId || null;
    await customer.save();

    return {
      created: false,
      applicantId: lookupData.id,
      inspectionId: lookupData.inspectionId,
    };
  }

  // ── C: Create new applicant ────────────────────────────────────────────────
  const levelName = encodeURIComponent(LEVEL_NAME());
  const payload = buildApplicantPayload(customer);
  console.log(payload);
  const { status: createStatus, data: createData } = await sumsubPost(
    `/resources/applicants?levelName=${levelName}`,
    payload,
  );

  if (createStatus >= 400) {
    const msg =
      createData?.description ||
      createData?.message ||
      JSON.stringify(createData);
    throw new Error(`Sumsub createApplicant failed (${createStatus}): ${msg}`);
  }

  customer.sumsubApplicantId = createData.id;
  customer.sumsubInspectionId = createData.inspectionId || null;
  customer.kycStatus = "pending";
  await customer.save();

  return {
    created: true,
    applicantId: createData.id,
    inspectionId: createData.inspectionId || null,
    reviewStatus: createData.review?.reviewStatus,
    requiredDocSets: createData.requiredIdDocs?.docSets,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. triggerAmlCheck
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trigger Sumsub AML/PEP/Sanctions screening for a verified customer.
 * Safe to call — catches and logs errors instead of throwing,
 * so it can be used as a fire-and-log operation after KYC GREEN.
 *
 * @param {Customer} customer — mongoose document (will update amlStatus)
 * @returns {Promise<boolean>} — true if triggered successfully
 */
const triggerAmlCheck = async (customer) => {
  if (!customer?.sumsubApplicantId) return false;

  try {
    const { status, data } = await sumsubPost(
      `/resources/applicants/${customer.sumsubApplicantId}/recheck/aml`,
      {},
    );

    if (status >= 400) {
      console.error(
        `[SumsubService] AML trigger failed (${status}):`,
        data?.description || data?.message,
      );
      return false;
    }

    customer.amlStatus = "pending";
    await customer.save();
    return true;
  } catch (err) {
    console.error("[SumsubService] AML trigger exception:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. handleKycResult  (called from webhook handler)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a Sumsub KYC webhook result:
 *   - Updates Customer.kycStatus + kycHistory
 *   - Updates OnboardingJourney id_document + selfie steps
 *   - Auto-triggers AML check if GREEN
 *
 * @param {Customer} customer
 * @param {Object}   reviewResult  — from Sumsub webhook payload.reviewResult
 * @param {string}   applicantId   — Sumsub applicantId (for journey lookup)
 */
const handleKycResult = async (customer, reviewResult = {}, applicantId) => {
  const { reviewAnswer, reviewRejectType, rejectLabels, moderationComment } =
    reviewResult;

  // ── Map Sumsub result → our kycStatus enum ─────────────────────────────────
  let kycStatus, kycNote, stepStatus, rejectionReason;

  if (reviewAnswer === "GREEN") {
    kycStatus = "verified";
    stepStatus = "approved";
    kycNote = "Sumsub KYC verified";
  } else if (reviewRejectType === "RETRY") {
    kycStatus = "pending"; // allow customer to re-upload
    stepStatus = "rejected";
    kycNote =
      moderationComment || (rejectLabels || []).join(", ") || "Retry required";
    rejectionReason = kycNote;
  } else {
    // RED + FINAL — permanent rejection
    kycStatus = "rejected";
    stepStatus = "rejected";
    kycNote = (rejectLabels || []).join(", ") || "Permanently rejected";
    rejectionReason = kycNote;
  }

  // ── Update Customer ────────────────────────────────────────────────────────
  customer.kycStatus = kycStatus;
  if (reviewAnswer === "GREEN") customer.kycVerifiedAt = new Date();
  customer.kycRawResult = reviewResult;
  if (rejectionReason) customer.kycRejectReason = rejectionReason;
  customer.kycHistory.push({
    status: kycStatus,
    note: kycNote,
    changedAt: new Date(),
  });
  await customer.save();

  // ── Update all Sumsub-linked journeys ─────────────────────────────────────
  const journeys = await OnboardingJourney.find({
    customer: customer._id,
    provider: "sumsub",
  });

  const providerData = {
    sumsubReviewAnswer: reviewAnswer,
    sumsubRejectType: reviewRejectType,
    rejectLabels,
    moderationComment,
    checkedAt: new Date(),
  };

  for (const journey of journeys) {
    journey.setStepStatus("id_document", stepStatus, {
      data: providerData,
      rejectionReason,
      bumpAttempt: false,
    });
    journey.setStepStatus("selfie", stepStatus, {
      data: providerData,
      rejectionReason,
      bumpAttempt: false,
    });
    journey.recordEvent({
      step: "id_document",
      action: "sumsub_kyc_result",
      status: stepStatus,
      note: kycNote,
      actorRole: "system",
      payload: { reviewAnswer, reviewRejectType, rejectLabels, applicantId },
    });
    syncJourneyStatus(journey);
    await journey.save();
  }

  // ── Auto-trigger AML after GREEN ──────────────────────────────────────────
  if (reviewAnswer === "GREEN") {
    await triggerAmlCheck(customer);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. handleAmlResult  (called from webhook handler)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a Sumsub AML webhook result:
 *   - Fetches full AML case (riskLabels + hits)
 *   - Updates Customer.amlStatus, isPep, sanction, amlRiskLabels, amlHits
 *   - Updates OnboardingJourney review step
 *
 * @param {Customer} customer
 * @param {string}   reviewAnswer  — 'GREEN' | 'RED' | 'YELLOW'
 * @param {string}   applicantId
 */
const handleAmlResult = async (customer, reviewAnswer, applicantId) => {
  // ── Fetch full AML case for riskLabels + hits ──────────────────────────────
  let riskLabels = [],
    hits = [],
    vendor = null;

  try {
    const { status, data } = await sumsubGet(
      `/resources/api/applicants/${applicantId}/amlCase`,
    );
    if (status === 200) {
      riskLabels = data?.riskLabels || [];
      hits = data?.hits || [];
      vendor = data?.vendorAttribution || null;
    }
  } catch (err) {
    console.error("[SumsubService] Failed to fetch AML case:", err.message);
  }

  // ── Map to our amlStatus enum ──────────────────────────────────────────────
  const amlStatus =
    reviewAnswer === "GREEN"
      ? "clear"
      : reviewAnswer === "YELLOW"
        ? "yellow"
        : "flagged";

  // ── Update Customer ────────────────────────────────────────────────────────
  customer.amlStatus = amlStatus;
  customer.amlRiskLabels = riskLabels;
  customer.amlHits = hits;
  customer.amlCheckedAt = new Date();
  customer.amlVendor = vendor;
  if (riskLabels.includes("pep")) customer.isPep = true;
  if (riskLabels.includes("sanctions")) customer.sanction = true;
  await customer.save();

  // ── Update all Sumsub-linked journeys — review step ───────────────────────
  const journeys = await OnboardingJourney.find({
    customer: customer._id,
    provider: "sumsub",
  });

  const reviewStepStatus = amlStatus === "clear" ? "approved" : "rejected";
  const amlNote =
    amlStatus !== "clear"
      ? `AML screening: ${riskLabels.join(", ") || reviewAnswer}`
      : "AML screening: clear";

  for (const journey of journeys) {
    journey.setStepStatus("review", reviewStepStatus, {
      data: {
        amlStatus,
        riskLabels,
        hitsCount: hits.length,
        vendor,
        checkedAt: new Date(),
      },
      rejectionReason: amlStatus !== "clear" ? amlNote : undefined,
      bumpAttempt: false,
    });
    journey.recordEvent({
      step: "review",
      action: "sumsub_aml_result",
      status: reviewStepStatus,
      note: amlNote,
      actorRole: "system",
      payload: { amlStatus, riskLabels, hitsCount: hits.length, applicantId },
    });
    syncJourneyStatus(journey);
    await journey.save();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  resolveCustomerByToken,
  buildApplicantPayload,
  ensureSumsubApplicant,
  triggerAmlCheck,
  handleKycResult,
  handleAmlResult,
};
