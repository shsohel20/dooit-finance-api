/**
 * eKYB OCR extraction service (docs/65 Step 48/50)
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin axios wrapper around the external "OCR Card Extractor API — Gemini
 * Edition" eKYB endpoints. Same shape as fileVaultService.js (multer
 * memoryStorage buffer -> multipart FormData -> axios).
 *
 * Env vars:
 *   OCR_SERVICE_URL  – base URL, e.g. http://31.97.71.194:8066 (no trailing
 *                       slash needed; falls back to that default if unset so
 *                       local/dev environments don't need to configure it).
 */

const axios = require("axios");
const FormData = require("form-data");

const getBaseURL = () =>
  (process.env.OCR_SERVICE_URL || "http://31.97.71.194:8066").replace(/\/+$/, "");

/**
 * Shared POST for every /process-ekyb-* endpoint — each one takes the same
 * single multipart field ("image", image or PDF) and returns the same
 * EKYBResponse envelope: { success, document_type, data, error, raw_text }.
 */
const postEkyb = async (path, buffer, originalName, mimetype) => {
  const form = new FormData();
  form.append("image", buffer, { filename: originalName, contentType: mimetype });

  const response = await axios.post(`${getBaseURL()}${path}`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    // Gemini vision calls over a multi-page PDF can take a while — the
    // upstream API's own docs quote 3-6s for the simpler card endpoints,
    // an ASIC extract or trust deed with several pages runs longer.
    timeout: 90_000,
  });

  return response.data;
};

/**
 * Extract company KYB data from an ASIC Company Extract or ASIC Form 201.
 * `data`, when present, is documented as mirroring CompanyKyc.js's
 * general_information + directors_beneficial_owner — a real sample (docs/65
 * Step 49) showed it actually also returns top-level identifiers[]/
 * appointments[]/share_capital[]/shareholders[]/related_entities[].
 */
exports.processEkybCompany = (buffer, originalName, mimetype) =>
  postEkyb("/process-ekyb-company", buffer, originalName, mimetype);

/**
 * Extract trust KYB data from a Trust Deed. `data`, when present, mirrors
 * TrustKyc.js: trust_details, beneficiaries[], company_trustees,
 * individual_trustees — plus a few fields TrustKyc has no home for
 * (date_of_deed, appointors[], governing_law — docs/65 Step 50), which the
 * frontend surfaces to the user rather than silently discarding.
 */
exports.processEkybTrust = (buffer, originalName, mimetype) =>
  postEkyb("/process-ekyb-trust", buffer, originalName, mimetype);
