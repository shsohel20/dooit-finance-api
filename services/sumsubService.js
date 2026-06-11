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
const AuditLog = require("../models/AuditLog");
const { hashToken } = require("../utils");
const ErrorResponse = require("../utils/errorResponse");
const {
  sumsubPost,
  sumsubGet,
  sumsubPatch,
  sumsubPostForm,
  buildDocFormData,
} = require("../utils/sumsubClient");
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
 * @param {Object}   reviewResult   — from Sumsub webhook payload.reviewResult
 * @param {string}   applicantId    — Sumsub applicantId (for journey lookup)
 * @param {string}   reviewStatus   — top-level webhook reviewStatus (e.g. "completed")
 * @param {string}   clientComment  — human-readable rejection reason from reviewResult
 */
const handleKycResult = async (
  customer,
  reviewResult = {},
  applicantId,
  reviewStatus,
) => {
  const { reviewAnswer, reviewRejectType, rejectLabels, moderationComment } =
    reviewResult;
  const effectiveClientComment = reviewResult.clientComment || "";

  // ── Map Sumsub result → our kycStatus enum ─────────────────────────────────
  let kycStatus, kycNote, stepStatus, rejectionReason;

  if (reviewAnswer === "GREEN") {
    kycStatus = "verified";
    stepStatus = "approved";
    // kycNote = "Sumsub KYC verified";
    kycNote = "KYC verified";
  } else if (reviewRejectType === "RETRY") {
    kycStatus = "pending"; // allow customer to re-upload
    stepStatus = "rejected";
    kycNote =
      moderationComment || (rejectLabels || []).join(", ") || "Retry required";
    rejectionReason = effectiveClientComment || kycNote;
  } else {
    // RED + FINAL — permanent rejection
    kycStatus = "rejected";
    stepStatus = "rejected";
    kycNote = (rejectLabels || []).join(", ") || "Permanently rejected";
    rejectionReason = effectiveClientComment || kycNote;
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
    reviewStatus,
    rejectLabels,
    moderationComment,
    clientComment: effectiveClientComment,
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
      action: "kyc_result",
      status: stepStatus,
      note: kycNote,
      actorRole: "system",
      payload: {
        reviewAnswer,
        reviewRejectType,
        reviewStatus,
        rejectLabels,
        clientComment: effectiveClientComment,
        applicantId,
      },
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
      action: "aml_result",
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
// 7. requestPendingReview  — move applicant → "pending" (triggers Sumsub AI check)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Submit a Sumsub applicant for AI verification (move to pending status).
 * Idempotent — Sumsub returns 409 when the applicant is already pending/queued.
 *
 * @param {string}      applicantId
 * @param {string|null} reason      — optional rejection/re-submission reason
 * @returns {Promise<{ status: number, data: object }>}
 */
const requestPendingReview = async (applicantId, reason) => {
  const reasonParam = reason ? `?reason=${encodeURIComponent(reason)}` : "";
  return sumsubPost(
    `/resources/applicants/${applicantId}/status/pending${reasonParam}`,
    {},
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. getApplicant  — fetch full applicant record from Sumsub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the full Sumsub applicant object (review status, review result, docs…).
 *
 * @param {string} applicantId
 * @returns {Promise<{ status: number, data: object }>}
 */
const getApplicant = async (applicantId) =>
  sumsubGet(`/resources/applicants/${applicantId}/one`);

// ─────────────────────────────────────────────────────────────────────────────
// 9. syncApplicantFromOcr  — background PATCH /info + /fixedInfo with retries
// ─────────────────────────────────────────────────────────────────────────────

/** Pause execution for `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry `fn` up to `maxAttempts` times with exponential back-off.
 * Retries on network errors and on upstream 5xx / 429 responses.
 * Returns the last { status, data, attempts } result even when the final
 * attempt fails — `attempts` is how many calls were actually made.
 *
 * @param {() => Promise<{status:number,data:object}>} fn
 * @param {number} maxAttempts
 * @param {number} baseDelayMs  — first delay; doubles each retry (2 s → 4 s → 8 s)
 */
const withRetry = async (fn, maxAttempts = 3, baseDelayMs = 2_000) => {
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      last = await fn();
      // Don't retry on clean 4xx (client error) — only on 5xx / 429 / network
      if (last.status < 500 && last.status !== 429) {
        return { ...last, attempts: attempt };
      }
    } catch (err) {
      last = { status: 0, data: { description: err.message } };
    }
    if (attempt < maxAttempts) {
      await sleep(baseDelayMs * 2 ** (attempt - 1)); // 2 s, 4 s, 8 s …
    }
  }
  return { ...last, attempts: maxAttempts };
};

/**
 * Persist one AuditLog record for a background Sumsub job
 * (service is always "sumsub" here).
 * Never throws — audit failures are logged and swallowed so they can't
 * break the fire-and-forget chains that call this.
 */
const recordSyncAudit = async (entry) => {
  try {
    await AuditLog.create({ service: "sumsub", ...entry });
  } catch (err) {
    console.error("[SumsubAudit] Failed to write audit record:", err.message);
  }
};

/**
 * Map OCR fields → Sumsub /info (and /fixedInfo) body.
 * Only non-null, mappable fields are included.
 *
 * OCR source fields used:
 *   full_name       → firstName + lastName  (split on last whitespace token)
 *   date_of_birth   → dob  (parses "31 Dec 1990" → "1990-12-31")
 *   issuing_country → country  (any format → alpha-3 via toAlpha3)
 *   nationality     → nationality  (alpha-3)
 *   sex             → gender  ("M"/"Male" → "M", "F"/"Female" → "F")
 *   place_of_birth  → placeOfBirth
 *
 * @param {Object} f — OCR fields object
 * @returns {Object} — Sumsub-compatible payload (empty object if nothing to send)
 */
const buildInfoPayloadFromOcr = (f = {}) => {
  // ── Name ──────────────────────────────────────────────────────────────────
  const fullName = (f.full_name || "").trim();
  let firstName = null,
    lastName = null;
  if (fullName) {
    const parts = fullName.split(/\s+/);
    lastName = parts.length > 1 ? parts.pop() : null;
    firstName = parts.join(" ") || null;
  }

  // ── Date of birth ─────────────────────────────────────────────────────────
  // OCR returns e.g. "31 Dec 1990" — need ISO "1990-12-31"
  let dob = null;
  if (f.date_of_birth) {
    const parsed = new Date(f.date_of_birth);
    if (!isNaN(parsed.getTime())) {
      dob = parsed.toISOString().split("T")[0];
    }
  }

  let addresses = [];

  // ── Country / nationality ─────────────────────────────────────────────────
  const country = f.issuing_country ? toAlpha3(f.issuing_country) : null;
  const nationality = f.nationality ? toAlpha3(f.nationality) : null;

  // ── Gender ────────────────────────────────────────────────────────────────
  let gender = null;
  const sexRaw = (f.sex || "").trim().toUpperCase();
  if (sexRaw === "M" || sexRaw === "MALE") gender = "M";
  else if (sexRaw === "F" || sexRaw === "FEMALE") gender = "F";

  // ── Place of birth ────────────────────────────────────────────────────────
  const placeOfBirth = f.place_of_birth || null;
  const countryOfBirth = f.place_of_birth || null;

  // ── Address ───────────────────────────────────────────────────────────────
  // Prefer address_breakdown fields; fall back to issuing country for country.
  const aCountry = f?.address_breakdown?.country
    ? toAlpha3(f.address_breakdown.country)
    : country;
  const street = f?.address_breakdown?.street || null;
  const town = f?.address_breakdown?.city || null;
  const state = f?.address_breakdown?.state || null;
  const postCode = f?.address_breakdown?.postcode || null;
  const formattedAddress = f?.address || null;

  // Build the address entry — only include non-null fields
  if (aCountry || street || town || state || postCode || formattedAddress) {
    const addressEntry = {};
    if (aCountry) addressEntry.country = aCountry;
    if (street) addressEntry.street = street;
    if (town) addressEntry.town = town;
    if (state) addressEntry.state = state;
    if (postCode) addressEntry.postCode = postCode;
    if (formattedAddress) addressEntry.formattedAddress = formattedAddress;
    addresses.push(addressEntry);
  }

  // ── Build payload — omit null / undefined ─────────────────────────────────
  const payload = {};
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  if (dob) payload.dob = dob;
  if (country) payload.country = country;
  if (nationality) payload.nationality = nationality;
  if (gender) payload.gender = gender;
  if (placeOfBirth) payload.placeOfBirth = placeOfBirth;
  if (countryOfBirth) payload.countryOfBirth = countryOfBirth;
  if (addresses.length) payload.addresses = addresses;

  return payload;
};

/**
 * Push OCR-extracted data to Sumsub — fire-and-forget, non-blocking.
 *
 * Calls two endpoints in parallel:
 *   PATCH /resources/applicants/{id}/info      — extracted document data
 *   PATCH /resources/applicants/{id}/fixedInfo — asserted applicant data
 *
 * Each call is retried up to 3 times (2 s / 4 s / 8 s back-off) and its
 * final outcome is written to AuditLog (service "sumsub", action "ocr_info_sync").
 * Errors are logged but never propagated — the OCR response has already
 * been returned to the client before this runs.
 *
 * @param {string} applicantId  — Sumsub applicant ID
 * @param {Object} ocrFields    — merged OCR fields from ocrPayload.fields
 * @param {Object} [audit]      — { customerId, journeyId } for the audit trail
 */
const MAX_SYNC_ATTEMPTS = 3;

const syncApplicantFromOcr = (applicantId, ocrFields, audit = {}) => {
  if (!applicantId || !ocrFields) return;

  const payload = buildInfoPayloadFromOcr(ocrFields);
  console.log(payload);
  if (!Object.keys(payload).length) {
    console.log("[SumsubSync] No mappable OCR fields — skipping sync");
    return;
  }

  const TAG = "[SumsubSync]";
  const base = `/resources/applicants/${applicantId}`;

  const patch = async (endpoint, label) => {
    const startedAt = Date.now();
    const { status, data, attempts } = await withRetry(
      () => sumsubPatch(`${base}/${endpoint}`, payload),
      MAX_SYNC_ATTEMPTS,
    );
    const failed = status >= 400 || status === 0;
    if (failed) {
      console.error(
        `${TAG} ${label} failed (${status}) after ${attempts} attempt(s):`,
        data?.description || data?.message || JSON.stringify(data),
      );
    } else {
      console.log(`${TAG} ${label} synced (${status})`);
    }

    await recordSyncAudit({
      externalId: applicantId,
      customer: audit.customerId || undefined,
      journey: audit.journeyId || undefined,
      action: "ocr_info_sync",
      target: label,
      status: failed ? "failed" : "success",
      attempts,
      maxAttempts: MAX_SYNC_ATTEMPTS,
      httpStatus: status,
      error: failed
        ? data?.description || data?.message || JSON.stringify(data)
        : undefined,
      requestPayload: payload,
      responseData: data,
      durationMs: Date.now() - startedAt,
    });
  };

  // Both PATCHes in parallel — fire-and-forget
  Promise.all([patch("info", "info"), patch("fixedInfo", "fixedInfo")]).catch(
    (err) => console.error(`${TAG} unexpected error:`, err.message),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. uploadDocToSumsub  — upload a single document image to Sumsub
// ─────────────────────────────────────────────────────────────────────────────

// OCR card_type (lowercase) → Sumsub idDocType
const OCR_CARD_TYPE_TO_SUMSUB_DOC_TYPE = {
  passport: "PASSPORT",
  "driving license": "DRIVERS",
  "driving licence": "DRIVERS",
  nid: "ID_CARD",
  "id card": "ID_CARD",
  "medical card": "ID_CARD",
};

// docType key → Sumsub idDocSubType
const DOC_TYPE_TO_SUMSUB_SUBTYPE = {
  id_front: "FRONT_SIDE",
  front: "FRONT_SIDE",
  id_back: "BACK_SIDE",
  back: "BACK_SIDE",
};

/**
 * Build the Sumsub /info/idDoc metadata object from OCR results.
 *
 * @param {Object} ocrFields    — merged OCR fields (data property from OCR response)
 * @param {string} ocrCardType  — e.g. "Passport", "Driving License", "NID"
 * @param {string} docType      — e.g. "id_front", "passport", "id_back"
 * @param {string} fallbackCountry — alpha-2/3 country code used when OCR has no issuing_country
 * @returns {Object} — Sumsub idDoc metadata (idDocType + optional fields)
 */
const buildIdDocMetadata = (
  ocrFields = {},
  ocrCardType,
  docType,
  fallbackCountry,
) => {
  const cardTypeLower = (ocrCardType || "").toLowerCase();
  const idDocType = OCR_CARD_TYPE_TO_SUMSUB_DOC_TYPE[cardTypeLower] || "OTHER";
  const idDocSubType =
    DOC_TYPE_TO_SUMSUB_SUBTYPE[(docType || "").toLowerCase()] || null;

  const rawCountry = ocrFields.issuing_country || fallbackCountry || null;
  const docCountry = rawCountry ? toAlpha3(rawCountry) || null : null;

  // Name — prefer explicit first/last, fall back to splitting full_name
  let firstName = ocrFields.first_name || null;
  let lastName = ocrFields.last_name || ocrFields.surname || null;
  if (!firstName && !lastName) {
    const fullName = (ocrFields.full_name || "").trim();
    if (fullName) {
      const parts = fullName.split(/\s+/);
      lastName = parts.length > 1 ? parts.pop() : null;
      firstName = parts.join(" ") || null;
    }
  }

  const parseIso = (raw) => {
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
  };

  const dob = parseIso(ocrFields.date_of_birth);
  const issuedDate = parseIso(ocrFields.issue_date || ocrFields.issued_date || ocrFields.date_of_issue);
  const validUntil = parseIso(
    ocrFields.expiry_date || ocrFields.expiration_date || ocrFields.valid_until || ocrFields.date_of_expiry
  );
  const number =
    ocrFields.document_number ||
    ocrFields.passport_number ||
    ocrFields.id_number ||
    null;
  const placeOfBirth = ocrFields.place_of_birth || null;

  const metadata = { idDocType };
  if (idDocSubType) metadata.idDocSubType = idDocSubType;
  if (docCountry) metadata.country = docCountry;
  if (firstName) metadata.firstName = firstName;
  if (lastName) metadata.lastName = lastName;
  if (dob) metadata.dob = dob;
  if (issuedDate) metadata.issuedDate = issuedDate;
  if (validUntil) metadata.validUntil = validUntil;
  if (number) metadata.number = number;
  if (placeOfBirth) metadata.placeOfBirth = placeOfBirth;

  return metadata;
};

/**
 * Upload one document image with OCR-derived metadata to Sumsub.
 * Reusable — call directly whenever you have a buffer + metadata.
 *
 * @param {string} applicantId
 * @param {Buffer} imageBuffer
 * @param {string} mimeType     — e.g. "image/jpeg"
 * @param {string} filename     — e.g. "passport.jpg"
 * @param {Object} metadata     — Sumsub idDoc metadata (idDocType + optional fields)
 * @returns {Promise<{ status: number, data: object, headers: object }>}
 */
const uploadDocToSumsub = (
  applicantId,
  imageBuffer,
  mimeType,
  filename,
  metadata,
) => {
  const form = buildDocFormData(metadata, imageBuffer, mimeType, filename);
  return sumsubPostForm(
    `/resources/applicants/${applicantId}/info/idDoc`,
    form,
  );
};

/**
 * Fire-and-forget: upload each successfully OCR'd document image to Sumsub.
 * Each upload is retried up to 3 times (2 s / 4 s / 8 s back-off) and its
 * final outcome is written to AuditLog (service "sumsub", action "ocr_doc_upload").
 * Errors are logged but never propagated — response has already been sent.
 *
 * @param {string} applicantId
 * @param {Array}  ocrItems — [{ doc, buffer, contentType, ext, ocrData }]
 *   ocrData: the raw OCR API response object ({ card_type, data (fields), side })
 * @param {string} [fallbackCountry] — used when OCR fields have no issuing_country
 * @param {Object} [audit] — { customerId, journeyId } for the audit trail
 */
const pushOcrDocsToSumsub = (applicantId, ocrItems, fallbackCountry, audit = {}) => {
  if (!applicantId || !ocrItems?.length) return;

  const TAG = "[SumsubDocUpload]";

  Promise.all(
    ocrItems.map(async ({ doc, buffer, contentType, ext, ocrData }) => {
      const target = doc.docType || "document";
      const startedAt = Date.now();
      try {
        const metadata = buildIdDocMetadata(
          ocrData.data || {},
          ocrData.card_type,
          doc.docType,
          fallbackCountry,
        );

        console.log({ metadata });

        const safeFilename = (doc.name || `document.${ext || "jpg"}`).replace(
          /[^\w.\-]/g,
          "_",
        );

        // uploadDocToSumsub rebuilds the multipart form from the buffer on
        // every call, so re-invoking it per attempt is safe.
        const { status, data, attempts } = await withRetry(
          () =>
            uploadDocToSumsub(
              applicantId,
              buffer,
              contentType,
              safeFilename,
              metadata,
            ),
          MAX_SYNC_ATTEMPTS,
        );

        const failed = status >= 400 || status === 0;
        if (failed) {
          console.error(
            `${TAG} Upload failed for ${target} (${status}) after ${attempts} attempt(s):`,
            data?.description || data?.message || JSON.stringify(data),
          );
        } else {
          console.log(
            `${TAG} Uploaded ${target} → idDocType=${metadata.idDocType} (${status})`,
          );
        }
        if (data?.errors?.length) {
          console.error(`${TAG} Doc errors:`, JSON.stringify(data.errors));
        }
        if (data?.warnings?.length) {
          console.warn(`${TAG} Doc warnings:`, JSON.stringify(data.warnings));
        }

        await recordSyncAudit({
          externalId: applicantId,
          customer: audit.customerId || undefined,
          journey: audit.journeyId || undefined,
          action: "ocr_doc_upload",
          target,
          status: failed ? "failed" : "success",
          attempts,
          maxAttempts: MAX_SYNC_ATTEMPTS,
          httpStatus: status,
          error: failed
            ? data?.description || data?.message || JSON.stringify(data)
            : undefined,
          requestPayload: { metadata, filename: safeFilename },
          responseData: data,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        console.error(
          `${TAG} Exception uploading ${target}:`,
          err.message,
        );
        await recordSyncAudit({
          externalId: applicantId,
          customer: audit.customerId || undefined,
          journey: audit.journeyId || undefined,
          action: "ocr_doc_upload",
          target,
          status: "failed",
          attempts: 1,
          maxAttempts: MAX_SYNC_ATTEMPTS,
          httpStatus: 0,
          error: err.message,
          durationMs: Date.now() - startedAt,
        });
      }
    }),
  ).catch((err) => console.error(`${TAG} unexpected error:`, err.message));
};

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  resolveCustomerByToken,
  buildApplicantPayload,
  ensureSumsubApplicant,
  requestPendingReview,
  getApplicant,
  triggerAmlCheck,
  handleKycResult,
  handleAmlResult,
  syncApplicantFromOcr,
  buildIdDocMetadata,
  uploadDocToSumsub,
  pushOcrDocsToSumsub,
};
