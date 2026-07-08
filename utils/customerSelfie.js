// utils/customerSelfie.js
// Selfie-avatar resolution — one rule shared by the customer queue list and
// the KYC applicant PDF: prefer the live selfie captured during onboarding
// over the portal user's photoUrl, so staff see the verified face.
//
// Order: latest journey's selfie step document → selfie-typed customer
// document (manual import / reviewer upload) → null (caller falls back to
// user.photoUrl / initial placeholder). Callers must pass journeys sorted
// newest-first (both getCustomer and the queue enrichment already do).

const { SELFIE_TYPES } = require("../services/faceVerifyService");

const SELFIE_DOC_TYPES = new Set(SELFIE_TYPES);

const resolveSelfieUrl = (customer = {}, journeys = []) => {
  for (const journey of journeys || []) {
    const step = (journey?.steps || []).find((s) => s.type === "selfie");
    const url = (step?.documents || []).find((doc) => doc?.url)?.url;
    if (url) return url;
  }
  return (
    (Array.isArray(customer.documents) ? customer.documents : []).find(
      (doc) => doc?.url && SELFIE_DOC_TYPES.has(String(doc.docType || doc.type).toLowerCase()),
    )?.url ?? null
  );
};

module.exports = { SELFIE_DOC_TYPES, resolveSelfieUrl };
