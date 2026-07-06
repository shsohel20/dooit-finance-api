"use strict";

/**
 * services/customerImportService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Service helpers for the staff-side manual import of an INDIVIDUAL customer
 * (in-branch onboarding). Extracted from the former
 * customerManualImportController so the controller keeps only request handling
 * (validation, dedupe, create, respond) while the heavy provider/journey logic
 * lives here.
 *
 * Exports:
 *   findOrCreateCustomerUser  — portal User find-or-create (random pw, inactive)
 *   ensureCustomerMembership  — idempotent tenant-scoped UserType membership
 *   isSelfieDoc               — selfie/liveness document classifier
 *   runFaceVerification       — background ID-photo vs selfie face match
 *   runSumsubChain            — background applicant → upload docs → request check
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require("crypto");

const User = require("../models/User");
const UserType = require("../models/UserType");

const { hashForSearch } = require("../utils/encryption");
const { downloadBuffer } = require("../utils/sumsubClient");
const { toAlpha3 } = require("../utils/countryUtils");
const {
  ensureSumsubApplicant,
  requestPendingReview,
  uploadDocToSumsub,
  syncApplicantFromOcr,
} = require("./sumsubService");
const { findOrCreateJourney, syncJourneyStatus } = require("./journeyService");
const { verifyDocFace } = require("./faceVerifyService");
const { initialPassword } = require("../utils");

// ─────────────────────────────────────────────────────────────────────────────
// Portal user — find-or-create BEFORE the customer so it can be linked at
// create time (mirrors dummyImportController.findOrCreateCustomerUser, but new
// users get a random password instead of "123456").
// ─────────────────────────────────────────────────────────────────────────────

const uniqueUserName = async (base) => {
  const sanitized =
    base.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 30) || "customer";
  if (!(await User.exists({ userName: sanitized }))) return sanitized;
  for (let i = 2; i <= 10; i++) {
    const candidate = `${sanitized}_${i}`;
    if (!(await User.exists({ userName: candidate }))) return candidate;
  }
  return `${sanitized}_${crypto.randomBytes(2).toString("hex")}`;
};

/**
 * Lookup order: emailHash (works when email is encrypted) → plain email
 * (legacy records) → phone. Creates only when an email is present — the User
 * model requires a unique email, so phone-only imports return { user: null }.
 */
const findOrCreateCustomerUser = async ({ email, phone, displayName }) => {
  let user = null;

  if (email) user = await User.findOne({ emailHash: hashForSearch(email) });
  if (!user && email) user = await User.findOne({ email });
  if (!user && phone) user = await User.findOne({ phone });
  if (user) return { user, created: false };

  if (!email) return { user: null, created: false };

  const userName = await uniqueUserName(email.split("@")[0]);
  user = await User.create({
    name: displayName || userName,
    email,
    phone: phone || undefined,
    userName,
    // random throwaway — the customer sets a real one via invite/OTP later
    password: initialPassword,
    isActive: false,
  });
  return { user, created: true };
};

/**
 * Idempotent tenant-scoped membership — the unique (user, userType, role,
 * client, branch) index dedupes, so re-imports never create duplicate rows.
 */
const ensureCustomerMembership = (userId, clientId, branchId, staffId) =>
  UserType.findOneAndUpdate(
    {
      user: userId,
      userType: "customer",
      role: "customer",
      clientBelongs: clientId,
      branchBelongs: branchId || null,
    },
    { $setOnInsert: { isActive: true, assignedBy: staffId || null } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

// ─────────────────────────────────────────────────────────────────────────────
// Document mapping — UI shape { url, type: "front"|"back", docType } → Sumsub
// idDoc metadata. Sub-type is only valid on double-sided document types.
// ─────────────────────────────────────────────────────────────────────────────

const SELFIE_DOC_TYPES = new Set(["selfie", "face", "live_photo"]);

const isSelfieDoc = (doc) =>
  SELFIE_DOC_TYPES.has(
    String(doc?.docType || "").toLowerCase().replace(/[\s-]+/g, "_"),
  );

const resolveSumsubIdDocMeta = (doc, fallbackCountry) => {
  const dt = String(doc.docType || "").toLowerCase().replace(/[\s-]+/g, "_");
  const side = String(doc.type || "").toLowerCase();

  if (SELFIE_DOC_TYPES.has(dt)) return { idDocType: "SELFIE" };

  let idDocType;
  if (dt.includes("passport")) idDocType = "PASSPORT";
  else if (dt.includes("driv")) idDocType = "DRIVERS";
  else idDocType = "ID_CARD"; // national_id / nid / id_card default

  const metadata = { idDocType };
  if (idDocType === "ID_CARD" || idDocType === "DRIVERS") {
    metadata.idDocSubType =
      side === "back" || dt.endsWith("_back") ? "BACK_SIDE" : "FRONT_SIDE";
  }

  const country = doc.country || fallbackCountry;
  const alpha3 = country ? toAlpha3(country) : null;
  if (alpha3) metadata.country = alpha3;

  return metadata;
};

// ─────────────────────────────────────────────────────────────────────────────
// Background face match: ID-document photo vs the uploaded selfie (AFC Face
// Verification API), mirroring the invite flow's verifyDocAndFace. Writes the
// verdict + similarity onto the journey id_document + selfie steps so the
// details page shows a face-match result for manually-imported customers too.
// Never throws — a failure is recorded as a journey event and the chain moves on.
// ─────────────────────────────────────────────────────────────────────────────

const runFaceVerification = async ({
  customer,
  clientId,
  branchId,
  staffId,
  docImage,
  selfieImage,
}) => {
  const journey = await findOrCreateJourney({
    customerId: customer._id,
    clientId,
    branchId,
    channel: "In-Branch",
    provider: "dooit",
  });

  let verdict;
  try {
    verdict = await verifyDocFace({ docUrl: docImage.url, selfieUrl: selfieImage.url });
  } catch (err) {
    journey.recordEvent({
      step: "id_document",
      action: "doc_face_verify_failed",
      note: `Manual import — face verification error: ${err.message}`,
      actor: staffId,
      actorRole: "staff",
      payload: { error: err.message },
    });
    await journey.save();
    return;
  }

  const {
    verificationStatus,
    similarity,
    model,
    apiCode,
    apiErrors,
    stepStatus,
    rejectionReason,
    rawResponse,
  } = verdict;

  const providerData = {
    verificationStatus,
    similarity,
    model,
    apiCode,
    apiErrors,
    checkedAt: new Date(),
    rawResponse,
  };

  // Record the verdict on both the id_document and selfie steps — each is
  // independently visible and manually reviewable in the UI, so the reviewer
  // can approve/reject either (a blur/liveness failure belongs on the selfie
  // step; the match applies to the document step). The attempt was already
  // counted when the handler set the steps to "submitted", so don't re-bump.
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
  // data is a Mixed sub-document — Mongoose won't auto-detect the nested change.
  journey.markModified("steps");

  journey.recordEvent({
    step: "id_document",
    action: "doc_face_verified",
    status: stepStatus,
    note: rejectionReason || "",
    actor: staffId,
    actorRole: "staff",
    payload: {
      customerId: customer._id,
      verificationStatus,
      similarity,
      model,
      apiCode,
      apiErrors: apiErrors || undefined,
    },
  });

  syncJourneyStatus(journey);
  await journey.save();
};

// ─────────────────────────────────────────────────────────────────────────────
// Background Sumsub chain: applicant → upload docs → request check.
// Never throws — outcomes are logged and written to the journey event trail.
// ─────────────────────────────────────────────────────────────────────────────

const runSumsubChain = async ({ customer, clientId, branchId, staffId, documents, ocrFields }) => {
  const journey = await findOrCreateJourney({
    customerId: customer._id,
    clientId,
    branchId,
    channel: "In-Branch",
    provider: "dooit",
  });

  try {
    // 1) Applicant (idempotent)
    const { applicantId, created } = await ensureSumsubApplicant(customer);
    journey.provider = "dooit";
    journey.providerRef = applicantId;
    journey.recordEvent({
      action: created ? "applicant_created" : "applicant_found",
      note: `Manual import — Dooit applicant ${applicantId}`,
      actor: staffId,
      actorRole: "staff",
      payload: { applicantId },
    });

    // 1b) Enrich the applicant with the OCR-extracted person data (name, DOB,
    //     nationality, gender, address). buildApplicantPayload only sets
    //     country + dob, so without this the applicant reaches Sumsub bare —
    //     mirrors the invite flow's onboarding-journey/ocr-document step.
    //     Fire-and-forget: retries + AuditLog handled inside the service.
    if (ocrFields && Object.keys(ocrFields).length) {
      syncApplicantFromOcr(applicantId, ocrFields, {
        customerId: customer._id,
        journeyId: journey._id,
      });
    }

    // 2) Upload documents — FRONT before BACK (Sumsub requirement), selfie last
    const sideRank = (d) =>
      isSelfieDoc(d) ? 2 : String(d.type).toLowerCase() === "back" ? 1 : 0;
    const ordered = [...documents].sort((a, b) => sideRank(a) - sideRank(b));

    const results = [];
    for (const doc of ordered) {
      const metadata = resolveSumsubIdDocMeta(doc, customer.country);
      try {
        const { buffer, contentType } = await downloadBuffer(doc.url);
        const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";
        const filename = `${metadata.idDocType.toLowerCase()}${metadata.idDocSubType ? `_${metadata.idDocSubType.toLowerCase()}` : ""
          }.${ext}`;

        const { status, data } = await uploadDocToSumsub(
          applicantId,
          buffer,
          contentType,
          filename,
          metadata,
        );
        results.push({
          docType: doc.docType,
          idDocType: metadata.idDocType,
          idDocSubType: metadata.idDocSubType || null,
          success: status < 400,
          status,
          errors: data?.errors || [],
        });
      } catch (err) {
        results.push({ docType: doc.docType, success: false, error: err.message });
      }
    }

    const uploaded = results.filter((r) => r.success).length;
    journey.recordEvent({
      step: "id_document",
      action: "doc_uploaded",
      status: uploaded > 0 ? "submitted" : "rejected",
      note: `Manual import — ${uploaded}/${results.length} document(s) uploaded for verification`,
      actor: staffId,
      actorRole: "staff",
      payload: { applicantId, results },
    });

    // 3) Request the AI check — only when at least one document made it up
    if (uploaded > 0) {
      const { status, data } = await requestPendingReview(applicantId);

      // 409 = already pending/queued — idempotent success
      if (status < 400 || status === 409) {
        customer.kycStatus = "in_review";
        customer.kycHistory.push({
          status: "in_review",
          note: "Submitted  for verification (manual import)",
          changedBy: staffId,
          changedAt: Date.now(),
        });
        await customer.save();

        journey.recordEvent({
          action: "check_requested",
          note: "Manual import — applicant moved to pending, AI verification started",
          actor: staffId,
          actorRole: "staff",
          payload: { applicantId },
        });
      } else {
        journey.recordEvent({
          action: "check_request_failed",
          note: `Dooit requestCheck failed (${status}): ${data?.description || data?.message || "unknown"
            }`,
          actor: staffId,
          actorRole: "staff",
          payload: { applicantId, status },
        });
      }
    }

    syncJourneyStatus(journey);
    await journey.save();
  } catch (err) {
    // ensureSumsubApplicant threw (Sumsub unreachable, level misconfig, …)
    journey.recordEvent({
      action: "sumsub_chain_failed",
      note: `Manual import — Dooit chain failed: ${err.message}`,
      actor: staffId,
      actorRole: "staff",
      payload: { error: err.message },
    });
    await journey.save();
    throw err; // let runInBackground log it as failed
  }
};

module.exports = {
  findOrCreateCustomerUser,
  ensureCustomerMembership,
  isSelfieDoc,
  runFaceVerification,
  runSumsubChain,
};
