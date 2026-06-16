"use strict";

/**
 * services/staffSumsubService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sumsub KYC / AML helpers scoped to the Staff model.
 * Mirrors the pattern in sumsubService.js but operates on Staff documents.
 *
 * Exports:
 *   buildStaffApplicantPayload(staff)   — Sumsub create-applicant body
 *   ensureStaffApplicant(staff)         — idempotent applicant creation
 *   syncStaffApplicantStatus(staff)     — fetch status → update Staff fields
 *   triggerStaffAmlCheck(staff)         — POST /recheck/aml
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { sumsubPost, sumsubGet, sumsubPostForm, downloadBuffer, buildDocFormData } = require("../utils/sumsubClient");

const LEVEL_NAME = () => process.env.SUMSUB_LEVEL_NAME || "kyc-level";

// ─────────────────────────────────────────────────────────────────────────────
// 1. buildStaffApplicantPayload
// ─────────────────────────────────────────────────────────────────────────────

const buildStaffApplicantPayload = (staff) => ({
  externalUserId: staff._id.toString(),
  email: staff.contact?.workEmail || undefined,
  phone: staff.contact?.phone || undefined,
  fixedInfo: {
    firstName: staff.personal?.firstName || undefined,
    lastName: staff.personal?.lastName || undefined,
    dob: staff.personal?.dateOfBirth
      ? new Date(staff.personal.dateOfBirth).toISOString().split("T")[0]
      : undefined,
    country: staff.personal?.nationality || undefined,
  },
  lang: "en",
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ensureStaffApplicant  (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decision tree (same as ensureSumsubApplicant for Customer):
 *   A) Local sumsubApplicantId → verify still alive in Sumsub
 *   B) No local ID → lookup by externalUserId
 *   C) Not found → create new applicant
 *
 * @param {Staff} staff — mongoose document (mutated + saved on change)
 * @returns {Promise<{ created, applicantId, inspectionId?, reviewStatus?, requiredDocSets? }>}
 */
const ensureStaffApplicant = async (staff) => {
  // ── A: local ID exists ─────────────────────────────────────────────────────
  if (staff.sumsubApplicantId) {
    const { status } = await sumsubGet(
      `/resources/applicants/${staff.sumsubApplicantId}/one`,
    );
    if (status === 200 || status === 201) {
      staff.sumsubHistory.push({
        event: "applicant_found",
        applicantId: staff.sumsubApplicantId,
        note: "Existing applicant confirmed via local ID",
        at: new Date(),
      });
      await staff.save();
      return {
        created: false,
        applicantId: staff.sumsubApplicantId,
        inspectionId: staff.sumsubInspectionId,
      };
    }
    // stale reference — clear and fall through
    staff.sumsubApplicantId = null;
    staff.sumsubInspectionId = null;
  }

  // ── B: lookup by externalUserId ────────────────────────────────────────────
  const extId = encodeURIComponent(staff._id.toString());
  const { status: lookupStatus, data: lookupData } = await sumsubGet(
    `/resources/applicants/-;externalUserId=${extId}/one`,
  );

  if (lookupStatus === 200 && lookupData?.id) {
    staff.sumsubApplicantId = lookupData.id;
    staff.sumsubInspectionId = lookupData.inspectionId || null;
    staff.sumsubHistory.push({
      event: "applicant_found",
      applicantId: lookupData.id,
      note: "Existing applicant located by external user ID",
      at: new Date(),
    });
    await staff.save();
    return {
      created: false,
      applicantId: lookupData.id,
      inspectionId: lookupData.inspectionId,
    };
  }

  // ── C: create new applicant ────────────────────────────────────────────────
  const levelName = encodeURIComponent(LEVEL_NAME());
  const payload = buildStaffApplicantPayload(staff);

  const { status: createStatus, data: createData } = await sumsubPost(
    `/resources/applicants?levelName=${levelName}`,
    payload,
  );

  if (createStatus >= 400) {
    const msg =
      createData?.description || createData?.message || JSON.stringify(createData);
    throw new Error(`Sumsub createApplicant failed (${createStatus}): ${msg}`);
  }

  staff.sumsubApplicantId = createData.id;
  staff.sumsubInspectionId = createData.inspectionId || null;
  staff.kycStatus = "pending";
  staff.sumsubHistory.push({
    event: "applicant_created",
    applicantId: createData.id,
    note: "New applicant registered",
    meta: {
      inspectionId:    createData.inspectionId || null,
      reviewStatus:    createData.review?.reviewStatus || null,
      requiredDocSets: createData.requiredIdDocs?.docSets || [],
    },
    at: new Date(),
  });
  await staff.save();

  return {
    created: true,
    applicantId: createData.id,
    inspectionId: createData.inspectionId || null,
    reviewStatus: createData.review?.reviewStatus,
    requiredDocSets: createData.requiredIdDocs?.docSets,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. syncStaffApplicantStatus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the full Sumsub applicant record and sync status fields into Staff.
 *
 * Staff fields updated:
 *   kycStatus, kycHistory, kycVerifiedAt, kycRejectReason, kycRawResult
 *   amlStatus, amlRiskLabels, amlHits, amlCheckedAt, amlVendor, isPep, sanction
 *   screening.status, screening.pepMatch, screening.sanctionsMatch,
 *   screening.adverseMedia, screening.riskLabels, screening.hits,
 *   screening.kycRawResult, screening.checkedAt, screening.provider
 *
 * @param {Staff} staff — mongoose document
 * @returns {Promise<{ applicant, kycStatus, amlStatus }>}
 */
const syncStaffApplicantStatus = async (staff) => {
  if (!staff.sumsubApplicantId) {
    throw new Error("Staff has no Sumsub applicant — call ensureStaffApplicant first");
  }

  // ── Fetch applicant + AML case in parallel ─────────────────────────────────
  const [applicantRes, amlRes] = await Promise.all([
    sumsubGet(`/resources/applicants/${staff.sumsubApplicantId}/one`),
    sumsubGet(`/resources/api/applicants/${staff.sumsubApplicantId}/amlCase`).catch(() => ({ status: 0, data: {} })),
  ]);

  const applicant = applicantRes.data || {};
  const review = applicant.review || {};
  const reviewResult = review.reviewResult || {};
  const { reviewAnswer, reviewRejectType, rejectLabels = [], clientComment, moderationComment } = reviewResult;
  const reviewStatus = review.reviewStatus;

  // ── Map → KYC status ───────────────────────────────────────────────────────
  let kycStatus = staff.kycStatus || "pending";
  let kycNote = "";
  let kycRejectReason = null;

  if (reviewAnswer === "GREEN") {
    kycStatus = "verified";
    kycNote = "KYC verified via Sumsub";
  } else if (reviewAnswer === "RED") {
    kycStatus = reviewRejectType === "RETRY" ? "pending" : "rejected";
    kycNote = moderationComment || rejectLabels.join(", ") || "Rejected by Sumsub";
    kycRejectReason = clientComment || kycNote;
  } else if (reviewStatus === "pending" || reviewStatus === "queued") {
    kycStatus = "in_review";
    kycNote = "Under Sumsub review";
  }

  // ── Update KYC fields on Staff ─────────────────────────────────────────────
  const prevStatus = staff.kycStatus;
  staff.kycStatus = kycStatus;
  staff.kycRawResult = reviewResult;
  if (reviewAnswer === "GREEN") staff.kycVerifiedAt = new Date();
  if (kycRejectReason) staff.kycRejectReason = kycRejectReason;

  if (prevStatus !== kycStatus) {
    staff.kycHistory.push({
      status: kycStatus,
      note: kycNote,
      changedAt: new Date(),
    });
  }

  // ── AML case ───────────────────────────────────────────────────────────────
  let amlStatus = staff.amlStatus;

  if (amlRes.status === 200 && amlRes.data) {
    const amlCase = amlRes.data;
    const amlAnswer = amlCase.reviewResult?.reviewAnswer;
    const riskLabels = amlCase.riskLabels || [];
    const hits = amlCase.hits || [];
    const vendor = amlCase.vendorAttribution || null;

    amlStatus =
      amlAnswer === "GREEN" ? "clear"
      : amlAnswer === "YELLOW" ? "yellow"
      : amlAnswer === "RED" ? "flagged"
      : amlStatus;

    staff.amlStatus = amlStatus;
    staff.amlRiskLabels = riskLabels;
    staff.amlHits = hits;
    staff.amlCheckedAt = new Date();
    staff.amlVendor = vendor;
    if (riskLabels.includes("pep")) staff.isPep = true;
    if (riskLabels.includes("sanctions")) staff.sanction = true;

    // ── sync into Staff.screening sub-doc ──────────────────────────────────
    staff.screening.status =
      amlStatus === "clear" ? "clear"
      : amlStatus === "yellow" ? "yellow"
      : amlStatus === "flagged" ? "flagged"
      : staff.screening.status;

    staff.screening.pepMatch = staff.isPep;
    staff.screening.sanctionsMatch = staff.sanction;
    staff.screening.adverseMedia = riskLabels.includes("adverseMedia");
    staff.screening.riskLabels = riskLabels;
    staff.screening.hits = hits;
    staff.screening.checkedAt = new Date();
    staff.screening.provider = "sumsub";
    staff.screening.kycRawResult = reviewResult;
  }

  await staff.save();

  return { applicant, kycStatus, amlStatus };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. submitStaffDocuments
// ─────────────────────────────────────────────────────────────────────────────

const DOC_TYPE_MAP = {
  national_id:     "ID_CARD",
  passport:        "PASSPORT",
  drivers_license: "DRIVERS",
};

// ID_CARD and DRIVERS have a front + back side; PASSPORT does not
const MULTI_SIDE_DOCS = new Set(["ID_CARD", "DRIVERS"]);

/**
 * Download each identity document stored on the Staff record and upload it to
 * Sumsub as an idDoc.  Non-identity doc types (CV, offer letter, etc.) are
 * silently skipped.
 *
 * For multi-sided docs (ID_CARD, DRIVERS) the first occurrence of each type is
 * treated as FRONT_SIDE and the second as BACK_SIDE.  Any extras are skipped.
 *
 * @param {Staff} staff — mongoose document (must already have sumsubApplicantId)
 * @returns {Promise<{ submitted: number, skipped: number, results: Array }>}
 */
const submitStaffDocuments = async (staff) => {
  if (!staff.sumsubApplicantId) {
    throw new Error("Staff has no Sumsub applicant — call ensureStaffApplicant first");
  }

  const idDocs = (staff.documents || []).filter((d) => DOC_TYPE_MAP[d.docType]);
  if (!idDocs.length) return { submitted: 0, skipped: 0, results: [] };

  const sideCount = {};
  const results = [];
  let submitted = 0;
  let skipped = 0;

  for (const doc of idDocs) {
    const idDocType = DOC_TYPE_MAP[doc.docType];
    sideCount[idDocType] = (sideCount[idDocType] || 0) + 1;
    const occurrenceIndex = sideCount[idDocType] - 1; // 0 = first, 1 = second

    if (MULTI_SIDE_DOCS.has(idDocType) && occurrenceIndex > 1) {
      skipped++;
      continue; // max 2 sides
    }

    const metadata = {
      idDocType,
      country: staff.personal?.nationality || undefined,
    };
    if (MULTI_SIDE_DOCS.has(idDocType)) {
      metadata.idDocSubType = occurrenceIndex === 0 ? "FRONT_SIDE" : "BACK_SIDE";
    }

    try {
      const { buffer, contentType } = await downloadBuffer(doc.url);
      const filename = doc.name || `${idDocType.toLowerCase()}_${occurrenceIndex}.jpg`;
      const formData = buildDocFormData(metadata, buffer, contentType, filename);

      const { status, data } = await sumsubPostForm(
        `/resources/applicants/${staff.sumsubApplicantId}/info/idDoc`,
        formData,
      );

      if (status >= 400) {
        const reason = data?.description || data?.message || `HTTP ${status}`;
        results.push({ docType: doc.docType, idDocSubType: metadata.idDocSubType || null, status: "failed", reason });
        // persist failure on the document
        const staffDoc = staff.documents.find((d) => d.url === doc.url);
        if (staffDoc) { staffDoc.sumsubStatus = "failed"; staffDoc.sumsubSubmittedAt = new Date(); }
        skipped++;
      } else {
        const imageId = data?.id || null;
        results.push({ docType: doc.docType, idDocSubType: metadata.idDocSubType || null, status: "submitted", imageId });
        // persist success on the document
        const staffDoc = staff.documents.find((d) => d.url === doc.url);
        if (staffDoc) { staffDoc.sumsubImageId = imageId; staffDoc.sumsubStatus = "submitted"; staffDoc.sumsubSubmittedAt = new Date(); }
        submitted++;
      }
    } catch (err) {
      results.push({ docType: doc.docType, idDocSubType: metadata.idDocSubType || null, status: "failed", reason: err.message });
      const staffDoc = staff.documents.find((d) => d.url === doc.url);
      if (staffDoc) { staffDoc.sumsubStatus = "failed"; staffDoc.sumsubSubmittedAt = new Date(); }
      skipped++;
    }
  }

  // record a single history entry covering the whole batch
  staff.sumsubHistory.push({
    event: "docs_submitted",
    applicantId: staff.sumsubApplicantId,
    note: `${submitted} document(s) submitted, ${skipped} skipped/failed`,
    meta: { submitted, skipped, results },
    at: new Date(),
  });
  await staff.save();

  return { submitted, skipped, results };
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. triggerStaffAmlCheck
// ─────────────────────────────────────────────────────────────────────────────

const triggerStaffAmlCheck = async (staff) => {
  if (!staff?.sumsubApplicantId) return false;
  try {
    const { status, data } = await sumsubPost(
      `/resources/applicants/${staff.sumsubApplicantId}/recheck/aml`,
      {},
    );
    if (status >= 400) {
      console.error("[StaffSumsub] AML trigger failed:", data?.description || data?.message);
      return false;
    }
    staff.amlStatus = "pending";
    await staff.save();
    return true;
  } catch (err) {
    console.error("[StaffSumsub] AML trigger exception:", err.message);
    return false;
  }
};

module.exports = {
  buildStaffApplicantPayload,
  ensureStaffApplicant,
  submitStaffDocuments,
  syncStaffApplicantStatus,
  triggerStaffAmlCheck,
};
