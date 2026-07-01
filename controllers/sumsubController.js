/**
 * controllers/sumsubController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sumsub KYC + AML/PEP/Sanctions/Adverse-Media — Express route handlers.
 *
 * This controller is intentionally thin. All business logic lives in:
 *   services/sumsubService.js   — Sumsub API orchestration
 *   services/journeyService.js  — OnboardingJourney mutations
 *   utils/sumsubClient.js       — HMAC-signed HTTP client
 *
 * KYC status mapping (Sumsub → Customer.kycStatus):
 *   GREEN         → "verified"
 *   RED + RETRY   → "pending"   (allow re-upload)
 *   RED + FINAL   → "rejected"
 *
 * AML auto-triggers after KYC = GREEN webhook (via sumsubService.handleKycResult).
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const crypto = require("crypto");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const Customer = require("../models/Customer");
const { sumsubGet, sumsubPostForm, downloadBuffer, buildDocFormData } =
  require("../utils/sumsubClient");
const { toAlpha3 } = require("../utils/countryUtils");

const {
  resolveCustomerByToken,
  ensureSumsubApplicant,
  requestPendingReview,
  getApplicant,
  triggerAmlCheck,
  handleKycResult,
  handleAmlResult,
} = require("../services/sumsubService");

const {
  findOrCreateJourney,
  syncJourneyStatus,
} = require("../services/journeyService");

// ─────────────────────────────────────────────────────────────────────────────
// Internal: resolve customer from token OR admin-supplied customerId
// ─────────────────────────────────────────────────────────────────────────────
const resolveCustomer = async (token, customerId) => {
  if (customerId) {
    const c = await Customer.findById(customerId);
    if (!c) return { error: new ErrorResponse("Customer not found", 404) };
    return { customer: c };
  }
  return resolveCustomerByToken(token);
};

// ─────────────────────────────────────────────────────────────────────────────
// docType → Sumsub idDocType + idDocSubType mapping
// ─────────────────────────────────────────────────────────────────────────────
const DOC_TYPE_MAP = {
  id_front: { idDocType: "ID_CARD", idDocSubType: "FRONT_SIDE" },
  id_back: { idDocType: "ID_CARD", idDocSubType: "BACK_SIDE" },
  passport: { idDocType: "PASSPORT" },
  drivers_front: { idDocType: "DRIVERS", idDocSubType: "FRONT_SIDE" },
  drivers_back: { idDocType: "DRIVERS", idDocSubType: "BACK_SIDE" },
  selfie: { idDocType: "SELFIE" },
  face: { idDocType: "SELFIE" },
  live_photo: { idDocType: "SELFIE" },
};

const isSelfieType = (docType) =>
  ["selfie", "face", "live_photo"].includes((docType || "").toLowerCase());

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE APPLICANT  (idempotent via ensureSumsubApplicant)
// POST /api/v1/sumsub/applicant
// Body: { token } | { customerId }  (admin)
// ─────────────────────────────────────────────────────────────────────────────
exports.createApplicant = asyncHandler(async (req, res, next) => {
  const { token, customerId } = req.body || {};

  const resolved = await resolveCustomer(token, customerId);
  if (resolved.error) return next(resolved.error);
  const { customer, relation, relationIndex } = resolved;

  // ensureSumsubApplicant handles: local check → Sumsub lookup → create
  let result;
  try {
    result = await ensureSumsubApplicant(customer);
  } catch (err) {
    return next(new ErrorResponse(err.message, 502));
  }

  // Record in journey when we have a relation context (invite token flow)
  if (relation && result.created) {
    const journey = await findOrCreateJourney({
      customerId: customer._id,
      clientId: relation.client,
      branchId: relation.branch || null,
      relationIndex: relationIndex || 0,
      channel: relation.onboardingChannel || "Mobile App",
      provider: "sumsub",
    });

    journey.provider = "sumsub";
    journey.providerRef = result.applicantId;
    journey.recordEvent({
      action: "applicant_created",
      note: `Applicant created: ${result.applicantId}`,
      actorRole: "customer",
      payload: { applicantId: result.applicantId, inspectionId: result.inspectionId },
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
    await journey.save();
  }

  const httpStatus = result.created ? 201 : 200;
  return res.status(httpStatus).json({
    success: true,
    message: result.created ? "Sumsub applicant created" : "Applicant already exists",
    data: {
      applicantId: result.applicantId,
      inspectionId: result.inspectionId,
      reviewStatus: result.reviewStatus,
      requiredDocSets: result.requiredDocSets,
      customerId: customer._id,
      created: result.created,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. UPLOAD DOCUMENT  (id_front | id_back | passport | selfie | …)
// POST /api/v1/sumsub/upload-document
// Body: { token, documents: [{ url, docType, country }] }
// ─────────────────────────────────────────────────────────────────────────────
exports.uploadDocument = asyncHandler(async (req, res, next) => {
  const { token, customerId, documents, note } = req.body || {};

  if (!Array.isArray(documents) || documents.length === 0) {
    return next(new ErrorResponse("documents array is required", 400));
  }

  const resolved = await resolveCustomer(token, customerId);
  if (resolved.error) return next(resolved.error);
  const { customer, relation, relationIndex } = resolved;

  if (!customer.sumsubApplicantId) {
    return next(
      new ErrorResponse(
        "Sumsub applicant not found for this customer. Call POST /sumsub/applicant first.",
        400,
      ),
    );
  }

  const applicantId = customer.sumsubApplicantId;
  const uploadResults = [];

  // Upload each document to Sumsub sequentially (FRONT before BACK requirement)
  for (const doc of documents) {
    if (!doc?.url) continue;

    const docType = (doc.docType || "id_front").toLowerCase();
    const sumsub = DOC_TYPE_MAP[docType] || { idDocType: "ID_CARD", idDocSubType: "FRONT_SIDE" };

    const metadata = {
      idDocType: sumsub.idDocType,
      ...(sumsub.idDocSubType && { idDocSubType: sumsub.idDocSubType }),
      ...(doc.country && { country: toAlpha3(doc.country) ?? doc.country.toUpperCase() }),
    };

    let buffer, contentType;
    try {
      ({ buffer, contentType } = await downloadBuffer(doc.url));
    } catch (err) {
      uploadResults.push({ docType, success: false, error: `Download failed: ${err.message}` });
      continue;
    }

    const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
    const formData = buildDocFormData(metadata, buffer, contentType, `${docType}.${ext}`);

    const { status, data } = await sumsubPostForm(
      `/resources/applicants/${applicantId}/info/idDoc`,
      formData,
    );

    uploadResults.push({
      docType,
      idDocType: sumsub.idDocType,
      idDocSubType: sumsub.idDocSubType || null,
      success: status < 400,
      status,
      warnings: data?.warnings || [],
      errors: data?.errors || [],
      rawResponse: data,
    });
  }

  const allOk = uploadResults.every((r) => r.success);
  const anyFailed = uploadResults.some((r) => !r.success);

  // Persist each upload result into the corresponding journey step
  if (relation) {
    const journey = await findOrCreateJourney({
      customerId: customer._id,
      clientId: relation.client,
      branchId: relation.branch || null,
      relationIndex: relationIndex || 0,
      channel: relation.onboardingChannel || "Mobile App",
      provider: "sumsub",
    });

    for (const result of uploadResults) {
      const stepType = isSelfieType(result.docType) ? "selfie" : "id_document";
      const stepStatus = result.success ? "submitted" : "rejected";

      journey.setStepStatus(stepType, stepStatus, {
        data: { sumsubUpload: result, checkedAt: new Date() },
        documents: [
          {
            url: documents.find((d) => (d.docType || "").toLowerCase() === result.docType)?.url || "",
            docType: result.docType,
            name: result.docType,
          },
        ].filter((d) => d.url),
        rejectionReason: result.success ? undefined : result.errors?.join("; "),
        bumpAttempt: true,
      });

      journey.recordEvent({
        step: stepType,
        action: "doc_uploaded",
        status: stepStatus,
        note: note || "",
        actorRole: "customer",
        payload: {
          docType: result.docType,
          idDocType: result.idDocType,
          warnings: result.warnings,
          errors: result.errors,
          upstreamStatus: result.status,
        },
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
    }

    syncJourneyStatus(journey);
    await journey.save();
  }

  return res.status(anyFailed && !allOk ? 207 : 200).json({
    success: allOk,
    message: allOk
      ? "All documents uploaded to Sumsub"
      : anyFailed
        ? "Some documents failed to upload"
        : "Document upload failed",
    data: { applicantId, customerId: customer._id, results: uploadResults },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. REQUEST CHECK  — move applicant → pending, trigger Sumsub AI verification
// POST /api/v1/sumsub/request-check
// Body: { token } | { customerId, reason? }
// ─────────────────────────────────────────────────────────────────────────────
exports.requestCheck = asyncHandler(async (req, res, next) => {
  const { token, customerId, reason } = req.body || {};

  const resolved = await resolveCustomer(token, customerId);
  if (resolved.error) return next(resolved.error);
  const { customer, relation, relationIndex } = resolved;

  if (!customer.sumsubApplicantId) {
    return next(new ErrorResponse("No Sumsub applicant. Call /sumsub/applicant first.", 400));
  }

  const { status, data } = await requestPendingReview(
    customer.sumsubApplicantId,
    reason,
  );

  // 409 = already pending/queued — idempotent, treat as success
  if (status === 409) {
    return res.status(200).json({
      success: true,
      message: "Applicant is already in review — no action needed",
      data: { applicantId: customer.sumsubApplicantId },
    });
  }

  if (status >= 400) {
    return next(
      new ErrorResponse(
        `Sumsub requestCheck failed (${status}): ${data?.description || data?.message || JSON.stringify(data)}`,
        status >= 500 ? 502 : 400,
      ),
    );
  }

  customer.kycStatus = "in_review";
  await customer.save();

  if (relation) {
    const journey = await findOrCreateJourney({
      customerId: customer._id,
      clientId: relation.client,
      branchId: relation.branch || null,
      relationIndex: relationIndex || 0,
      channel: relation.onboardingChannel || "Mobile App",
      provider: "sumsub",
    });
    journey.recordEvent({
      action: "check_requested",
      note: "Applicant moved to pending — AI verification started",
      actorRole: "customer",
      payload: { applicantId: customer.sumsubApplicantId },
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });
    await journey.save();
  }

  return res.status(200).json({
    success: true,
    message: "Applicant submitted for Sumsub verification",
    data: { applicantId: customer.sumsubApplicantId },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET APPLICANT STATUS  (admin / poll)
// GET /api/v1/sumsub/status/:customerId
// ─────────────────────────────────────────────────────────────────────────────
exports.getApplicantStatus = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.params.customerId).select(
    "sumsubApplicantId sumsubInspectionId kycStatus amlStatus amlRiskLabels amlCheckedAt isPep sanction",
  );
  if (!customer) return next(new ErrorResponse("Customer not found", 404));
  if (!customer.sumsubApplicantId) {
    return next(new ErrorResponse("No Sumsub applicant for this customer", 404));
  }

  const { status, data } = await getApplicant(customer.sumsubApplicantId);

  if (status >= 400) {
    return next(
      new ErrorResponse(
        `Sumsub getStatus failed: ${data?.description || data?.message}`,
        502,
      ),
    );
  }

  return res.status(200).json({
    success: true,
    data: {
      customerId: customer._id,
      kycStatus: customer.kycStatus,
      amlStatus: customer.amlStatus,
      amlRiskLabels: customer.amlRiskLabels,
      isPep: customer.isPep,
      sanction: customer.sanction,
      sumsub: {
        applicantId: customer.sumsubApplicantId,
        reviewStatus: data.review?.reviewStatus,
        reviewAnswer: data.review?.reviewResult?.reviewAnswer,
        rejectLabels: data.review?.reviewResult?.rejectLabels,
      },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. TRIGGER AML CHECK  (admin | auto after KYC GREEN webhook)
// POST /api/v1/sumsub/aml-check/:customerId
// ─────────────────────────────────────────────────────────────────────────────
exports.triggerAml = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.params.customerId);
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  if (customer.kycStatus !== "verified") {
    return next(
      new ErrorResponse(
        `KYC must be verified (GREEN) before AML. Current kycStatus: ${customer.kycStatus}`,
        400,
      ),
    );
  }
  if (!customer.sumsubApplicantId) {
    return next(new ErrorResponse("No Sumsub applicant for this customer", 400));
  }

  const triggered = await triggerAmlCheck(customer);
  if (!triggered) {
    return next(new ErrorResponse("AML trigger failed — see server logs", 502));
  }

  return res.status(200).json({
    success: true,
    message: "AML check triggered — result arrives via webhook",
    data: { applicantId: customer.sumsubApplicantId, amlStatus: "pending" },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. GET AML CASE  (admin / compliance view)
// GET /api/v1/sumsub/aml-case/:customerId
// ─────────────────────────────────────────────────────────────────────────────
exports.getAmlCase = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.params.customerId).select(
    "sumsubApplicantId amlStatus amlRiskLabels amlHits amlCheckedAt amlVendor isPep sanction",
  );
  if (!customer) return next(new ErrorResponse("Customer not found", 404));
  if (!customer.sumsubApplicantId) {
    return next(new ErrorResponse("No Sumsub applicant for this customer", 404));
  }

  const { status, data } = await sumsubGet(
    `/resources/api/applicants/${customer.sumsubApplicantId}/amlCase`,
  );

  if (status >= 400) {
    return next(
      new ErrorResponse(
        `Sumsub getAmlCase failed: ${data?.description || data?.message}`,
        502,
      ),
    );
  }

  return res.status(200).json({
    success: true,
    data: {
      customerId: customer._id,
      amlStatus: customer.amlStatus,
      amlRiskLabels: customer.amlRiskLabels,
      isPep: customer.isPep,
      sanction: customer.sanction,
      amlCheckedAt: customer.amlCheckedAt,
      amlVendor: customer.amlVendor,
      sumsubCase: data,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. WEBHOOK  — handles BOTH KYC and AML results from Sumsub
// POST /api/v1/sumsub/webhook
//
// ⚠️  Route MUST use express.raw({ type: 'application/json' }) — NOT express.json()
//     Raw Buffer is required for HMAC-SHA256 verification.
//     Configured in routes/sumsub.js before this handler.
//
// Routing logic:
//   customer.kycStatus !== 'verified'  →  KYC result  →  handleKycResult
//   customer.kycStatus === 'verified'  →  AML result  →  handleAmlResult
// ─────────────────────────────────────────────────────────────────────────────
exports.sumsubWebhook = asyncHandler(async (req, res) => {

  // console.log(req.headers)
  // console.log(req.body)
  // ── 1. Verify HMAC-SHA256 signature ───────────────────────────────────────
  const received = req.headers["x-payload-digest"];
  const webhookSecret = process.env.NODE_ENV === "production"
    ? process.env.SUMSUB_WEBHOOK_SECRET
    : process.env.SUMSUB_WEBHOOK_SECRET2;
  const expected = crypto
    .createHmac("sha256", webhookSecret || "")
    .update(req.body) // Buffer from express.raw()
    .digest("hex");



  if (!received || received !== expected) {
    return res.status(403).json({ error: "Invalid webhook signature" });
  }

  // ── 2. Parse raw Buffer → JSON ─────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch (_) {
    return res.status(400).json({ error: "Malformed JSON payload" });
  }


  const { type, externalUserId, applicantId, reviewResult, reviewStatus } = payload;

  // Acknowledge non-review events immediately — Sumsub retries on non-200
  if (type !== "applicantReviewed") {
    return res.status(200).json({ received: true, ignored: true, type });
  }

  // ── 3. Find Customer by externalUserId (= our Customer._id) ───────────────
  const customer = await Customer.findById(externalUserId);
  if (!customer) {
    // Not our customer (multi-tenant / legacy) — acknowledge gracefully
    return res.status(200).json({ received: true, ignored: true, reason: "customer_not_found" });
  }

  // ── 4. Route: KYC or AML? ──────────────────────────────────────────────────
  const effectiveApplicantId = applicantId || customer.sumsubApplicantId;

  if (customer.kycStatus !== "verified") {
    console.log('I am for here not verified')
    // KYC result — customer hasn't been verified yet

    await handleKycResult(customer, reviewResult || {}, effectiveApplicantId, reviewStatus);

    console.log('I am also for here AML result')

    await handleAmlResult(
      customer,
      reviewResult?.reviewAnswer,
      effectiveApplicantId,
    );
  } else {
    console.log('I am for here AML result')

    // AML result — KYC already GREEN, this must be AML
    await handleAmlResult(
      customer,
      reviewResult?.reviewAnswer,
      effectiveApplicantId,
    );
  }

  return res.status(200).json({ received: true });
});
