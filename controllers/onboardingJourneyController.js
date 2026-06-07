"use strict";

const { default: axios } = require("axios");

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const Customer = require("../models/Customer");
const OnboardingJourney = require("../models/OnboardingJourney");
const { STEP_TYPES, STEP_STATUSES } = OnboardingJourney;

// ── Services ──────────────────────────────────────────────────────────────────
const {
  resolveInvite,
  findOrCreateJourney,
  syncJourneyStatus,
  sanitizeDocuments,
  postJourneyStepBackground,
} = require("../services/journeyService");

const {
  syncApplicantFromOcr,
  pushOcrDocsToSumsub,
} = require("../services/sumsubService");

// ── Utilities ─────────────────────────────────────────────────────────────────
const { fetchImageAsBase64, fetchImageData } = require("../utils/imageUtils");
const {
  extractUpstreamMessage,
  isTransientNetworkError,
  parseApiResponseData,
} = require("../utils/apiUtils");
const {
  resolveCardType,
  callOcrApi,
  mergeOcrFields,
} = require("../utils/ocrUtils");
const { sumsubPostForm, buildDocFormData } = require("../utils/sumsubClient");

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Post any onboarding step (selfie, liveness, docs, personal_form…)
// @route   POST /api/v1/onboarding-journey
// @access  Public (relation invite token)
// ─────────────────────────────────────────────────────────────────────────────
exports.postJourneyStep = asyncHandler(async (req, res, next) => {
  const {
    token,
    step,
    status = "submitted",
    data,
    documents,
    note,
    rejectionReason,
    bumpAttempt = true,
  } = req.body || {};

  if (!step) return next(new ErrorResponse("step is required", 400));
  if (!STEP_TYPES.includes(step)) {
    return next(
      new ErrorResponse(`Invalid step. Allowed: ${STEP_TYPES.join(", ")}`, 400),
    );
  }
  if (!STEP_STATUSES.includes(status)) {
    return next(
      new ErrorResponse(
        `Invalid status. Allowed: ${STEP_STATUSES.join(", ")}`,
        400,
      ),
    );
  }

  const resolved = await resolveInvite(token);
  if (resolved.error) return next(resolved.error);
  const { customer, relation, relationIndex } = resolved;

  const clientId = relation.client;
  const branchId = relation.branch || null;

  const journey = await findOrCreateJourney({
    customerId: customer._id,
    clientId,
    branchId,
    relationIndex,
    channel: relation.onboardingChannel || "Mobile App",
    provider: req.body.provider || "internal",
  });

  if (journey.isNew && req.body.providerRef) {
    journey.providerRef = req.body.providerRef;
  }

  const updatedStep = journey.setStepStatus(step, status, {
    data,
    documents: sanitizeDocuments(documents),
    rejectionReason,
    bumpAttempt,
  });

  journey.recordEvent({
    step,
    action: req.body.action || "step_submitted",
    status,
    note: note || "",
    actor: customer.user || req.user?._id || null,
    actorRole: "customer",
    payload: {
      customerId: customer._id,
      hasData: !!data,
      docCount: Array.isArray(documents) ? documents.length : 0,
    },
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  syncJourneyStatus(journey);
  await journey.save();

  return res.status(200).json({
    success: true,
    message: `Step "${step}" recorded`,
    data: {
      journeyId: journey._id,
      journeyStatus: journey.status,
      relationIndex,
      step: updatedStep,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Post an onboarding step — background / fire-and-forget variant
// @route   POST /api/v1/onboarding-journey/background
// @access  Public (relation invite token)
//
// Identical request body to POST /onboarding-journey.
// Returns 202 Accepted immediately; the step is recorded asynchronously.
// The client does NOT need to wait for the journey write to complete.
// Errors are logged server-side and never propagated to the caller.
// ─────────────────────────────────────────────────────────────────────────────
exports.postJourneyStepBg = asyncHandler(async (req, res) => {
  const {
    token,
    step,
    status = "submitted",
    data,
    documents,
    note,
    rejectionReason,
    bumpAttempt = true,
    action,
    provider,
    providerRef,
  } = req.body || {};

  // ── Respond immediately — 202 Accepted ────────────────────────────────────
  res.status(202).json({
    success: true,
    message: `Step "${step}" accepted — processing in background`,
  });

  // ── Fire-and-forget ────────────────────────────────────────────────────────
  // postJourneyStepBackground never throws; it logs and returns { success, error }.
  postJourneyStepBackground({
    token,
    step,
    status,
    data,
    documents,
    note,
    rejectionReason,
    bumpAttempt,
    action,
    provider,
    providerRef,
    actorId: req.user?._id || null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Get onboarding journey(s) for a customer (admin view)
// @route   GET /api/v1/onboarding-journey/customer/:customerId
// @access  Private (admin/client/branch/manager)
// ─────────────────────────────────────────────────────────────────────────────
exports.getJourneyByCustomer = asyncHandler(async (req, res, next) => {
  const { customerId } = req.params;
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  const customer = await Customer.findById(customerId).select("_id uid");
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  const filter = { customer: customer._id };
  if (client) filter.client = client;
  if (branch) filter.branch = branch;

  const journeys = await OnboardingJourney.find(filter)
    .populate({ path: "client", select: "name" })
    .populate({ path: "branch", select: "name" })
    .sort({ createdAt: -1 })
    .lean({ virtuals: true });

  return res.status(200).json({
    success: true,
    count: journeys.length,
    data: journeys,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Admin/staff reviews (approves/rejects) a single onboarding step
// @route   PATCH /api/v1/onboarding-journey/:journeyId/step/:stepType
// @access  Private (admin/client/branch/manager)
// ─────────────────────────────────────────────────────────────────────────────
const REVIEW_STATUSES = ["approved", "rejected", "in_progress", "pending"];

exports.reviewJourneyStep = asyncHandler(async (req, res, next) => {
  const { journeyId, stepType } = req.params;
  const { status, note, rejectionReason } = req.body || {};

  if (!STEP_TYPES.includes(stepType)) {
    return next(
      new ErrorResponse(`Invalid step. Allowed: ${STEP_TYPES.join(", ")}`, 400),
    );
  }
  if (!status || !REVIEW_STATUSES.includes(status)) {
    return next(
      new ErrorResponse(
        `Invalid status. Allowed: ${REVIEW_STATUSES.join(", ")}`,
        400,
      ),
    );
  }
  if (status === "rejected" && !rejectionReason) {
    return next(
      new ErrorResponse(
        "rejectionReason is required when rejecting a step",
        400,
      ),
    );
  }

  const journey = await OnboardingJourney.findById(journeyId);
  if (!journey) return next(new ErrorResponse("Journey not found", 404));

  const userClient = req?.user?.client?._id || null;
  const userBranch = req?.user?.branch?._id || null;
  if (
    userClient &&
    journey.client &&
    journey.client.toString() !== userClient.toString()
  ) {
    return next(new ErrorResponse("Not authorized for this journey", 403));
  }
  if (
    userBranch &&
    journey.branch &&
    journey.branch.toString() !== userBranch.toString()
  ) {
    return next(new ErrorResponse("Not authorized for this journey", 403));
  }

  const existingStep = journey.steps.find((s) => s.type === stepType);
  if (!existingStep) {
    return next(
      new ErrorResponse(`Step "${stepType}" has not been submitted yet`, 404),
    );
  }

  const updatedStep = journey.setStepStatus(stepType, status, {
    rejectionReason: status === "rejected" ? rejectionReason : undefined,
    bumpAttempt: false,
  });

  journey.recordEvent({
    step: stepType,
    action: "step_reviewed",
    status,
    note: note || "",
    actor: req.user?._id || null,
    actorRole: req.user?.role || "staff",
    payload: {
      reviewedBy: req.user?._id,
      rejectionReason: rejectionReason || undefined,
    },
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  // Reviewer may reset a step to pending/in_progress — fall back to "in_progress"
  // when none of the terminal conditions (approved/submitted/rejected) are met.
  syncJourneyStatus(journey, { fallbackStatus: "in_progress" });
  await journey.save();

  return res.status(200).json({
    success: true,
    message: `Step "${stepType}" reviewed as "${status}"`,
    data: {
      journeyId: journey._id,
      journeyStatus: journey.status,
      step: updatedStep,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Liveness helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Pick image URLs from a documents array (liveness sends bare URL list). */
const pickLivenessImageUrls = (documents) => {
  if (!Array.isArray(documents)) return [];
  return documents
    .filter(
      (d) => d && typeof d === "object" && typeof d.url === "string" && d.url,
    )
    .map((d) => d.url);
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Liveness verification — compare two images via AFC Liveness API
// @route   POST /api/v1/onboarding-journey/liveness-detection
// @access  Public (relation invite token)
// ─────────────────────────────────────────────────────────────────────────────
exports.livenessDetection = asyncHandler(async (req, res, next) => {
  const { token, documents, note } = req.body || {};

  const urls = pickLivenessImageUrls(documents);

  console.log(urls);

  if (urls.length < 2) {
    return next(
      new ErrorResponse(
        "documents must include at least two image URLs (for img1 and img2)",
        400,
      ),
    );
  }

  const resolved = await resolveInvite(token);
  if (resolved.error) return next(resolved.error);
  const { customer, relation, relationIndex } = resolved;

  const clientId = relation.client;
  const branchId = relation.branch || null;

  // img1 = selfie — full data kept in memory for the Sumsub SELFIE upload
  // img2 = reference frame — base64 only (not re-uploaded to Sumsub)
  const [img1Url, img2Url] = urls;
  let img1Data, img2_base64;
  try {
    [img1Data, img2_base64] = await Promise.all([
      fetchImageData(img1Url),
      fetchImageAsBase64(img2Url),
    ]);
  } catch (err) {
    return next(
      new ErrorResponse(
        `Failed to download image for liveness detection: ${err.message}`,
        400,
      ),
    );
  }
  const img1_base64 = img1Data.base64;

  const baseUrl = process.env.LIVENESS_API || "http://31.97.71.194:5030";
  let apiResult, upstreamError, upstreamStatus;

  try {
    const response = await axios.post(
      `${baseUrl}/liveness-detection/`,
      { img1_base64, img2_base64 },
      {
        timeout: 30_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      },
    );
    upstreamStatus = response.status;
    apiResult = parseApiResponseData(response.data);
    if (upstreamStatus >= 400)
      upstreamError = extractUpstreamMessage(apiResult);
  } catch (err) {
    return next(
      new ErrorResponse(
        `Liveness detection API unreachable: ${err.message}`,
        isTransientNetworkError(err) ? 503 : 502,
      ),
    );
  }

  console.log({ apiResult, upstreamError, upstreamStatus });

  let isMatch = null,
    isLive = null;
  let stepStatus = "submitted";
  let rejectionReason;

  if (upstreamError) {
    stepStatus = "rejected";
    rejectionReason = upstreamError;
  } else {
    // ── Resolve isLive ────────────────────────────────────────────────────────
    // Priority 1: explicit boolean fields (legacy / other API versions)
    // Priority 2: verdict string — "Liveliness detected" → live, anything else → not live
    const verdict = apiResult?.verdict ?? apiResult?.message ?? null;

    isLive =
      apiResult?.is_live ??
      apiResult?.liveness ??
      apiResult?.is_real ??
      (verdict !== null
        ? /liveliness?\s+detected|liveness?\s+detected/i.test(verdict)
        : null);

    // ── Resolve isMatch ───────────────────────────────────────────────────────
    // Face-match is optional — not all liveness APIs include it.
    isMatch =
      apiResult?.is_match ??
      apiResult?.match ??
      apiResult?.verified ??
      apiResult?.is_same_person ??
      null;

    // ── Determine step status ─────────────────────────────────────────────────
    if (isLive === false) {
      stepStatus = "rejected";
      rejectionReason = verdict || "Liveness check failed";
    } else if (isMatch === false) {
      stepStatus = "rejected";
      rejectionReason = "Face match failed";
    } else if (isLive === true && (isMatch === null || isMatch === true)) {
      stepStatus = "approved";
    }
    // isLive === null && isMatch === null  →  stepStatus stays "submitted"
  }

  const journey = await findOrCreateJourney({
    customerId: customer._id,
    clientId,
    branchId,
    relationIndex,
    channel: relation.onboardingChannel || "Mobile App",
    provider: "internal",
  });

  const updatedStep = journey.setStepStatus("liveness", stepStatus, {
    data: { providerResponse: apiResult, checkedAt: new Date() },
    documents: sanitizeDocuments(documents),
    rejectionReason,
    bumpAttempt: true,
  });

  journey.recordEvent({
    step: "liveness",
    action: "liveness_checked",
    status: stepStatus,
    note: note || "",
    actor: customer.user || req.user?._id || null,
    actorRole: "customer",
    payload: {
      customerId: customer._id,
      isMatch,
      isLive,
      upstreamStatus,
      upstreamError: upstreamError || undefined,
    },
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  syncJourneyStatus(journey);
  await journey.save();

  // ── Upload selfie to Sumsub (fire-and-log, non-blocking) ─────────────────
  // Uses the buffer already in memory — no second HTTP download.
  // if (stepStatus === "approved" && customer.sumsubApplicantId) {
  //   const selfieFilename = decodeURIComponent(
  //     img1Url.split("/").pop()?.split("?")[0] || "selfie.jpg",
  //   );

  //   const formData = buildDocFormData(
  //     { idDocType: "SELFIE" },
  //     img1Data.buffer,
  //     img1Data.contentType,
  //     selfieFilename,
  //   );

  //   sumsubPostForm(
  //     `/resources/applicants/${customer.sumsubApplicantId}/info/idDoc`,
  //     formData,
  //   )
  //     .then(({ status, data }) => {
  //       if (status >= 400) {
  //         console.error(
  //           `[livenessDetection] Sumsub SELFIE upload failed (${status}):`,
  //           data?.description || data?.message || JSON.stringify(data),
  //         );
  //       } else {
  //         console.log(
  //           `[livenessDetection] Sumsub SELFIE uploaded → applicant ${customer.sumsubApplicantId}`,
  //         );
  //       }
  //     })
  //     .catch((err) =>
  //       console.error(
  //         "[livenessDetection] Sumsub SELFIE upload error:",
  //         err.message,
  //       ),
  //     );
  // }

  const httpStatus = stepStatus === "rejected" ? 400 : 200;
  return res.status(httpStatus).json({
    success: stepStatus !== "rejected",
    status: httpStatus,
    message:
      stepStatus === "rejected"
        ? rejectionReason || "Liveness verification failed"
        : `Liveness step recorded as "${stepStatus}"`,
    data: {
      journeyId: journey._id,
      journeyStatus: journey.status,
      relationIndex,
      step: updatedStep,
      providerResponse: apiResult,
      upstreamStatus,
      sumsubSelfie:
        stepStatus === "approved" && customer.sumsubApplicantId
          ? { queued: true, applicantId: customer.sumsubApplicantId }
          : null,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Verify ID document face vs live selfie via AFC Face Verification API
// @route   POST /api/v1/onboarding-journey/verify-doc-face
// @access  Public (relation invite token)
//
// API contract (POST /verify/):
//   image_1 = base64 of document (NID/Passport containing user face)
//   image_2 = base64 of live selfie
//   Response: { data: { result: { verification_status: 1|0, similarity: 0-100 } }, code, errors[] }
//   Match threshold: similarity >= 60
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyDocAndFace = asyncHandler(async (req, res, next) => {
  const { token, documents, note } = req.body || {};

  if (!Array.isArray(documents) || documents.length < 2) {
    return next(
      new ErrorResponse(
        "documents must include a document image (docType: id_front) and a live selfie (docType: selfie)",
        400,
      ),
    );
  }

  const findDoc = (...types) =>
    documents.find((d) => d && d.url && types.includes(d.docType || d.type));

  const docImage = findDoc("id_front", "id_back", "passport", "nid");
  const selfieImage = findDoc("selfie", "face", "live_photo");

  if (!docImage) {
    return next(
      new ErrorResponse(
        "documents must include an ID document image (docType: id_front | passport | nid)",
        400,
      ),
    );
  }
  if (!selfieImage) {
    return next(
      new ErrorResponse(
        "documents must include a live selfie image (docType: selfie | face | live_photo)",
        400,
      ),
    );
  }

  const resolved = await resolveInvite(token);
  if (resolved.error) return next(resolved.error);
  const { customer, relation, relationIndex } = resolved;

  const clientId = relation.client;
  const branchId = relation.branch || null;

  let image1, image2;
  try {
    [image1, image2] = await Promise.all([
      fetchImageAsBase64(docImage.url),
      fetchImageAsBase64(selfieImage.url),
    ]);
  } catch (err) {
    return next(
      new ErrorResponse(
        `Failed to download image for verification: ${err.message}`,
        400,
      ),
    );
  }

  const baseUrl = process.env.DOC_FACE_API || "http://31.97.71.194:5005";
  let apiResult, upstreamStatus;

  try {
    const response = await axios.post(
      `${baseUrl}/verify/`,
      { app_id: 1, image_1: image1, image_2: image2 },
      {
        timeout: 60_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      },
    );
    upstreamStatus = response.status;
    apiResult = parseApiResponseData(response.data);
  } catch (err) {
    return next(
      new ErrorResponse(
        `Face verification API unreachable: ${err.message}`,
        isTransientNetworkError(err) ? 503 : 502,
      ),
    );
  }

  const result = apiResult?.data?.result || {};
  const verificationStatus = result.verification_status; // 1 = match, 0 = no match
  const similarity = result.similarity ?? 0;
  const model = result.model || null;
  const apiErrors =
    Array.isArray(apiResult?.errors) && apiResult.errors.length
      ? apiResult.errors
      : null;
  const apiCode = apiResult?.code ?? upstreamStatus;

  const SIMILARITY_THRESHOLD = 60;

  let stepStatus, rejectionReason;
  if (apiErrors) {
    stepStatus = "rejected";
    rejectionReason =
      apiErrors.join("; ") || apiResult?.message || "Verification failed";
  } else if (verificationStatus === 1 && similarity >= SIMILARITY_THRESHOLD) {
    stepStatus = "approved";
  } else {
    stepStatus = "rejected";
    rejectionReason =
      similarity < SIMILARITY_THRESHOLD
        ? `Face similarity too low (${similarity.toFixed(1)}% < ${SIMILARITY_THRESHOLD}%)`
        : "Face verification failed — faces do not match";
  }

  const journey = await findOrCreateJourney({
    customerId: customer._id,
    clientId,
    branchId,
    relationIndex,
    channel: relation.onboardingChannel || "Mobile App",
    provider: "internal",
  });

  const providerData = {
    verificationStatus,
    similarity,
    model,
    apiCode,
    apiErrors,
    checkedAt: new Date(),
    rawResponse: apiResult,
  };

  const idDocs = sanitizeDocuments(
    documents.filter(
      (d) => !["selfie", "face", "live_photo"].includes(d.docType || d.type),
    ),
  );
  const selfieDocs = sanitizeDocuments(
    documents.filter((d) =>
      ["selfie", "face", "live_photo"].includes(d.docType || d.type),
    ),
  );

  const updatedDocStep = journey.setStepStatus("id_document", stepStatus, {
    data: providerData,
    documents: idDocs,
    rejectionReason,
    bumpAttempt: true,
  });
  const updatedSelfieStep = journey.setStepStatus("selfie", stepStatus, {
    data: providerData,
    documents: selfieDocs,
    rejectionReason,
    bumpAttempt: true,
  });

  journey.recordEvent({
    step: "id_document",
    action: "doc_face_verified",
    status: stepStatus,
    note: note || "",
    actor: customer.user || req.user?._id || null,
    actorRole: "customer",
    payload: {
      customerId: customer._id,
      verificationStatus,
      similarity,
      model,
      apiCode,
      apiErrors: apiErrors || undefined,
      upstreamStatus,
    },
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  syncJourneyStatus(journey);
  await journey.save();

  const httpStatus = stepStatus === "rejected" ? 400 : 200;
  return res.status(httpStatus).json({
    success: stepStatus !== "rejected",
    status: httpStatus,
    message:
      stepStatus === "rejected"
        ? rejectionReason || "Face verification failed"
        : "Document and face verification approved",
    data: {
      journeyId: journey._id,
      journeyStatus: journey.status,
      relationIndex,
      steps: { id_document: updatedDocStep, selfie: updatedSelfieStep },
      verification: {
        verificationStatus,
        similarity,
        model,
        threshold: SIMILARITY_THRESHOLD,
      },
      providerResponse: apiResult,
      upstreamStatus,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    OCR one or more ID documents via AFC KYC OCR API
// @route   POST /api/v1/onboarding-journey/ocr-document
// @access  Public (relation invite token)
//
// Request body:
//   token      – invite token
//   cardType   – "Driving License" | "Medical Card" | "Passport"  (optional)
//   documents  – [{ url, docType, name?, mimeType? }, ...]
//   note       – optional
// ─────────────────────────────────────────────────────────────────────────────
exports.ocrDocument = asyncHandler(async (req, res, next) => {
  const { token, documents, cardType: explicitCardType, note } = req.body || {};

  if (!Array.isArray(documents) || documents.length === 0) {
    return next(
      new ErrorResponse(
        "documents array is required (at least one { url, docType })",
        400,
      ),
    );
  }

  const validDocs = documents.filter(
    (d) => d && typeof d.url === "string" && d.url,
  );
  if (validDocs.length === 0) {
    return next(new ErrorResponse("No valid document URLs provided", 400));
  }

  const resolved = await resolveInvite(token);
  if (resolved.error) return next(resolved.error);
  const { customer, relation, relationIndex } = resolved;

  const clientId = relation.client;
  const branchId = relation.branch || null;

  // Download all document images in parallel
  let downloaded;
  try {
    downloaded = await Promise.all(
      validDocs.map(async (doc) => {
        const { buffer, contentType, ext } = await fetchImageData(doc.url);
        return { doc, buffer, contentType, ext };
      }),
    );
  } catch (err) {
    return next(
      new ErrorResponse(
        `Failed to download document image: ${err.message}`,
        400,
      ),
    );
  }

  const ocrBaseUrl = process.env.OCR_API || "http://31.97.71.194:8066";

  // Call OCR API for each document in parallel
  let ocrResults;
  try {
    ocrResults = await Promise.all(
      downloaded.map(async ({ doc, buffer, contentType, ext }) => {
        const cardType = resolveCardType(doc.docType, explicitCardType);
        const { upstreamStatus, data } = await callOcrApi(
          ocrBaseUrl,
          buffer,
          contentType,
          ext,
          cardType,
        );
        return { doc, cardType, upstreamStatus, data };
      }),
    );
  } catch (err) {
    return next(
      new ErrorResponse(
        `OCR API unreachable: ${err.message}`,
        isTransientNetworkError(err) ? 503 : 502,
      ),
    );
  }

  const allSucceeded = ocrResults.every((r) => r.data?.success === true);
  const anyFailed = ocrResults.some(
    (r) => r.data?.success === false || r.upstreamStatus >= 400,
  );

  const parts = {};
  const ocrErrors = [];
  let mergedFields = {};
  let cardType = null;
  let detectedType = null;

  for (const result of ocrResults) {
    const key = result.doc.docType || result.data?.side || "document";
    if (result.data?.success) {
      parts[key] = {
        cardType: result.data.card_type,
        detectedType: result.data.detected_type,
        side: result.data.side,
        fields: result.data.data || {},
        rawText: result.data.raw_text || null,
      };
      cardType = cardType || result.data.card_type || null;
      detectedType = detectedType || result.data.detected_type || null;
      mergedFields = mergeOcrFields(mergedFields, result.data.data || {});
    } else {
      ocrErrors.push({
        docType: key,
        error: result.data?.error || "OCR processing failed",
        upstreamStatus: result.upstreamStatus,
      });
    }
  }

  const stepStatus =
    anyFailed && !allSucceeded
      ? "rejected"
      : allSucceeded
        ? "approved"
        : "submitted";

  const rejectionReason =
    stepStatus === "rejected"
      ? ocrErrors.map((e) => `${e.docType}: ${e.error}`).join("; ")
      : undefined;

  const journey = await findOrCreateJourney({
    customerId: customer._id,
    clientId,
    branchId,
    relationIndex,
    channel: relation.onboardingChannel || "Mobile App",
    provider: "internal",
  });

  // Merge with any OCR data already on the step — re-submissions add, not replace.
  const existingStep = journey.steps.find((s) => s.type === "id_document");
  const existingOcr = existingStep?.data?.ocr || {};

  const ocrPayload = {
    cardType: cardType || existingOcr.cardType || null,
    detectedType: detectedType || existingOcr.detectedType || null,
    fields: mergeOcrFields(existingOcr.fields, mergedFields),
    parts: { ...(existingOcr.parts || {}), ...parts },
    errors: ocrErrors.length ? ocrErrors : undefined,
    checkedAt: new Date(),
  };

  const updatedStep = journey.setStepStatus("id_document", stepStatus, {
    data: { ocr: ocrPayload },
    documents: sanitizeDocuments(validDocs),
    rejectionReason,
    bumpAttempt: true,
  });

  // Mixed path inside an array sub-document — Mongoose won't auto-detect nested mutation.
  journey.markModified("steps");

  journey.recordEvent({
    step: "id_document",
    action: "ocr_processed",
    status: stepStatus,
    note: note || "",
    actor: customer.user || null,
    actorRole: "customer",
    payload: {
      customerId: customer._id,
      docCount: validDocs.length,
      succeeded: ocrResults.filter((r) => r.data?.success).length,
      failed: ocrErrors.length,
    },
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  syncJourneyStatus(journey);
  await journey.save();

  // ── Push OCR data + document images to Sumsub in background ─────────────
  // Both calls are fire-and-forget; the response has already been formed.
  if (customer.sumsubApplicantId) {
    if (allSucceeded) {
      syncApplicantFromOcr(customer.sumsubApplicantId, ocrPayload.fields);
    }

    // Upload document images with OCR-derived metadata to Sumsub /info/idDoc
    const successItems = ocrResults
      .filter((r) => r.data?.success)
      .map((r) => {
        const dl = downloaded.find((d) => d.doc === r.doc);
        return {
          doc: r.doc,
          buffer: dl.buffer,
          contentType: dl.contentType,
          ext: dl.ext,
          ocrData: r.data,
        };
      });
    if (successItems.length) {
      pushOcrDocsToSumsub(
        customer.sumsubApplicantId,
        successItems,
        customer.country,
      );
    }
  }

  const httpStatus = stepStatus === "rejected" ? 400 : 200;
  return res.status(httpStatus).json({
    success: stepStatus !== "rejected",
    status: httpStatus,
    message:
      stepStatus === "rejected"
        ? rejectionReason || "OCR processing failed"
        : allSucceeded
          ? "Document OCR completed successfully"
          : "Document OCR partially processed — pending review",
    data: {
      //   journeyId: journey._id,
      //  journeyStatus: journey.status,
      //   relationIndex,
      //   step: updatedStep,
      ocr: {
        cardType: ocrPayload.cardType,
        detectedType: ocrPayload.detectedType,
        fields: ocrPayload.fields,
        //  parts: ocrPayload.parts,
        errors: ocrErrors.length ? ocrErrors : undefined,
        docCount: validDocs.length,
        succeeded: ocrResults.filter((r) => r.data?.success).length,
      },
    },
  });
});
