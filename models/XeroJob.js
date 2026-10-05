const mongoose = require("mongoose");
const { Schema } = mongoose;

// XeroJob — Mongo-backed work queue (no external broker in this stack).
// Claimed atomically by services/xero/jobQueue.js; failed jobs back off and
// retry until `maxAttempts`, then park as `dead` for inspection.

const JOB_TYPES = ["full_sync", "outbound_sync", "inbound_event"];

const XeroJobSchema = new Schema(
  {
    type: { type: String, enum: JOB_TYPES, required: true },
    tenantId: { type: String, required: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Client", default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    // De-duplicates identical pending work (e.g. a webhook redelivered).
    dedupeKey: { type: String, default: null },
    status: {
      type: String,
      enum: ["queued", "running", "done", "failed", "dead"],
      default: "queued",
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextRunAt: { type: Date, default: Date.now },
    lockedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    requestedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
  },
  { timestamps: true }
);

XeroJobSchema.index({ status: 1, nextRunAt: 1 });
XeroJobSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["queued", "running"] }, dedupeKey: { $type: "string" } },
  }
);
// Finished jobs age out after 30 days.
XeroJobSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: "done" } }
);

module.exports = mongoose.models.XeroJob || mongoose.model("XeroJob", XeroJobSchema);
module.exports.JOB_TYPES = JOB_TYPES;
