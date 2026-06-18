"use strict";

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const { fetchImageData } = require("../utils/imageUtils");
const { resolveCardType, callOcrApi, mergeOcrFields } = require("../utils/ocrUtils");
const { isTransientNetworkError } = require("../utils/apiUtils");

// ─────────────────────────────────────────────────────────────────────────────
// @desc    OCR one or more identity documents (standalone — no DB writes)
// @route   POST /api/v1/ocr/document
// @access  Protected
//
// Request body:
//   cardType   – "NID" | "Passport" | "Driving License"  (optional override)
//   documents  – [{ url, docType }, ...]
//     url      – publicly accessible image URL
//     docType  – "national_id" | "passport" | "drivers_license" etc.
// ─────────────────────────────────────────────────────────────────────────────
exports.ocrDocument = asyncHandler(async (req, res, next) => {
  const { documents, cardType: explicitCardType } = req.body || {};

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
      new ErrorResponse(`Failed to download document image: ${err.message}`, 400),
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
          ocrBaseUrl, buffer, contentType, ext, cardType,
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
  const anyFailed    = ocrResults.some(
    (r) => r.data?.success === false || r.upstreamStatus >= 400,
  );

  const parts      = {};
  const ocrErrors  = [];
  let mergedFields = {};
  let cardType     = null;
  let detectedType = null;

  for (const result of ocrResults) {
    const key = result.doc.docType || result.data?.side || "document";
    if (result.data?.success) {
      parts[key] = {
        cardType:     result.data.card_type,
        detectedType: result.data.detected_type,
        side:         result.data.side,
        fields:       result.data.data || {},
        rawText:      result.data.raw_text || null,
      };
      cardType     = cardType     || result.data.card_type     || null;
      detectedType = detectedType || result.data.detected_type || null;
      mergedFields = mergeOcrFields(mergedFields, result.data.data || {});
    } else {
      ocrErrors.push({
        docType:        key,
        error:          result.data?.error || "OCR processing failed",
        upstreamStatus: result.upstreamStatus,
      });
    }
  }

  const httpStatus = anyFailed && !allSucceeded ? 400 : 200;
  return res.status(httpStatus).json({
    success: allSucceeded || (!anyFailed && !allSucceeded),
    status:  httpStatus,
    message:
      anyFailed && !allSucceeded
        ? ocrErrors.map((e) => `${e.docType}: ${e.error}`).join("; ") || "OCR processing failed"
        : allSucceeded
          ? "Document OCR completed successfully"
          : "Document OCR partially processed — pending review",
    data: {
      ocr: {
        cardType,
        detectedType,
        fields:    mergedFields,
        errors:    ocrErrors.length ? ocrErrors : undefined,
        docCount:  validDocs.length,
        succeeded: ocrResults.filter((r) => r.data?.success).length,
      },
    },
  });
});
