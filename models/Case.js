const mongoose = require('mongoose');
const uniqueValidator  = require('mongoose-unique-validator');
const mongoosePaginate = require('mongoose-paginate-v2');
const AutoIncrement    = require('mongoose-sequence')(mongoose);

const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Case schema
//
// Notes and audit trail are stored in separate collections:
//   CaseNote  — analyst notes / attachments  (collection: casenotes)
//   AuditLog  — system event log             (collection: auditlogs)
//   Report    — regulatory filings (SAR, STR, ECDD, TTR …) (collection: reports)
//
// Access model:
//   - client === null  →  system-level case  (dooit internal)
//   - client !== null  →  tenant case
// ─────────────────────────────────────────────────────────────────────────────

const CaseSchema = new Schema(
    {
        // ── Identity ─────────────────────────────────────────────────────────
        uid:      { type: String, unique: true, sparse: true, index: true },
        sequence: { type: Number, index: true },

        // ── Multi-tenant ─────────────────────────────────────────────────────
        client: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
        branch: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

        // ── Core ─────────────────────────────────────────────────────────────
        title: {
            type:      String,
            required:  [true, 'Case title is required'],
            trim:      true,
            maxlength: [200, 'Title cannot exceed 200 characters'],
        },
        description: {
            type:      String,
            trim:      true,
            maxlength: [5000, 'Description cannot exceed 5000 characters'],
            default:   null,
        },

        // ── Classification ───────────────────────────────────────────────────
        // type    — investigation workflow category (SAR filing, PEP review, etc.)
        // caseType — AML domain, consistent with RuleEngine.caseType and Alert.caseType
        type: {
            type:    String,
            enum:    ['SAR', 'PEP', 'transaction_monitoring', 'other'],
            default: 'other',
            index:   true,
        },
        caseType: {
            type:    String,
            enum:    ['Fraud', 'AML', 'Compliance', 'TF'],
            default: null,
            index:   true,
        },

        // ── Risk ─────────────────────────────────────────────────────────────
        // Derived from linked alerts; updated when alerts are added/removed.
        riskScore: { type: Number, min: 0, max: 100, default: null },
        riskLabel: {
            type:    String,
            enum:    ['Low', 'Medium', 'High', 'Critical', 'Info', null],
            default: null,
        },

        // ── Priority ─────────────────────────────────────────────────────────
        priority: {
            type:    String,
            enum:    ['low', 'medium', 'high', 'critical'],
            default: 'medium',
            index:   true,
        },

        // ── Workflow status ──────────────────────────────────────────────────
        // open                → newly created, awaiting assignment
        // under_investigation → analyst actively investigating
        // pending_review      → awaiting compliance sign-off
        // closed              → resolved
        // escalated           → elevated to regulator / senior team
        status: {
            type:    String,
            enum:    ['open', 'under_investigation', 'pending_review', 'closed', 'escalated'],
            default: 'open',
            index:   true,
        },
        closureReason: {
            type:      String,
            trim:      true,
            maxlength: [1000, 'Closure reason cannot exceed 1000 characters'],
            default:   null,
        },
        closedAt: { type: Date, default: null },

        // ── Linked records ───────────────────────────────────────────────────
        linkedCustomers:    [{ type: Schema.Types.ObjectId, ref: 'Customer' }], // Need customer single 
        linkedAlerts:       [{ type: Schema.Types.ObjectId, ref: 'Alert' }], // Should be same customer but income
        linkedTransactions: [{ type: Schema.Types.ObjectId, ref: 'Transaction' }],

        // ── People ───────────────────────────────────────────────────────────
        // assignedTo: primary responsible analyst (single field for dashboard queries)
        // watchers: additional team members receiving updates
        assignedTo: { type: Schema.Types.ObjectId, ref: 'Users', default: null, index: true },
        // reviewer: the checker in the maker→checker (four-eyes) review flow.
        reviewer:   { type: Schema.Types.ObjectId, ref: 'Users', default: null, index: true },
        watchers:   [{ type: Schema.Types.ObjectId, ref: 'Users' }],
        createdBy: {
            type:     Schema.Types.ObjectId,
            ref:      'Users',
            required: [true, 'createdBy is required'],
            index:    true,
        },

        // ── Decision ─────────────────────────────────────────────────────────
        // Recorded when a case is closed. Separate from status so the outcome
        // is queryable even if the case is later re-opened.
        // The actual regulatory report (SAR, STR, etc.) lives in the Report collection.
        decision: {
            type:  String,
            enum:  ['true_positive', 'false_positive', 'sar_filed', 'no_action', null],
            default: null,
            index: true,
        },
        decisionNotes: { type: String, trim: true, maxlength: 5000, default: null },
        decidedAt:     { type: Date, default: null },
        decidedBy:     { type: Schema.Types.ObjectId, ref: 'Users', default: null },

        // ── SLA ──────────────────────────────────────────────────────────────
        slaDeadline: { type: Date, default: null },
        slaStatus: {
            type:    String,
            enum:    ['on_time', 'at_risk', 'breached'],
            default: 'on_time',
        },

        // ── Metadata ─────────────────────────────────────────────────────────
        tags:     [{ type: String, trim: true }],
        metadata: { type: Schema.Types.Mixed, default: {} },

        // ── Soft delete ──────────────────────────────────────────────────────
        isDeleted: { type: Boolean, default: false, index: true },
        deletedAt: { type: Date, default: null },
    },
    {
        timestamps: true,
        toJSON:     { virtuals: true },
        toObject:   { virtuals: true },
        collection: 'cases',
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────────────────────

CaseSchema.index({ client: 1, status: 1, createdAt: -1 });
CaseSchema.index({ client: 1, isDeleted: 1, status: 1 });
CaseSchema.index({ status: 1, priority: 1, createdAt: -1 });
CaseSchema.index({ linkedAlerts: 1 });
CaseSchema.index({ linkedCustomers: 1 });
CaseSchema.index({ title: 'text', description: 'text' });

// ─────────────────────────────────────────────────────────────────────────────
// Virtuals
// ─────────────────────────────────────────────────────────────────────────────

CaseSchema.virtual('isOverdue').get(function () {
    if (!this.slaDeadline) return false;
    return !['closed'].includes(this.status) && new Date() > this.slaDeadline;
});

// Convenience: total linked alert count (populated separately via CaseNote / AuditLog)
CaseSchema.virtual('alertCount').get(function () {
    return Array.isArray(this.linkedAlerts) ? this.linkedAlerts.length : 0;
});

// ── Reverse report linkage (Phase 4) ─────────────────────────────────────────
// Virtual populate keeps reports normalized — a case never re-saves when a
// report is added. NOTE the foreignField differs by model: ECDD/SMR use `caseId`;
// TTR/IFTI/GFS/RFI use `case`.
CaseSchema.virtual('ecddReports', { ref: 'EcddReport', localField: '_id', foreignField: 'caseId' });
CaseSchema.virtual('smrReports',  { ref: 'SMR',        localField: '_id', foreignField: 'caseId' });
CaseSchema.virtual('ttrReports',  { ref: 'TTR',        localField: '_id', foreignField: 'case' });
CaseSchema.virtual('iftiReports', { ref: 'IFTI',       localField: '_id', foreignField: 'case' });
CaseSchema.virtual('gfsReports',  { ref: 'GFS',        localField: '_id', foreignField: 'case' });
CaseSchema.virtual('rfis',        { ref: 'RFI',        localField: '_id', foreignField: 'case' });

// ─────────────────────────────────────────────────────────────────────────────
// Plugins — AutoIncrement registered first so sequence is set before pre-save
// ─────────────────────────────────────────────────────────────────────────────

CaseSchema.plugin(AutoIncrement, {
    inc_field: 'sequence',
    id:        'case_sequence',
    start_seq: 1,
});

// uid is derived from sequence; sequence is guaranteed set by AutoIncrement above.
CaseSchema.pre('save', function (next) {
    if (this.isNew && !this.uid && this.sequence) {
        this.uid = `CA-${String(this.sequence).padStart(7, '0')}`;
    }
    next();
});

// Auto-set closedAt when status transitions to closed
CaseSchema.pre('save', function (next) {
    if (this.isModified('status') && this.status === 'closed' && !this.closedAt) {
        this.closedAt = new Date();
    }
    next();
});

CaseSchema.plugin(uniqueValidator,  { message: '{PATH} must be unique.' });
CaseSchema.plugin(mongoosePaginate);

// ─────────────────────────────────────────────────────────────────────────────

module.exports = mongoose.model('Case', CaseSchema);
