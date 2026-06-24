/**
 * utils/imageUtils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared image-download helpers.
 * Used by onboardingJourneyController, sumsubController, etc.
 *
 * Exports:
 *   fetchImageAsBase64(url)  → base64 string
 *   fetchImageData(url)      → { base64, buffer, contentType, ext }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { default: axios } = require("axios");
const mime = require("mime-types");

/**
 * fetchImageAsBase64 — download a remote image and return it as a base64 string.
 * Use when you only need base64 (e.g. sending to a face-verification API).
 *
 * @param {string} url
 * @returns {Promise<string>} base64-encoded image
 */
const fetchImageAsBase64 = async (url) => {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return Buffer.from(response.data, "binary").toString("base64");
};

/**
 * fetchImageData — download a remote image and return every useful form of it
 * in a single HTTP request.  Use when you need the raw buffer (e.g. Sumsub
 * multipart upload) *and* base64 (e.g. liveness API) from the same URL.
 *
 * Also unifies the old `downloadImageBuffer` helper (adds `ext` derived from
 * content-type via mime-types).
 *
 * @param {string} url
 * @returns {Promise<{ base64: string, buffer: Buffer, contentType: string, ext: string }>}
 */
const fetchImageData = async (url) => {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const buffer      = Buffer.from(response.data);
  const contentType = response.headers["content-type"]?.split(";")[0]?.trim() || "image/jpeg";
  const ext         = mime.extension(contentType) || "jpg";
  const base64      = buffer.toString("base64");
  return { base64, buffer, contentType, ext };
};

module.exports = { fetchImageAsBase64, fetchImageData };
