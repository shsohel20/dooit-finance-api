// models/RuleEngineVersion.js
//
// Immutable history of a rule's logic. Auditors ask "show me the rule as it
// was when alert X fired" — Alert.ruleVersion points at RuleEngine.version,
// and this collection holds the snapshot for that number.
//
// Written automatically by RuleEngine's version-bump hooks (see RuleEngine.js
// `recordVersion`); never updated, never deleted by application code.

const mongoose = require('mongoose');

const { Schema } = mongoose;

// The paths whose change bumps RuleEngine.version — snapshot exactly these.
const SNAPSHOT_PATHS = [
    'ruleId', 'ruleName', 'ruleCondition', 'logic', 'conditions',
    'aggregation', 'actions', 'appliesTo', 'engine', 'caseType',
    'riskScore', 'riskLabel', 'status', 'effectiveFrom', 'effectiveTo',
];

const RuleEngineVersionSchema = new Schema(
    {
        rule: { type: Schema.Types.ObjectId, ref: 'RuleEngine', required: true, index: true },
        client: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
        ruleId: { type: String, trim: true, index: true },
        version: { type: Number, required: true },

        // Full copy of the logic-bearing fields at this version
        snapshot: { type: Schema.Types.Mixed, required: true },

        // Which paths differed from the previous version (empty on first record)
        changedPaths: { type: [String], default: [] },

        changedBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },
    },
    {
        collection: 'ruleengineversions',
        timestamps: { createdAt: true, updatedAt: false },
    }
);

// One record per (rule, version)
RuleEngineVersionSchema.index({ rule: 1, version: 1 }, { unique: true });

/** Pick the snapshot fields from a rule document/plain object. */
RuleEngineVersionSchema.statics.snapshotOf = function (rule) {
    const src = typeof rule.toObject === 'function' ? rule.toObject() : rule;
    const out = {};
    for (const p of SNAPSHOT_PATHS) if (src[p] !== undefined) out[p] = src[p];
    return out;
};

/**
 * Record `rule` at its current version. Idempotent — the unique index makes a
 * repeat call for the same (rule, version) a no-op instead of a duplicate.
 */
RuleEngineVersionSchema.statics.record = async function (rule, { changedPaths = [], changedBy = null } = {}) {
    if (!rule || rule.version == null) return null;
    try {
        return await this.create({
            rule: rule._id,
            client: rule.client || null,
            ruleId: rule.ruleId,
            version: rule.version,
            snapshot: this.snapshotOf(rule),
            changedPaths,
            changedBy: changedBy || rule.updatedBy || null,
        });
    } catch (err) {
        if (err && err.code === 11000) return null; // already recorded
        throw err;
    }
};

module.exports = mongoose.model('RuleEngineVersion', RuleEngineVersionSchema);
module.exports.SNAPSHOT_PATHS = SNAPSHOT_PATHS;
