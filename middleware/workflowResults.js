// middleware/workflowResults.js
//
// Pagination / filtering / sorting for the Workflow list route.
//
// Access model — identical to middleware/ruleEngineResults.js:
//   dooit user  + workflowType=system  →  all system workflows (client === null)
//   dooit user  + workflowType=client  →  all client workflows, read-only
//   dooit user  + no type              →  all workflows
//   client user + workflowType=system  →  system workflows with visibleToClients
//   client user + workflowType=client  →  own workflows only
//   client user + no type              →  own + visible system workflows
//
// The list never returns nodes/edges — the gallery needs counts, not graphs.

const Workflow = require('../models/Workflow');

const isDooit = (u) => u?.userType === 'dooit';
const userTenant = (u) => ({
    client: u?.client?._id ?? u?.clientBelongs ?? null,
    branch: u?.branch?._id ?? u?.branchBelongs ?? null,
});

const SAFE_SORT_FIELDS = new Set([
    'workflowId', 'name', 'category', 'appliesTo', 'status',
    'visibleToClients', 'createdAt', 'updatedAt', 'version',
]);

const buildScopeFilter = (user, workflowType) => {
    if (isDooit(user)) {
        if (workflowType === 'system') return { client: null };
        if (workflowType === 'client') return { client: { $ne: null } };
        return {};
    }

    const { client, branch } = userTenant(user);

    // Branch-aware own-workflow clauses — mirrors ruleEngineResults.js.
    const ownClauses = branch
        ? [
              { client, branch },
              { client, branch: null },
              { client, branch: { $exists: false } },
          ]
        : [{ client: client ?? null }];

    if (workflowType === 'system') return { client: null, visibleToClients: true };

    if (workflowType === 'client') {
        if (branch) {
            return {
                client: client ?? null,
                $or: [{ branch }, { branch: null }, { branch: { $exists: false } }],
            };
        }
        return { client: client ?? null };
    }

    // No tab selected: own workflows (branch-scoped) plus the system
    // templates made visible.
    return { $or: [...ownClauses, { client: null, visibleToClients: true }] };
};

const workflowResults = async (req, res, next) => {
    try {
        const q = req.query || {};
        const filter = { deletedAt: null, ...buildScopeFilter(req.user, q.workflowType) };

        if (q.search) {
            const escaped = String(q.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(escaped, 'i');
            filter.$and = [
                ...(filter.$and || []),
                { $or: [{ name: rx }, { workflowId: rx }, { description: rx }] },
            ];
        }
        if (q.category) filter.category = q.category;
        if (q.status) filter.status = q.status;
        if (q.appliesTo) filter.appliesTo = q.appliesTo;

        const sortField = SAFE_SORT_FIELDS.has(q.sort) ? q.sort : 'createdAt';
        const sortOrder = q.order === 'asc' ? 1 : -1;

        const page = Math.max(1, parseInt(q.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 25));

        const [total, docs] = await Promise.all([
            Workflow.countDocuments(filter),
            Workflow.find(filter)
                .sort({ [sortField]: sortOrder })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
        ]);

        res.workflowResults = {
            success: true,
            count: docs.length,
            total,
            page,
            pages: Math.ceil(total / limit) || 1,
            data: docs.map(({ nodes, edges, ...rest }) => ({
                ...rest,
                nodeCount: (nodes || []).filter((n) => n.type !== 'note').length,
                conditionCount: (nodes || []).filter((n) => n.type === 'cond').length,
            })),
        };
        next();
    } catch (err) {
        next(err);
    }
};

module.exports = workflowResults;
module.exports.buildScopeFilter = buildScopeFilter;
