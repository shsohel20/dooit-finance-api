// models/Workflow.js
//
// A Workflow is a DEFINITION — a template graph of typed compliance steps.
// It is not an execution. OnboardingJourney / OnboardingStep hold a customer's
// progress; nothing here has a customer, a status per step, or a clock.
//
// Shape and mechanics deliberately mirror models/RuleEngine.js: same tenancy
// rules, same lifecycle vocabulary, same version-snapshot hooks. A workflow
// orchestrates many steps; a rule evaluates one predicate. Siblings, not
// parent and child.

const mongoose = require('mongoose');

const { Schema } = mongoose;
const { ConditionLeafSchema } = require('./RuleEngine');

const NODE_TYPES = [
    'level',   // document / selfie / AML check
    'quest',   // questionnaire
    'cond',    // branch on data or labels
    'action',  // apply tags and risk labels
    'review',  // approve or reject
    'deleg',   // route to a team
    'hook',    // notify an external system
    'wait',    // hold for a period
    'mon',     // ongoing monitoring
    'report',  // SMR or threshold report
    'note',    // canvas annotation, not a step
];

const CATEGORIES = ['onboarding', 'screening', 'monitoring', 'investigation', 'reporting'];
const STATUSES = ['draft', 'pending_approval', 'active', 'paused', 'archived'];

// The paths whose change bumps `version`. A rename is not a logic change.
const VERSIONED_PATHS = ['nodes', 'edges', 'startNodeId'];

/** One branch of a condition node. `key` is what an edge's sourcePort names. */
const WorkflowBranchSchema = new Schema(
    {
        key: { type: String, required: true, trim: true },
        label: { type: String, required: true, trim: true },
        logic: { type: String, enum: ['AND', 'OR'], default: 'AND' },
        conditions: { type: [ConditionLeafSchema], default: [] },
    },
    { _id: false }
);

/** Presentation-only fields — what the canvas card renders. */
const WorkflowCardSchema = new Schema(
    {
        inset: { type: String, default: '' },       // highlighted line
        chips: { type: [String], default: [] },     // detail lines
        tagLabel: { type: String, default: '' },
        tags: {
            type: [
                {
                    _id: false,
                    text: { type: String, trim: true },
                    tone: { type: String, enum: ['warn', 'bad', 'plain'], default: 'plain' },
                },
            ],
            default: [],
        },
        decision: { type: String, default: '' },
        reason: { type: String, default: '' },
    },
    { _id: false }
);

/**
 * The auditable substance of a step.
 *
 * `fields` is deliberately free-form [{label, value}] for this slice — the
 * per-step-type shapes are still being discovered, and typing them early would
 * freeze guesses. Jurisdictional figures (thresholds, timers, retention) live
 * here as values, never as constants in code.
 */
const WorkflowConfigSchema = new Schema(
    {
        fields: {
            type: [{ _id: false, label: String, value: String }],
            default: [],
        },
        outcomes: {
            type: [{ _id: false, cond: String, then: String }],
            default: [],
        },
        owner: { type: String, default: '' },
        sla: { type: String, default: '' },
    },
    { _id: false }
);

const WorkflowNodeSchema = new Schema(
    {
        // Stable string id. NOT an ObjectId — edges reference it, and it must
        // survive a round-trip through React Flow's node array without
        // Mongoose minting a new id on every save.
        id: { type: String, required: true, trim: true },
        num: { type: String, default: '' },
        type: { type: String, enum: NODE_TYPES, required: true },
        title: { type: String, required: true, trim: true },
        purpose: { type: String, default: '' },
        position: {
            x: { type: Number, default: 0 },
            y: { type: Number, default: 0 },
        },
        card: { type: WorkflowCardSchema, default: () => ({}) },
        config: { type: WorkflowConfigSchema, default: () => ({}) },
        branches: { type: [WorkflowBranchSchema], default: [] },
        endOfFlow: { type: Boolean, default: false },
    },
    { _id: false }
);

const WorkflowEdgeSchema = new Schema(
    {
        from: { type: String, required: true, trim: true },
        to: { type: String, required: true, trim: true },
        // Branch key on the `from` node; '' for a node's single default output.
        sourcePort: { type: String, default: '' },
        label: { type: String, default: '' },
    },
    { _id: false }
);

const WorkflowSchema = new Schema(
    {
        // ─────────────── Tenant ──────────────────────────────────────────────
        // client === null      → system template (owned by dooit)
        // client === ObjectId  → client workflow
        client: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
        branch: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

        // Only meaningful when client === null. Only dooit may toggle it.
        visibleToClients: { type: Boolean, default: false, index: true },

        // ─────────────── Identity ────────────────────────────────────────────
        // Uniqueness is per tenant via { client, workflowId } below, not global.
        workflowId: { type: String, required: true, trim: true },
        name: { type: String, required: true, trim: true },
        description: { type: String, default: '' },

        // ─────────────── Classification ──────────────────────────────────────
        category: { type: String, enum: CATEGORIES, default: 'onboarding', index: true },
        appliesTo: { type: String, enum: ['individual', 'entity', 'both'], default: 'both', index: true },

        // ─────────────── Lifecycle ───────────────────────────────────────────
        status: { type: String, enum: STATUSES, default: 'draft', index: true },
        version: { type: Number, default: 1 },
        publishedAt: { type: Date, default: null },
        publishedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        approvedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        // Required on the transition to archived — enforced in the controller,
        // because an auditor will ask why a workflow stopped being used.
        archivedReason: { type: String, default: '' },

        // ─────────────── Graph ───────────────────────────────────────────────
        startNodeId: { type: String, default: '' },
        nodes: { type: [WorkflowNodeSchema], default: [] },
        edges: { type: [WorkflowEdgeSchema], default: [] },

        // ─────────────── Audit ───────────────────────────────────────────────
        createdBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        updatedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
        deletedAt: { type: Date, default: null, index: true },
    },
    {
        collection: 'workflows',
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    }
);

/** Indexes */
WorkflowSchema.index({ client: 1, workflowId: 1 }, { unique: true });
WorkflowSchema.index({ client: 1, category: 1, status: 1 });

/** Counts for the gallery, which never loads the graph itself. */
WorkflowSchema.virtual('nodeCount').get(function () {
    return (this.nodes || []).filter((n) => n.type !== 'note').length;
});
WorkflowSchema.virtual('conditionCount').get(function () {
    return (this.nodes || []).filter((n) => n.type === 'cond').length;
});

/** Hooks — bump the version when the graph changes. */
WorkflowSchema.pre('save', function (next) {
    if (this.isNew) return next();
    const changed = VERSIONED_PATHS.filter((p) => this.isModified(p));
    if (changed.length) {
        this.version = (this.version || 1) + 1;
        this.$locals.changedPaths = changed;
    }
    next();
});

// Best-effort: a history write must never fail the workflow write itself.
const recordVersion = async (doc, changedPaths) => {
    if (!doc) return;
    try {
        const WorkflowVersion = mongoose.model('WorkflowVersion');
        await WorkflowVersion.record(doc, { changedPaths });
    } catch (err) {
        console.error('[Workflow] version snapshot failed:', err.message);
    }
};

WorkflowSchema.post('save', async function (doc) {
    const changed = doc.$locals.changedPaths || [];
    if (doc.version === 1 || changed.length) await recordVersion(doc, changed);
});

// pre('save') does not fire for findOneAndUpdate paths, so mirror it.
WorkflowSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (next) {
    const update = this.getUpdate() || {};
    // Callers pass either { $set: {...} } or a bare { field: value }. Mixing a
    // bare field with $inc makes Mongoose drop the operator, so normalise to an
    // explicit $set first — merging, since timestamps may already have added one.
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
        this.$locals.changedPaths = VERSIONED_PATHS.filter(
            (p) => Object.prototype.hasOwnProperty.call($set, p)
        );
    }
    next();
});

WorkflowSchema.post('findOneAndUpdate', async function (doc) {
    const changed = (this.$locals && this.$locals.changedPaths) || [];
    if (!changed.length || !doc) return;
    await recordVersion(doc, changed);
});

module.exports = mongoose.model('Workflow', WorkflowSchema);
module.exports.VERSIONED_PATHS = VERSIONED_PATHS;
module.exports.NODE_TYPES = NODE_TYPES;
module.exports.CATEGORIES = CATEGORIES;
module.exports.STATUSES = STATUSES;
