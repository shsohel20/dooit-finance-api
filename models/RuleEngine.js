// models/RuleEngine.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Structured condition leaf
 * { field: "amount", operator: "gt", value: 10000 }
 * { field: "country", operator: "in", values: ["IR","KP"] }
 * { field: "amount", operator: "between", min: 1000, max: 5000 }
 */
const ConditionLeafSchema = new Schema(
    {
        field: { type: String, trim: true, required: true },
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
            // enum: ['Fraud', 'AML', 'Compliance', 'TF'],
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
            enum: ['Low', 'Medium', 'High', 'Critical', 'Info'],
            required: true,
        },

        // ─────────────── Versioning ──────────────────────────────────────────
        // Auditors need "show me the rule as it was when alert X fired".
        // Bump on every meaningful logic change; persist history elsewhere
        // (a RuleEngineVersion model) when you build it.
        version: { type: Number, default: 1 },

        // ─────────────── Target entity ───────────────────────────────────────
        appliesTo: {
            type: String,
            // enum: ['transaction', 'customer','kyb],
            default: 'transaction',
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
        },

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
            default: [],
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
    if (VERSIONED_PATHS.some((p) => this.isModified(p))) {
        this.version = (this.version || 1) + 1;
    }
    next();
});

// Same logic for findOneAndUpdate / findByIdAndUpdate paths used by the
// existing controllers — `pre('save')` does not fire for those.
RuleEngineSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
    const update = this.getUpdate() || {};
    const $set = update.$set || update;
    const touched = VERSIONED_PATHS.some((p) => Object.prototype.hasOwnProperty.call($set, p));
    if (touched) {
        update.$inc = { ...(update.$inc || {}), version: 1 };
        this.setUpdate(update);
    }
    next();
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
