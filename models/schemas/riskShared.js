// models/schemas/riskShared.js
//
// One home for the risk vocabulary that RuleEngine, Alert, Case, Transaction,
// Customer, Notify and IndividualRiskAssessment all share. Before this file each
// model re-declared its own copy of the risk/SLA fields with slightly different
// enums (doc 72 gaps #20/#21) — import from here instead of copy-pasting.
//
// Exports
//   constants      RISK_LABELS, CASE_TYPES, PRIORITIES, SLA_STATUSES, SIGNAL_SOURCES
//   normalizers    normalizeRiskLabel(), normalizeCaseType(), normalizePriority()
//   field builders riskFields(), slaFields()          → spread into a Schema
//   sub-schemas    RiskSignalSchema, EvaluationStateSchema
//   helpers        addOverdueVirtual(schema, closedStatuses), signalKey(label)

const { Schema } = require('mongoose');

// ── Vocabulary ───────────────────────────────────────────────────────────────

const RISK_LABELS = ['Low', 'Medium', 'High', 'Critical', 'Info'];
const CASE_TYPES = ['Fraud', 'AML', 'Compliance', 'TF'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const SLA_STATUSES = ['on_time', 'at_risk', 'breached'];

// Who produced a risk signal. 'rule' = the evaluator, 'vendor' = Sumsub/AML
// provider, 'analyst' = typed in the UI, 'import' = CSV column, 'system' = a
// derived value (e.g. device reuse count).
const SIGNAL_SOURCES = ['rule', 'analyst', 'vendor', 'import', 'system'];

// ── Normalizers (use at every ingest boundary: AI responses, CSV, webhooks) ──

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** "high" → "High", "Unknown"/null → "Info". Never returns an invalid label. */
function normalizeRiskLabel(raw) {
    if (raw === null || raw === undefined) return 'Info';
    const label = titleCase(String(raw).trim());
    return RISK_LABELS.includes(label) ? label : 'Info';
}

/** "aml" → "AML", "tf" → "TF", anything unknown ("Regular", "Default") → "AML". */
function normalizeCaseType(raw) {
    if (raw === null || raw === undefined) return 'AML';
    const s = String(raw).trim();
    const hit = CASE_TYPES.find((c) => c.toLowerCase() === s.toLowerCase());
    return hit || 'AML';
}

/** "Urgent"/"critical" → "critical"; unknown → "medium". */
function normalizePriority(raw) {
    if (raw === null || raw === undefined) return 'medium';
    const s = String(raw).trim().toLowerCase();
    if (s === 'urgent') return 'critical';
    return PRIORITIES.includes(s) ? s : 'medium';
}

// ── Derived operational values ───────────────────────────────────────────────

/** Alert/Case priority implied by a risk label (analysts can override later). */
function priorityForRiskLabel(riskLabel) {
    const r = String(riskLabel || '').toLowerCase();
    if (r === 'critical') return 'critical';
    if (r === 'high') return 'high';
    if (r === 'low') return 'low';
    return 'medium';
}

/** Default SLA per label when a rule has no `slaHours` of its own. */
const SLA_HOURS_BY_LABEL = { Critical: 24, High: 48, Medium: 72, Low: 120, Info: 168 };

/** Deadline = now + rule.slaHours, else the label table. */
function slaDeadlineFor(riskLabel, slaHours = null, now = new Date()) {
    const hours = slaHours != null && slaHours > 0 ? slaHours : SLA_HOURS_BY_LABEL[normalizeRiskLabel(riskLabel)];
    return new Date(now.getTime() + hours * 3600e3);
}

// ── Field builders ───────────────────────────────────────────────────────────

/**
 * { riskScore, riskLabel } — spread into a schema definition.
 *   riskFields()                          → optional, defaults 0 / 'Low'
 *   riskFields({ required: true })        → RuleEngine style (must be set)
 *   riskFields({ nullable: true })        → Case style (null until derived)
 */
function riskFields({ required = false, nullable = false, index = false } = {}) {
    return {
        riskScore: {
            type: Number,
            min: 0,
            max: 100,
            required,
            default: nullable ? null : 0,
            index,
        },
        riskLabel: {
            type: String,
            enum: nullable ? [...RISK_LABELS, null] : RISK_LABELS,
            required,
            default: nullable ? null : 'Low',
            index,
        },
    };
}

/** { slaDeadline, slaStatus } — identical on Alert and Case. */
function slaFields() {
    return {
        slaDeadline: { type: Date, default: null },
        slaStatus: { type: String, enum: SLA_STATUSES, default: 'on_time' },
    };
}

/**
 * Adds the `isOverdue` virtual: past the SLA deadline and not in a terminal
 * status. `closedStatuses` differs per model (Alert: dismissed/escalated…,
 * Case: closed) so the caller supplies it.
 */
function addOverdueVirtual(schema, closedStatuses = []) {
    schema.virtual('isOverdue').get(function () {
        if (!this.slaDeadline) return false;
        return !closedStatuses.includes(this.status) && new Date() > this.slaDeadline;
    });
}

// ── Risk signals ─────────────────────────────────────────────────────────────
//
// A typed key/value the rule engine can read when the fact has no dedicated
// schema column — "Beneficiary on watchlist", "Device fingerprint banned",
// "Sender risk tier" (193 imported rules reference such labels, see doc 72
// §3.3). Lives as `signals[]` on Transaction and Customer. A rule references
// it as `signals.<key>`; the evaluator also falls back to the signal whose key
// equals signalKey(<analyst label>).

/** "Beneficiary on watchlist" → "beneficiary_on_watchlist" */
const signalKey = (label) =>
    String(label || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

const RiskSignalSchema = new Schema(
    {
        key: { type: String, required: true, trim: true, lowercase: true, set: signalKey },
        value: { type: Schema.Types.Mixed, required: true }, // boolean | number | string
        source: { type: String, enum: SIGNAL_SOURCES, default: 'system' },
        observedAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, default: null }, // null = does not expire
        note: { type: String, trim: true, default: '' },
    },
    { _id: false }
);

// ── Evaluation state ─────────────────────────────────────────────────────────
//
// What the engine last did to this document. Written by the evaluator hook
// (doc 72 E2); read by the UI to show "evaluated against N rules, M fired".

const EvaluationStateSchema = new Schema(
    {
        lastEvaluatedAt: { type: Date, default: null },
        ruleCount: { type: Number, default: 0 },                // rules evaluated
        firedRuleIds: { type: [String], default: [] },          // RuleEngine.ruleId
        firedAlerts: [{ type: Schema.Types.ObjectId, ref: 'Alert' }],
    },
    { _id: false }
);

module.exports = {
    RISK_LABELS,
    CASE_TYPES,
    PRIORITIES,
    SLA_STATUSES,
    SIGNAL_SOURCES,
    normalizeRiskLabel,
    normalizeCaseType,
    normalizePriority,
    priorityForRiskLabel,
    SLA_HOURS_BY_LABEL,
    slaDeadlineFor,
    riskFields,
    slaFields,
    addOverdueVirtual,
    signalKey,
    RiskSignalSchema,
    EvaluationStateSchema,
};
