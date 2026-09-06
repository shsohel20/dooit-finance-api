const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// TbmlReport
//
// Our copy of a trade-based money laundering screening run performed by the
// OSINT Engine (https://osint.dooit.ai/docs — "TBML OSINT").
//
// The engine is the system of record for the analysis; this collection is the
// cache and the tenancy layer around it. It exists for three reasons:
//
//   1. Screening is asynchronous. A submission answers in milliseconds and the
//      analysis lands minutes later, so something has to hold the reference and
//      chase the result — see services/tbmlScreening.js.
//   2. A finished report never changes. Re-reading one should not cost a
//      round-trip to the engine, a model call, or the shared API key.
//   3. The engine authenticates with a tenant-wide key and knows nothing about
//      our clients, branches or users. Scoping a run to a case, a client and
//      the analyst who ordered it can only happen here.
//
// `report` holds the engine's ReportDetailResponse verbatim. It is deliberately
// Mixed: the nested extract, per-product research and evidence pages are the
// engine's shape, and re-declaring them here would mean a schema change every
// time it adds a field — with the old fields silently dropped in the meantime.
// ─────────────────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'COLLECTION_FAILED'];

const TbmlReportSchema = new Schema(
  {
    // ── Engine identity ──────────────────────────────────────────────────────
    reportId:     { type: String, required: true, unique: true, index: true },
    submissionId: { type: String, default: null },

    // 1 = production records, 2 = stage. Stored per report because it decides
    // which engine database a later read must be addressed to.
    dbSource:    { type: Number, enum: [1, 2], required: true },
    environment: { type: String, default: null },

    // ── Ownership ────────────────────────────────────────────────────────────
    client:   { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    branch:   { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    case:     { type: Schema.Types.ObjectId, ref: 'Case', default: null, index: true },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    // The Case.documents subdocument this run screened.
    caseDocument: { type: Schema.Types.ObjectId, default: null },
    documentName: { type: String, default: null },

    submittedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
    submittedAt: { type: Date, default: Date.now, index: true },

    // ── Headline (denormalised so a list never has to open `report`) ─────────
    status: {
      type:    String,
      enum:    ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'COLLECTION_FAILED'],
      default: 'PENDING',
      index:   true,
    },
    overallRiskLevel: {
      type:    String,
      enum:    ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'INSUFFICIENT_DATA', null],
      default: null,
    },
    overallRiskScore:      { type: Number, default: null },
    productsDetected:      { type: Number, default: 0 },
    requiresAnalystReview: { type: Boolean, default: null },
    errorMessage:          { type: String, default: null },
    completedAt:           { type: Date, default: null },

    // ── Cached payloads ──────────────────────────────────────────────────────
    // GET /reports/{id}?include_sources=true — fetched once, when the run
    // reaches a terminal status.
    report: { type: Schema.Types.Mixed, default: null },
    // GET /reports/{id}/documents — the files that were submitted.
    files:  { type: Schema.Types.Mixed, default: null },
    // GET /reports/{id}/trail — every search result seen. Large, and only some
    // runs are ever audited that closely, so it is fetched on first request.
    trail:  { type: Schema.Types.Mixed, default: null },

    // ── Poll bookkeeping ─────────────────────────────────────────────────────
    refreshedAt:   { type: Date, default: null },
    pollAttempts:  { type: Number, default: 0 },
    lastPollError: { type: String, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, collection: 'tbmlreports' }
);

TbmlReportSchema.plugin(mongoosePaginate);

// The list a case detail page asks for.
TbmlReportSchema.index({ case: 1, submittedAt: -1 });
// The poller's working set.
TbmlReportSchema.index({ status: 1, refreshedAt: 1 });

/** True once the engine will not change this run again. */
TbmlReportSchema.methods.isTerminal = function isTerminal() {
  return TERMINAL_STATUSES.includes(this.status);
};

module.exports = mongoose.model('TbmlReport', TbmlReportSchema);
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
