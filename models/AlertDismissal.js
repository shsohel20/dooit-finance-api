// models/AlertDismissal.js
//
// The record behind "we looked at this alert and it was not suspicious".
// docs/74 §7.5 (phase C5).
//
// Why a collection and not a field on Alert: dismissing an alert is a
// reviewable compliance decision, not a status flag. It needs the evidence that
// was considered, an approval step, its own audit trail and a place in the
// case's filings list — the same shape every other report has. `Alert.status`
// still records the outcome; this records the reasoning.
//
// Scope is the ALERT, not the case: a case can hold several alerts and dismiss
// them for different reasons on different days.

const mongoose = require('mongoose');
const uniqueValidator = require('mongoose-unique-validator');
const mongoosePaginate = require('mongoose-paginate-v2');
const AutoIncrement = require('mongoose-sequence')(mongoose);
const { draftFields } = require('./schemas/reportShared');
const { DISMISSAL_CODES, GENERIC } = require('../utils/dismissalTypes');

const { Schema } = mongoose;

// What was actually looked at before deciding. Computed by
// services/caseAnalysis — never taken from the AI (docs/74 §4.5).
const EvidenceReviewedSchema = new Schema(
    {
        alertsReviewed: { type: Number, default: 0 },
        transactionsReviewed: { type: Number, default: 0 },
        totalInflowAUD: { type: Number, default: 0 },
        totalOutflowAUD: { type: Number, default: 0 },
        unconvertedCount: { type: Number, default: 0 },
        jurisdictions: { type: [String], default: [] },
        counterpartiesReviewed: { type: Number, default: 0 },
        riskFlags: { type: [String], default: [] },
        rulesTriggered: { type: [String], default: [] },
        reviewPeriod: {
            start: { type: Date, default: null },
            end: { type: Date, default: null },
        },
        analystNotes: { type: [String], default: [] },
    },
    { _id: false }
);

const AlertDismissalSchema = new Schema(
    {
        uid: { type: String, index: true },
        sequence: { type: Number, index: true },

        // ── Linkage (same block as every other report) ──────────────────────
        alert: { type: Schema.Types.ObjectId, ref: 'Alert', index: true, required: true },
        case: { type: Schema.Types.ObjectId, ref: 'Case', index: true, default: null },
        customer: { type: Schema.Types.ObjectId, ref: 'Customer', index: true, default: null },
        client: { type: Schema.Types.ObjectId, ref: 'Client', index: true, default: null },
        branch: { type: Schema.Types.ObjectId, ref: 'Branch', index: true, default: null },
        caseNumber: { type: String, index: true, default: null },

        // ── Which industry pattern explains the activity ────────────────────
        dismissalType: { type: String, enum: [...DISMISSAL_CODES, GENERIC], default: GENERIC },
        templateKey: { type: String, default: null },
        title: { type: String, default: '' },
        category: { type: String, default: '' },

        // ── Narrative (AI-written, analyst-owned; docs/74 §4.5) ─────────────
        intro: { type: String, default: '' },
        profile: { type: String, default: '' },
        transactionAnalysis: { type: String, default: '' },
        additionalInfo: { type: String, default: '' },
        conclusion: { type: String, default: '' },

        // ── What was considered, and what our own rules say about it ────────
        evidenceReviewed: { type: EvidenceReviewedSchema, default: () => ({}) },
        // Set by US, not by the AI: conditions that mean this alert should not
        // be dismissed yet (unverified KYC, a live SMR on the case).
        requiresEscalation: { type: Boolean, default: false },
        blockingConditions: { type: [String], default: [] },

        // ── Four-eyes ───────────────────────────────────────────────────────
        // draft    → written, awaiting review
        // approved → a second officer signed it off
        // withdrawn→ superseded (e.g. the alert was escalated after all)
        status: {
            type: String,
            enum: ['draft', 'approved', 'withdrawn'],
            default: 'draft',
            index: true,
        },
        closedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        reviewer: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        approvedAt: { type: Date, default: null },

        // ── Draft provenance (alerts snapshot, aiMeta, editedFields) ────────
        ...draftFields(),

        metadata: { type: Schema.Types.Mixed, default: {} },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
        collection: 'alertdismissals',
    }
);

// Tenant-scoped list queries, and "the dismissal for this alert".
AlertDismissalSchema.index({ client: 1, status: 1, createdAt: -1 });
AlertDismissalSchema.index({ alert: 1, createdAt: -1 });

AlertDismissalSchema.pre('save', function (next) {
    if (this.isNew && !this.uid) this.uid = `DISM_${Date.now()}`;
    next();
});

AlertDismissalSchema.plugin(uniqueValidator, { message: '{PATH} must be unique.' });
AlertDismissalSchema.plugin(mongoosePaginate);
AlertDismissalSchema.plugin(AutoIncrement, {
    inc_field: 'sequence',
    id: 'alert_dismissal_sequence',
    start_seq: 1,
});

module.exports = mongoose.model('AlertDismissal', AlertDismissalSchema);
