const mongoose = require("mongoose");

/**
 * AuditLog
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic audit trail for background jobs, external-service calls and
 * compliance events across the whole application.
 *
 * Current writers:
 *   service "sumsub" — OCR background jobs fired from ocrDocument:
 *     • action "ocr_info_sync"  — PATCH /info and /fixedInfo from OCR fields
 *     • action "ocr_doc_upload" — POST /info/idDoc per document image
 *   service "cra" — CRA compliance events (utils/craAudit.js), per
 *   CRA_Scoring_Method.md Section 4 "Audit trail on every change":
 *     • CRA_CREATED / CRA_RISK_UPDATED / CRA_NOTES_UPDATED
 *     • ECDD_APPROVED / ECDD_DECLINED / ESCALATION_RAISED
 *     CRA entries carry actor*, beforeValue/afterValue and assessment refs.
 */
const AuditLogSchema = new mongoose.Schema(
  {
    // Which integration / subsystem produced this entry, e.g. "sumsub", "case", "cra"
    service: {
      type: String,
      required: false,
      default: "case",
      index: true,
    },
    // Job or operation name, e.g. "ocr_info_sync", "case_created", "status_changed"
    action: {
      type: String,
      required: true,
    },
    // Human-readable detail message (used by case audit trail)
    details: {
      type: String,
      default: null,
    },
    // Case this log entry belongs to (case audit trail)
    case: {
      type: mongoose.Schema.ObjectId,
      ref: "Case",
      index: true,
      default: null,
    },
    // User who performed the action (case audit trail)
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "Users",
      index: true,
      default: null,
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
      required: false,
      default: "success",
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

    // ── CRA compliance fields (service "cra") ────────────────────────────────
    // Spec shape: {timestamp, actor_name, actor_role, action_type,
    //              before_value, after_value, linked_matter_id}
    assessment: {
      type: mongoose.Schema.ObjectId,
      ref: "IndividualRiskAssessment",
      index: true,
    },
    // ── KYB compliance fields (service "kyb", utils/kybAudit.js) ─────────────
    companyKyc: {
      type: mongoose.Schema.ObjectId,
      ref: "CompanyKyc",
      index: true,
    },
    client: { type: mongoose.Schema.ObjectId, ref: "Client", index: true },
    branch: { type: mongoose.Schema.ObjectId, ref: "Branch" },
    actor: { type: mongoose.Schema.ObjectId, ref: "Users" },
    actorName: String,
    actorRole: String,
    beforeValue: mongoose.Schema.Types.Mixed,
    afterValue: mongoose.Schema.Types.Mixed,
    linkedMatterId: String,

    // ── Cross-domain refs (docs/71 coverage rollout) ─────────────────────────
    transaction: {
      type: mongoose.Schema.ObjectId,
      ref: "Transaction",
      index: true,
      default: null,
    },
    alert: {
      type: mongoose.Schema.ObjectId,
      ref: "Alert",
      index: true,
      default: null,
    },
    // Which report a service:"report" entry concerns: SMR|TTR|IFTI|GFS|ECDD|RFI.
    // The report id goes in `target` (uid preferred) — reports live in five
    // collections, so a single ref is not possible without refPath.
    reportType: { type: String, default: null },

    // ── Device / network context (utils/auditContext.js) ─────────────────────
    // Who ran the operation, from where, on what device.
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    // Stable device identity string (Device.deviceId — header or fingerprint)
    deviceId: { type: String, index: true, default: null },
    // Registry row in the Device collection, when one was resolved
    device: {
      type: mongoose.Schema.ObjectId,
      ref: "Device",
      default: null,
    },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
  }
);

AuditLogSchema.index({ service: 1, action: 1, status: 1, createdAt: -1 });
AuditLogSchema.index({ case: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", AuditLogSchema);
