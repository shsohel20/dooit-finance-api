// models/schemas/reportShared.js
//
// The pieces every drafted compliance report carries, so ECDD / SMR / GFS / RFI
// (and Dismissal later) describe their provenance the same way.
// docs/74 §7.1 (phase C3).
//
// The governing rule this file exists to support: **facts come from our API,
// prose comes from the AI**. `aiMeta` records exactly which narrative sections
// the AI supplied and how, `editedFields` records what an analyst has since
// rewritten (so regenerating never silently overwrites their words), and
// `alerts[]` freezes the alert evidence as it stood when the draft was made.

const { Schema } = require('mongoose');

// ── Provenance of the AI-written prose ──────────────────────────────────────

const AiDraftMetaSchema = new Schema(
    {
        provider: { type: String, default: 'ai-report-summary' },
        apiVersion: { type: String, default: null },   // _meta.api_version
        model: { type: String, default: null },        // _meta.llm_model
        generatedAt: { type: Date, default: null },
        generationMs: { type: Number, default: null },
        piiMode: { type: String, default: null },      // _meta.pii_mode
        alertScope: { type: String, default: null },   // single alert vs all_case_alerts
        alertIds: [{ type: Schema.Types.ObjectId, ref: 'Alert' }],

        // ── Whose data was this drafted for, and did the service agree? ──────
        //
        // The service reads our database directly and does NOT scope by client
        // (docs/74 C15): a customer onboarded under several clients has ALL of
        // their activity counted into one client's report. We only store facts
        // we computed ourselves, but the service still WRITES ITS PROSE from
        // whatever it read — so a narrative can quote another tenant's totals.
        //
        // `client` records the tenant the draft was made for, and `scope`
        // compares what the service saw against what we see for that tenant.
        // A mismatch does not discard the prose (a benign timing difference
        // looks the same); it is recorded and surfaced so the analyst reviewing
        // before filing knows the narrative may reach beyond this client.
        client: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
        branch: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
        requestedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        scope: {
            ourTransactionCount: { type: Number, default: null },
            theirTransactionCount: { type: Number, default: null },
            ourAlertCount: { type: Number, default: null },
            theirAlertCount: { type: Number, default: null },
            // POIs on this case that another client also holds — the condition
            // that makes an unscoped read reach beyond this tenant.
            sharedCustomers: { type: Number, default: 0 },
            mismatch: { type: Boolean, default: false },
        },

        // Which whitelisted narrative fields actually came back and were used.
        sectionsUsed: { type: [String], default: [] },
        // Whitelisted fields we dropped (empty, or a PII token leaked through).
        sectionsRejected: { type: [String], default: [] },

        // The service's own view of the data it read.
        dataQuality: {
            missingFields: { type: [String], default: [] },
            warnings: { type: [String], default: [] },
            complete: { type: Boolean, default: null },
        },

        // Set when the draft was saved WITHOUT prose because the AI failed.
        // The facts are still valid — only the narrative is missing.
        error: {
            code: { type: String, default: null },
            message: { type: String, default: null },
            at: { type: Date, default: null },
        },
    },
    { _id: false }
);

// ── Alert evidence, frozen at draft time ────────────────────────────────────
// A rule can be edited or an alert reclassified after filing; the report must
// still show what was true when it was written.

const AlertSnapshotSchema = new Schema(
    {
        alert: { type: Schema.Types.ObjectId, ref: 'Alert' },
        uid: { type: String, trim: true },
        ruleId: { type: String, trim: true },
        ruleName: { type: String, trim: true },
        ruleVersion: { type: Number, default: null },
        caseType: { type: String, trim: true },
        riskScore: { type: Number, default: null },
        riskLabel: { type: String, trim: true },
        alertOrigin: { type: String, trim: true },
        explanation: { type: String, trim: true },
        status: { type: String, trim: true },
        triggeredAt: { type: Date, default: null },
    },
    { _id: false }
);

// ── Field builder ───────────────────────────────────────────────────────────

/**
 * Spread into any report schema that can be drafted.
 * @param {Object} [opts]
 * @param {boolean} [opts.withAnalysis] also freeze the full case analysis
 *        (ECDD only — it is the report that restates the numbers in full).
 */
function draftFields({ withAnalysis = false } = {}) {
    const fields = {
        alerts: { type: [AlertSnapshotSchema], default: [] },
        aiMeta: { type: AiDraftMetaSchema, default: null },
        // Narrative keys an analyst has edited. Regeneration replaces every
        // other narrative field and leaves these alone.
        editedFields: { type: [String], default: [] },
        // When the facts on this draft were computed (Case.analysis.computedAt).
        analysisComputedAt: { type: Date, default: null },
    };
    if (withAnalysis) fields.analysisSnapshot = { type: Schema.Types.Mixed, default: null };
    return fields;
}

/** One IP the case's activity was seen from (detail behind the `ipLocations` count). */
const ReportIpSchema = new Schema(
    {
        ip: { type: String, trim: true },
        location: { type: String, trim: true, default: null },
        count: { type: Number, default: 0 },
    },
    { _id: false }
);

module.exports = { AiDraftMetaSchema, AlertSnapshotSchema, ReportIpSchema, draftFields };
