// models/WorkflowVersion.js
//
// Immutable history of a workflow's graph. An auditor asks "show me the
// workflow as it was when this customer was onboarded" — Workflow.version
// names the number, and this collection holds the snapshot for it.
//
// Written automatically by Workflow's version-bump hooks; never updated,
// never deleted by application code.

const mongoose = require('mongoose');

const { Schema } = mongoose;

const SNAPSHOT_PATHS = [
    'name', 'description', 'category', 'appliesTo',
    'startNodeId', 'nodes', 'edges', 'status',
];

const WorkflowVersionSchema = new Schema(
    {
        workflow: { type: Schema.Types.ObjectId, ref: 'Workflow', required: true, index: true },
        client: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
        workflowId: { type: String, trim: true, index: true },
        version: { type: Number, required: true },

        snapshot: { type: Schema.Types.Mixed, required: true },
        changedPaths: { type: [String], default: [] },
        changedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
    },
    {
        collection: 'workflowversions',
        timestamps: { createdAt: true, updatedAt: false },
    }
);

// One record per (workflow, version) — this is what makes record() idempotent.
WorkflowVersionSchema.index({ workflow: 1, version: 1 }, { unique: true });

/** Pick the snapshot fields from a workflow document or plain object. */
WorkflowVersionSchema.statics.snapshotOf = function (workflow) {
    const src = typeof workflow.toObject === 'function' ? workflow.toObject() : workflow;
    const out = {};
    for (const p of SNAPSHOT_PATHS) if (src[p] !== undefined) out[p] = src[p];
    return out;
};

/**
 * Record `workflow` at its current version. Idempotent — the unique index
 * makes a repeat call for the same (workflow, version) a no-op.
 */
WorkflowVersionSchema.statics.record = async function (workflow, { changedPaths = [], changedBy = null } = {}) {
    if (!workflow || workflow.version == null) return null;
    try {
        return await this.create({
            workflow: workflow._id,
            client: workflow.client || null,
            workflowId: workflow.workflowId,
            version: workflow.version,
            snapshot: this.snapshotOf(workflow),
            changedPaths,
            changedBy: changedBy || workflow.updatedBy || null,
        });
    } catch (err) {
        if (err && err.code === 11000) return null; // already recorded
        throw err;
    }
};

module.exports = mongoose.model('WorkflowVersion', WorkflowVersionSchema);
module.exports.SNAPSHOT_PATHS = SNAPSHOT_PATHS;
