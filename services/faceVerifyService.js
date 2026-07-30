"use strict";

/**
 * services/faceVerifyService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AFC Face Verification API — compare an ID-document face against a live selfie.
 * Base URL : http://31.97.71.194:5005  (env: DOC_FACE_API)
 * Endpoint : POST /verify/   { app_id, image_1: <doc b64>, image_2: <selfie b64> }
 * Response : { data: { result: { verification_status: 1|0, similarity: 0-100, model } }, code, errors[] }
 * Match    : similarity >= 60 AND verification_status === 1
 *
 * Pure service (no Express req/res): both the invite handler
 * (onboardingJourneyController.verifyDocAndFace) and the staff manual-import
 * background chain call verifyDocFace() so the logic lives in one place.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { default: axios } = require("axios");

const { fetchImageAsBase64 } = require("../utils/imageUtils");
const { parseApiResponseData, isTransientNetworkError } = require("../utils/apiUtils");

const SIMILARITY_THRESHOLD = 40; // TODO

// docType/type values that identify the face-bearing document vs the live selfie
const DOC_TYPES = ["id_front", "id_back", "passport", "nid"];
const SELFIE_TYPES = ["selfie", "face", "live_photo"];

/**
 * pickFaceVerifyPair — from a documents array (invite-payload shape), pick the
 * first document image and the first selfie image (matched by docType or type).
 * @returns {{ docImage: object|undefined, selfieImage: object|undefined }}
 */
const pickFaceVerifyPair = (documents = []) => {
  const find = (types) =>
    documents.find((d) => d && d.url && types.includes(d.docType || d.type));
  return { docImage: find(DOC_TYPES), selfieImage: find(SELFIE_TYPES) };
};

/**
 * verifyDocFace — download the two images, call the AFC face API and map the
 * result onto a journey-step verdict.
 *
 * @param {{ docUrl: string, selfieUrl: string }} args
 * @throws {Error} with `.statusCode` (400 download / 503 transient / 502 other)
 *         when an image can't be fetched or the API is unreachable.
 * @returns {Promise<{
 *   verificationStatus: number|undefined, similarity: number, model: string|null,
 *   apiCode: number, apiErrors: string[]|null, upstreamStatus: number,
 *   rawResponse: object, stepStatus: "approved"|"rejected", rejectionReason?: string
 * }>}
 */
const verifyDocFace = async ({ docUrl, selfieUrl }) => {
  let image1, image2;
  try {
    [image1, image2] = await Promise.all([
      fetchImageAsBase64(docUrl),
      fetchImageAsBase64(selfieUrl),
    ]);
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to download image for verification: ${err.message}`),
      { statusCode: 400 },
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
    throw Object.assign(
      new Error(`Face verification API unreachable: ${err.message}`),
      { statusCode: isTransientNetworkError(err) ? 503 : 502 },
    );
  }

  const result = apiResult?.data?.result || {};
  const verificationStatus = result.verification_status; // 1 = match, 0 = no match
  const similarity = Number(result.similarity ?? 0);
  const model = result.model || null;
  const apiErrors =
    Array.isArray(apiResult?.errors) && apiResult.errors.length ? apiResult.errors : null;
  const apiCode = apiResult?.code ?? upstreamStatus;

  let stepStatus, rejectionReason;
  if (apiErrors) {
    stepStatus = "rejected";
    rejectionReason = apiErrors.join("; ") || apiResult?.message || "Verification failed";
  } else if (verificationStatus === 1) {
    stepStatus = "approved";
  } else {
    stepStatus = "rejected";
    rejectionReason =
      similarity < SIMILARITY_THRESHOLD
        ? `Face similarity too low (${similarity.toFixed(1)}% < ${SIMILARITY_THRESHOLD}%)`
        : "Face verification failed — faces do not match";
  }

  return {
    verificationStatus,
    similarity,
    model,
    apiCode,
    apiErrors,
    upstreamStatus,
    rawResponse: apiResult,
    stepStatus,
    rejectionReason,
  };
};

module.exports = {
  verifyDocFace,
  pickFaceVerifyPair,
  SIMILARITY_THRESHOLD,
  DOC_TYPES,
  SELFIE_TYPES,
};
