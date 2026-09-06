// models/RuleEngine.js
const mongoose = require('mongoose');

const { Schema } = mongoose;
const { RISK_LABELS, CASE_TYPES } = require('./schemas/riskShared');

/**
 * Structured condition leaf
 * { field: "amount", operator: "gt", value: 10000 }
 * { field: "country", operator: "in", values: ["IR","KP"] }
 * { field: "amount", operator: "between", min: 1000, max: 5000 }
 */
// A leaf field is a schema path ("amount", "customer.isPep") or an analyst
// label still awaiting mapping ("Account open days"). It must never contain
// operator / grouping characters — those mean the DSL parser split a sentence
// in the wrong place (e.g. field = "New account (").
const LEAF_FIELD_PATTERN = /^[^()<>=!&|]+$/;

const ConditionLeafSchema = new Schema(
    {
        field: {
            type: String,
            trim: true,
            required: true,
            validate: {
                validator: (v) => LEAF_FIELD_PATTERN.test(v),
                message: 'Condition field must not contain operator characters ( ) < > = ! & |',
            },
        },
        operator: {
            type: String,
            enum: [
                'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
                'in', 'nin', 'between',
                'contains', 'startsWith', 'endsWith',
                'exists', 'regex',
            ],
            required: true,
        },
        value: Schema.Types.Mixed,           // for eq/ne/gt/lt/contains/regex
        values: { type: [Schema.Types.Mixed], default: undefined }, // for in/nin
        min: Schema.Types.Mixed,             // for between
        max: Schema.Types.Mixed,             // for between
    },
    { _id: false }
);

/**
 * Logic tree node — { logic: 'AND'|'OR', children: [ leaf | node ] }
 * Stored as Mixed because Mongoose can't recursively type a self-referencing
 * sub-schema cleanly. Validate shape in the controller (zod) on write.
 */
const RuleEngineSchema = new Schema(
    {
        // ─────────────── Tenant ──────────────────────────────────────────────
        // client === null  →  system rule (owned by dooit)
        // client === ObjectId  →  client rule (owned by that client)
        client: {
            type: Schema.Types.ObjectId,
            ref: 'Client',
            required: false,
            default: null,
            index: true,
        },
        branch: {
            type: Schema.Types.ObjectId,
            ref: 'Branch',
            required: false,
            default: null,
            index: true,
        },

        // ─────────────── Visibility (system rules only) ──────────────────────
        // When true, client users can read this system rule in their dashboard.
        // Only meaningful when client === null; ignored on client-owned rules.
        // Only dooit may toggle this — dedicated PATCH /:id/visibility endpoint.
        visibleToClients: {
            type: Boolean,
            default: false,
            index: true,
        },

        // ─────────────── Identity ────────────────────────────────────────────
        // Uniqueness is enforced per tenant via the compound
        // { client: 1, ruleId: 1 } index below — not globally.
        ruleId: {
            type: String,
            required: true,
            trim: true,
        },
        ruleName: {
            type: String,
            required: true,
            trim: true,
        },

        // ─────────────── Logic (string DSL preserved for legacy) ─────────────
        ruleCondition: {
            type: String,
            required: true,
        },
        descriptiveExplanation: {
            type: String,
            default: '',
        },
        ruleDomainSubdomain: {
            type: String,
            trim: true,
        },
        mainDomain: {
            type: String,
            trim: true,
            index: true,
        },

        // ─────────────── Classification ──────────────────────────────────────
        caseType: {
            type: String,
            // Re-enabled 21 Aug 2026 — the whole corpus already uses only these
            // four values; the controller's sanitizeCaseType maps the rest.
            enum: CASE_TYPES,
            required: true,
        },
        riskScore: {
            type: Number,
            min: 0,
            max: 100,
            required: true,
        },
        riskLabel: {
            type: String,
            enum: RISK_LABELS,
            required: true,
        },

        // ─────────────── Versioning ──────────────────────────────────────────
        // Auditors need "show me the rule as it was when alert X fired".
        // Bumped on every logic change by the hooks below; each version's
        // snapshot is persisted to RuleEngineVersion (see recordVersion).
        version: { type: Number, default: 1 },

        // ─────────────── Target entity ───────────────────────────────────────
        // Which document the rule is evaluated against. Only these two subjects
        // are supported (account/KYB were dropped). Backfilled by
        // seeds/classify-rule-applies-to.js for the imported corpus.
        appliesTo: {
            type: String,
            enum: ['transaction', 'customer'],
            default: 'transaction',
            index: true,
        },

        // HOW the rule is evaluated (appliesTo says against WHAT). Set by
        // seeds/repair-rule-conditions.js for the imported corpus; the UI
        // builder always produces 'predicate'.
        //   predicate  — logic/conditions evaluated per document
        //   aggregate  — predicate + `aggregation` window (velocity/structuring)
        //   screening  — list/PEP/sanctions match; resolves to a customer flag
        //   manual     — narrative typology; engine skips it, analysts apply it
        engine: {
            type: String,
            enum: ['predicate', 'aggregate', 'screening', 'manual'],
            default: 'predicate',
            index: true,
        },

        // Free-form tag for grouping in the UI: 'threshold','velocity',
        // 'geography','pep','sanctions','structuring','high-risk-country'…
        // Also used by the categorizer script (Phase 2 data quality work) to
        // tag DSL family: 'dsl-natural' | 'dsl-dotted' | 'external-screening'
        // | 'behavioral-pattern' | 'ambiguous'.
        category: { type: String, trim: true },

        // ─────────────── Structured logic (parallel to ruleCondition) ────────
        // Optional. When present, the engine should prefer this over the
        // string `ruleCondition`. Tree shape:
        //   { logic: 'AND'|'OR', children: [ <leaf|node>, ... ] }
        logic: { type: Schema.Types.Mixed, default: null },

        // Flat condition list — useful for simple rules where a logic tree
        // is overkill. Treated as implicit AND if `logic` is null.
        conditions: { type: [ConditionLeafSchema], default: undefined },

        // ─────────────── Aggregation (velocity-style rules) ──────────────────
        aggregation: {
            window: {
                value: { type: Number, min: 1 },
                unit: {
                    type: String,
                    enum: ['minute', 'hour', 'day'],
                    default: 'minute',
                },
            },
            count: { type: Number, min: 1 },          // e.g. ≥ 5 txns
            sumThreshold: { type: Number, min: 0 },   // e.g. ≥ 50,000 in window
            // Which party the window is bucketed by. 'customer' = the subject
            // customer (ruleEvaluation.subjectKey); 'sender'/'beneficiary' =
            // that party's account/name, for "N transfers to same beneficiary".
            groupBy: {
                type: String,
                enum: ['customer', 'sender', 'beneficiary'],
                default: 'customer',
            },
        },

        // ─────────────── Re-fire control (doc 72 §6.3) ───────────────────────
        // Consumed by the evaluator once alerts are produced from rules (E1/E3).
        // Until then they are schema-only; defaults match today's behaviour.
        dedupeBy: {
            type: String,
            enum: ['rule_customer_txn', 'rule_customer_day'],
            default: 'rule_customer_txn',
        },
        cooldownMinutes: { type: Number, min: 0, default: 0 }, // suppress re-fire inside window
        slaHours: { type: Number, min: 0, default: null },     // per-rule SLA override

        // ─────────────── Actions (what the rule does when it fires) ──────────
        actions: {
            type: [
                {
                    _id: false,
                    type: {
                        type: String,
                        // 'create_report' (Phase 0 §10 Q2) auto-drafts a TTR/IFTI for analyst
                        // review. Schema-ready; execution lands when a rule-evaluation engine
                        // that processes actions[] is built (none today — see doc 66 Phase 6).
                        enum: ['create_alert', 'assign', 'notify', 'escalate', 'block', 'create_report'],
                        required: true,
                    },
                    params: { type: Schema.Types.Mixed, default: {} },
                },
            ],
            // A rule with no actions is inert; firing an alert is what every
            // rule is for, so that is the default rather than [].
            default: () => [{ type: 'create_alert', params: {} }],
        },

        // ─────────────── Lifecycle ───────────────────────────────────────────
        status: {
            type: String,
            enum: ['draft', 'active', 'paused', 'archived'],
            default: 'active',
            index: true,
        },
        effectiveFrom: { type: Date, default: null },
        effectiveTo: { type: Date, default: null },

        // ─────────────── Telemetry ───────────────────────────────────────────
        lastFiredAt: { type: Date, default: null },
        hitCount: { type: Number, default: 0 },

        // ─────────────── Audit ───────────────────────────────────────────────
        createdBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        updatedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },

        // Soft delete — keep so historical alerts can still resolve their rule
        deletedAt: { type: Date, default: null, index: true },
    },
    {
        collection: 'ruleengines',
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

/**
 * Indexes — hot lookups for the engine
 */
// "Active transaction rules for client X"
RuleEngineSchema.index({ client: 1, appliesTo: 1, status: 1 });
// Effective-date filtering
RuleEngineSchema.index({ effectiveFrom: 1, effectiveTo: 1 });
// Tenant-scoped uniqueness for ruleId. Two tenants may reuse the same
// ruleId; one tenant cannot.
RuleEngineSchema.index({ client: 1, ruleId: 1 }, { unique: true });

/**
 * Hooks
 */
// Bump version when logic-affecting fields change.
const VERSIONED_PATHS = ['ruleCondition', 'logic', 'conditions', 'aggregation', 'actions'];

RuleEngineSchema.pre('save', function (next) {
    if (this.isNew) return next();
    const changed = VERSIONED_PATHS.filter((p) => this.isModified(p));
    if (changed.length) {
        this.version = (this.version || 1) + 1;
        this.$locals.changedPaths = changed;
    }
    next();
});

// Persist a snapshot of every version (first save and each bump). Best-effort:
// a history write must never fail the rule write itself.
const recordVersion = async (doc, changedPaths) => {
    if (!doc) return;
    try {
        const RuleEngineVersion = mongoose.model('RuleEngineVersion');
        await RuleEngineVersion.record(doc, { changedPaths });
    } catch (err) {
        console.error('[RuleEngine] version snapshot failed:', err.message);
    }
};

RuleEngineSchema.post('save', async function (doc) {
    const changed = doc.$locals.changedPaths || [];
    if (doc.version === 1 || changed.length) await recordVersion(doc, changed);
});

// Same logic for findOneAndUpdate / findByIdAndUpdate paths used by the
// existing controllers — `pre('save')` does not fire for those.
RuleEngineSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
    const update = this.getUpdate() || {};
    // Callers pass either { $set: {...} } or a bare { field: value } object
    // (updateRule does the latter). Mixing a bare field with $inc makes
    // Mongoose drop the operator, so normalise to an explicit $set first.
    // (Timestamps may already have added a $set with updatedAt, so merge —
    // don't only wrap when $set is absent.)
    const bare = {};
    for (const k of Object.keys(update)) {
        if (!k.startsWith('$')) { bare[k] = update[k]; delete update[k]; }
    }
    if (Object.keys(bare).length) update.$set = { ...(update.$set || {}), ...bare };
    const $set = update.$set || {};
    const touched = VERSIONED_PATHS.some((p) => Object.prototype.hasOwnProperty.call($set, p));
    if (touched) {
        update.$inc = { ...(update.$inc || {}), version: 1 };
        this.setUpdate(update);
        this.$locals = this.$locals || {};
        this.$locals.changedPaths = VERSIONED_PATHS.filter((p) => Object.prototype.hasOwnProperty.call($set, p));
    }
    next();
});

// findOneAndUpdate returns the doc -> snapshot it. updateOne/updateMany do not
// (the repair/migration scripts use those deliberately, no history wanted).
RuleEngineSchema.post('findOneAndUpdate', async function (doc) {
    const changed = (this.$locals && this.$locals.changedPaths) || [];
    if (!changed.length || !doc) return;
    // Callers without { new: true } receive the pre-update doc - re-read it
    const fresh = this.getOptions().new ? doc : await this.model.findById(doc._id);
    await recordVersion(fresh, changed);
});

/**
 * Virtual: is this rule currently in force?
 */
RuleEngineSchema.virtual('isInEffect').get(function () {
    if (this.status !== 'active') return false;
    if (this.deletedAt) return false;
    const now = Date.now();
    if (this.effectiveFrom && now < this.effectiveFrom.getTime()) return false;
    if (this.effectiveTo && now > this.effectiveTo.getTime()) return false;
    return true;
});

module.exports = mongoose.model('RuleEngine', RuleEngineSchema);
