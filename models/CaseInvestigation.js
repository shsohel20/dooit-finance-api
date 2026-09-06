// models/CaseInvestigation.js
//
// The Investigation Hub's memory: one record per case holding the analyst's
// progress through the 12-step workflow. docs/74 C18 (= doc 70 R3).
//
// Until this existed the wizard was entirely local React state — every
// selection, red flag, typology, person of interest and SMR part an analyst
// entered was lost on reload, and the hub pre-completed six steps for every
// case so the progress bar read "6/12" before anyone had looked at it.
//
// Shape: the parts with a stable meaning (progress, template choice, SMR part)
// are typed; the per-step selections are `Mixed` on purpose. The step catalogue
// lives in the UI and changes with it, so pinning a schema to today's step keys
// would force a migration every time a question is reworded. What matters here
// is that the analyst's work survives, keyed to the case and attributable.

const mongoose = require('mongoose');

const { Schema } = mongoose;

const ChecklistItemSchema = new Schema(
    {
        text: { type: String, trim: true },
        checked: { type: Boolean, default: false },
    },
    { _id: false }
);

const CaseInvestigationSchema = new Schema(
    {
        // One investigation per case — the unique index is the guarantee that
        // two browser tabs cannot fork an analyst's progress into two records.
        case: {
            type: Schema.Types.ObjectId,
            ref: 'Case',
            required: true,
            unique: true,
            index: true,
        },
        client: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
        branch: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

        // ── Progress ─────────────────────────────────────────────────────────
        // No pre-completion: a new investigation starts at step 0 with nothing
        // done, so the progress bar tells the truth from the first render.
        activeStep: { type: Number, default: 0, min: 0 },
        stepsDone: { type: [Boolean], default: [] },
        checklist: { type: [ChecklistItemSchema], default: [] },

        // ── The analyst's answers ────────────────────────────────────────────
        // Keyed by step index or step key, as the wizard emits them.
        selections: { type: Schema.Types.Mixed, default: {} },
        pois: { type: [Schema.Types.Mixed], default: [] },
        customTypologies: { type: [String], default: [] },
        customReasons: { type: [String], default: [] },
        dateRange: {
            start: { type: Date, default: null },
            end: { type: Date, default: null },
        },

        // ── Narrative (step 7) ───────────────────────────────────────────────
        narrativeTemplate: { type: String, enum: ['ecdd', 'gfs'], default: 'ecdd' },
        narrative: { type: Schema.Types.Mixed, default: {} },

        // ── SMR wizard (step 11) ─────────────────────────────────────────────
        smr: {
            part: { type: String, default: 'A' },
            parts: { type: Schema.Types.Mixed, default: {} },
            // Set once the analyst turns this progress into a real SMR record.
            report: { type: Schema.Types.ObjectId, ref: 'SMR', default: null },
        },

        // ── Outcome (steps 9, 10, 12) ────────────────────────────────────────
        decision: { type: String, trim: true, default: null },
        managerReview: { type: String, trim: true, default: null },
        ongoingMonitoring: { type: String, trim: true, default: null },

        // ── Attribution ──────────────────────────────────────────────────────
        createdBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        lastSavedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null, index: true },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
        collection: 'caseinvestigations',
    }
);

// "How far along is this case?" — read by the case list and the hub header.
CaseInvestigationSchema.virtual('completedSteps').get(function () {
    return (this.stepsDone || []).filter(Boolean).length;
});

module.exports = mongoose.model('CaseInvestigation', CaseInvestigationSchema);
