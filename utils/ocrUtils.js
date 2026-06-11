/**
 * utils/ocrUtils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AFC KYC OCR API helpers.
 * Base URL  : http://31.97.71.194:8066  (env: OCR_API)
 * Endpoints :
 *   POST /process-card          — requires card_type
 *   POST /process-card-general  — auto-detects card type
 * Transport : multipart/form-data  { card_type?, image: <file> }
 *
 * Exports:
 *   DOC_TYPE_TO_CARD_TYPE           — docType → card_type mapping
 *   resolveCardType(docType, explicit) — pick card_type for a document
 *   callOcrApi(baseUrl, buffer, contentType, ext, cardType) → { upstreamStatus, data }
 *   mergeOcrFields(target, source)  — merge extracted field objects (NID front+back)
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { default: axios } = require("axios");
const { parseApiResponseData } = require("./apiUtils");

// ── card_type values accepted by the OCR API ──────────────────────────────────
// "NID" | "Driving License" | "Medical Card" | "Passport"
const DOC_TYPE_TO_CARD_TYPE = {
  nid: "NID",
  national_id: "NID",
  id_front: "NID",
  id_back: "NID",
  driving_license: "Driving License",
  driving_licence: "Driving License",
  passport: "Passport",
  medicare: "Medical Card",
  medical_card: "Medical Card",
};

/**
 * resolveCardType — derive the OCR API's card_type from a docType string.
 *
 * @param {string|null} docType         — e.g. "id_front", "passport"
 * @param {string|null} explicitCardType — caller-supplied override
 * @returns {string|null}
 */
const resolveCardType = (docType, explicitCardType) => {
  if (explicitCardType) return explicitCardType;
  return DOC_TYPE_TO_CARD_TYPE[docType?.toLowerCase?.()] || null;
};

/**
 * callOcrApi — submit one image buffer to the AFC OCR API and return the
 * parsed result.
 *
 * @param {string} baseUrl       — OCR API base URL
 * @param {Buffer} buffer        — image bytes
 * @param {string} contentType   — MIME type (e.g. "image/jpeg")
 * @param {string} ext           — file extension (e.g. "jpg")
 * @param {string|null} cardType — OCR card_type; null → use /process-card-general
 * @returns {Promise<{ upstreamStatus: number, data: object }>}
 */
const callOcrApi = async (baseUrl, buffer, contentType, ext, cardType) => {
  const blob = new Blob([buffer], { type: contentType });
  const formData = new FormData();
  formData.append("image", blob, `document.${ext}`);

  const endpoint = `${baseUrl}/process-card-general`;

  if (cardType) formData.append("card_type", cardType);
  // if (cardType) formData.append("token", token);
  // if (cardType) formData.append("url", url);

  const response = await axios.post(endpoint, formData, {
    timeout: 160_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });

  return {
    upstreamStatus: response.status,
    data: parseApiResponseData(response.data),
  };
};

/**
 * mergeOcrFields — merge two extracted OCR field objects.
 * Strategy: non-empty values from `source` overwrite `target`;
 * null/undefined/empty values only fill keys absent from `target`.
 * Use for combining NID front-side and back-side extractions.
 *
 * @param {object} target — existing fields (higher precedence for non-empty values)
 * @param {object} source — new fields to merge in
 * @returns {object}
 */
const mergeOcrFields = (target, source) => {
  const out = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    const hasValue = value !== null && value !== undefined && value !== "";
    if (hasValue) {
      out[key] = value;
    } else if (!(key in out)) {
      out[key] = value ?? null;
    }
  }
  return out;
};

module.exports = {
  DOC_TYPE_TO_CARD_TYPE,
  resolveCardType,
  callOcrApi,
  mergeOcrFields,
};
