/**
 * utils/sumsubClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sumsub REST API — HMAC-SHA256 signed HTTP client
 *
 * Signing rule (Sumsub Python SDK reference):
 *   sig = HMAC-SHA256( timestamp + METHOD + path + body, secretKey )
 *   body = JSON string for JSON requests, raw Buffer for multipart, '' for GET
 *
 * All methods return: { status: number, data: object, headers?: object }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const crypto = require("crypto");
const { default: axios } = require("axios");

const SUMSUB_BASE_URL = process.env.SUMSUB_BASE_URL || "https://api.sumsub.com";

// ── Signing ───────────────────────────────────────────────────────────────────
// Sumsub HMAC-SHA256 rule:
//   sig = HMAC( ts + METHOD + path [+ body], secretKey )
//
// body can be:
//   • a JSON string  (for sumsubPost / sumsubGet)
//   • a raw Buffer   (for multipart — Sumsub signs the actual bytes, not "")
//   • omitted / ""   (for GET or POST with no body)
//
// Reference: Sumsub Python SDK
//   body = b'' if prepared_request.body is None else prepared_request.body
//   data_to_sign = ts + method + path_url + body
const buildHeaders = (method, path, body = "") => {
  const ts = Math.floor(Date.now() / 1000).toString();
  const hmac = crypto.createHmac(
    "sha256",
    process.env.SUMSUB_SECRET_KEY || "",
  );
  // String prefix is always the same
  hmac.update(ts + method.toUpperCase() + path);
  // Body can be a Buffer (multipart) or a string (JSON / empty)
  if (body) hmac.update(body);
  const sig = hmac.digest("hex");

  return {
    "X-App-Token": process.env.SUMSUB_APP_TOKEN || "",
    "X-App-Access-Sig": sig,
    "X-App-Access-Ts": ts,
    Accept: "application/json",
  };
};

const normalise = (response) => ({
  status: response.status,
  data:
    typeof response.data === "string"
      ? (() => {
          try {
            return JSON.parse(response.data);
          } catch (_) {
            return { raw: response.data };
          }
        })()
      : (response.data ?? {}),
  headers: response.headers,
});

// ── JSON POST ─────────────────────────────────────────────────────────────────
const sumsubPost = async (path, body = {}) => {
  const bodyStr = JSON.stringify(body);
  const response = await axios.post(`${SUMSUB_BASE_URL}${path}`, body, {
    headers: {
      ...buildHeaders("POST", path, bodyStr),
      "Content-Type": "application/json",
    },
    validateStatus: () => true,
    timeout: 30_000,
  });
  return normalise(response);
};

// ── JSON GET ──────────────────────────────────────────────────────────────────
const sumsubGet = async (path) => {
  const response = await axios.get(`${SUMSUB_BASE_URL}${path}`, {
    headers: buildHeaders("GET", path, ""),
    validateStatus: () => true,
    timeout: 30_000,
  });
  return normalise(response);
};

// ── Multipart form-data POST ──────────────────────────────────────────────────
// Accepts the { body: Buffer, contentType: string } object returned by
// buildDocFormData.  The raw multipart Buffer IS included in the HMAC — this
// matches Sumsub's Python SDK which signs: ts + method + path + body_bytes.
const sumsubPostForm = async (path, { body, contentType }) => {
  const response = await axios.post(`${SUMSUB_BASE_URL}${path}`, body, {
    headers: {
      ...buildHeaders("POST", path, body), // sign with actual multipart bytes
      "Content-Type": contentType,
      "X-Return-Doc-Warnings": "true",
    },
    validateStatus: () => true,
    timeout: 60_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return normalise(response);
};

// ── Convenience: download image URL → Buffer + mimeType ──────────────────────
const downloadBuffer = async (url) => {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const buffer = Buffer.from(res.data);
  const contentType =
    res.headers["content-type"]?.split(";")[0]?.trim() || "image/jpeg";
  return { buffer, contentType };
};

// ── Build a raw multipart/form-data body for a Sumsub /info/idDoc upload ─────
// Returns { body: Buffer, contentType: string } instead of a native FormData
// object.  Using raw Buffers avoids native FormData / Blob serialization issues
// in Node.js 18+ with axios (missing boundary, wrong Content-Type, etc.).
//
// metadata : { idDocType, idDocSubType?, country? }
// imageBuffer : Buffer containing the image bytes
// mimeType    : e.g. "image/jpeg", "image/png", "image/webp"
// filename    : e.g. "selfie.jpg"
const buildDocFormData = (metadata, imageBuffer, mimeType, filename) => {
  const boundary =
    "SumsubBoundary" +
    Date.now().toString(16) +
    Math.random().toString(16).slice(2);

  const safeFilename = (filename || "document.jpg").replace(/[^\w.\-]/g, "_");
  const metaJson = JSON.stringify(metadata);
  const imgBuf = Buffer.isBuffer(imageBuffer)
    ? imageBuffer
    : Buffer.from(imageBuffer);

  const body = Buffer.concat([
    // ── metadata part ──────────────────────────────────────────────────────────
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="metadata"; filename="blob"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${metaJson}\r\n`,
    ),
    // ── content (image) part ───────────────────────────────────────────────────
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="content"; filename="${safeFilename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    ),
    imgBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
};

module.exports = {
  sumsubPost,
  sumsubGet,
  sumsubPostForm,
  downloadBuffer,
  buildDocFormData,
};
