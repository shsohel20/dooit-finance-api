const mongoose = require("mongoose");

/**
 * AuditLog
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic audit trail for background jobs and external-service calls across
 * the whole application. Each record is one finished operation (after all
 * retries), success or failure.
 *
 * Current writers:
 *   service "sumsub" — OCR background jobs fired from ocrDocument:
 *     • action "ocr_info_sync"  — PATCH /info and /fixedInfo from OCR fields
 *     • action "ocr_doc_upload" — POST /info/idDoc per document image
 */
const AuditLogSchema = new mongoose.Schema(
  {
    // Which integration / subsystem produced this entry, e.g. "sumsub"
    service: {
      type: String,
      required: true,
      index: true,
    },
    // Job or operation name, e.g. "ocr_info_sync", "ocr_doc_upload"
    action: {
      type: String,
      required: true,
    },
    // External reference for the operation, e.g. Sumsub applicantId
    externalId: {
      type: String,
      index: true,
    },
    customer: {
      type: mongoose.Schema.ObjectId,
      ref: "Customer",
      index: true,
    },
    journey: {
      type: mongoose.Schema.ObjectId,
      ref: "OnboardingJourney",
    },
    // Sub-target of the action — "info" | "fixedInfo" for ocr_info_sync;
    // docType (e.g. "id_front") for ocr_doc_upload
    target: String,
    status: {
      type: String,
      enum: ["success", "failed"],
      required: true,
    },
    attempts: {
      type: Number,
      default: 1,
    },
    maxAttempts: {
      type: Number,
      default: 3,
    },
    // Last upstream HTTP status; 0 = network error / no response
    httpStatus: Number,
    // Last error description when failed
    error: String,
    // What we sent — JSON payload or doc metadata (never binary)
    requestPayload: mongoose.Schema.Types.Mixed,
    // Last upstream response body
    responseData: mongoose.Schema.Types.Mixed,
    durationMs: Number,
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
  }
);

AuditLogSchema.index({ service: 1, action: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", AuditLogSchema);
