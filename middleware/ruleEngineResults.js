// middleware/ruleEngineResults.js
//
// Pagination / filtering / sorting middleware for the RuleEngine list route.
//
// Access model:
//   dooit user   + ruleType=system  →  all system rules (client === null)
//   dooit user   + ruleType=client  →  all client rules (client !== null), read-only
//   dooit user   + no ruleType      →  all rules
//   client user  + ruleType=system  →  system rules visible to clients (visibleToClients=true)
//   client user  + ruleType=client  →  own rules only
//   client user  + no ruleType      →  own rules + visible system rules
//
// Supported query params:
//   ruleType           — "system" | "client"
//   search             — case-insensitive regex on ruleName, ruleId, descriptiveExplanation, mainDomain, ruleCondition
//   caseType           — exact: Fraud | AML | Compliance | TF
//   riskLabel          — exact: Low | Medium | High | Critical | Info
//   status             — exact: draft | active | paused | archived
//   appliesTo          — exact: transaction | customer | account
//   mainDomain         — exact match
//   ruleDomainSubdomain— exact match
//   riskScoreMin       — number (inclusive)
//   riskScoreMax       — number (inclusive)
//   sort               — field name (default: createdAt)
//   order              — "asc" | "desc" (default: desc)
//   page               — 1-based (default: 1)
//   limit              — per page, capped at 200 (default: 25)

const RuleEngine = require('../models/RuleEngine');
const ruleEvaluation = require('../services/ruleEvaluation');

const isDooit    = (u) => u?.userType === 'dooit';
const userTenant = (u) => ({
    client: u?.client?._id ?? u?.clientBelongs ?? null,
    branch: u?.branch?._id ?? u?.branchBelongs ?? null,
});

const SAFE_SORT_FIELDS = new Set([
    'ruleId', 'ruleName', 'caseType', 'riskLabel', 'riskScore',
    'mainDomain', 'ruleDomainSubdomain', 'status',
    'appliesTo', 'visibleToClients', 'createdAt', 'updatedAt', 'version',
]);

// Build the tenant-scope filter based on user role and requested tab.
const buildScopeFilter = (user, ruleType) => {
    if (isDooit(user)) {
        if (ruleType === 'system') return { client: null };
        if (ruleType === 'client') return { client: { $ne: null } };
        return {}; // all rules
    }

    const { client, branch } = userTenant(user);

    // Helper: branch-aware own-rules clause
    const ownRulesClauses = branch
        ? [
              { client, branch },
              { client, branch: null },
              { client, branch: { $exists: false } },
          ]
        : [{ client: client ?? null }];

    if (ruleType === 'system') {
        return { client: null, visibleToClients: true };
    }

    if (ruleType === 'client') {
        if (branch) {
            return {
                client: client ?? null,
                $or: [
                    { branch },
                    { branch: null },
                    { branch: { $exists: false } },
                ],
            };
        }
        return { client: client ?? null };
    }

    // Default: own rules + visible system rules
    return {
        $or: [
            ...ownRulesClauses,
            { client: null, visibleToClients: true },
        ],
    };
};

const ruleEngineResults = async (req, res, next) => {
    try {
        const ruleType = req.query.ruleType; // 'system' | 'client' | undefined

        // ── Tenant + tab scope ────────────────────────────────────────────
        const filter = buildScopeFilter(req.user, ruleType);

        // ── Text search ───────────────────────────────────────────────────
        if (req.query.search?.trim()) {
            const escaped = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(escaped, 'i');
            const searchClause = {
                $or: [
                    { ruleId:                 re },
                    { ruleName:               re },
                    { descriptiveExplanation: re },
                    { mainDomain:             re },
                    { ruleCondition:          re },
                ],
            };
            filter.$and = [...(filter.$and || []), searchClause];
        }

        // ── Field filters ─────────────────────────────────────────────────
        if (req.query.caseType)            filter.caseType            = req.query.caseType;
        if (req.query.riskLabel)           filter.riskLabel           = req.query.riskLabel;
        if (req.query.status)              filter.status              = req.query.status;
        if (req.query.appliesTo)           filter.appliesTo           = req.query.appliesTo;
        if (req.query.mainDomain)          filter.mainDomain          = req.query.mainDomain;
        if (req.query.ruleDomainSubdomain) filter.ruleDomainSubdomain = req.query.ruleDomainSubdomain;

        if (req.query.riskScoreMin || req.query.riskScoreMax) {
            filter.riskScore = {};
            if (req.query.riskScoreMin) filter.riskScore.$gte = Number(req.query.riskScoreMin);
            if (req.query.riskScoreMax) filter.riskScore.$lte = Number(req.query.riskScoreMax);
        }

        // ── Soft-delete guard ─────────────────────────────────────────────
        filter.deletedAt = null;

        // ── Pagination ────────────────────────────────────────────────────
        const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
        const skip  = (page - 1) * limit;

        // ── Sort ──────────────────────────────────────────────────────────
        const rawSort   = req.query.sort || 'createdAt';
        const sortField = SAFE_SORT_FIELDS.has(rawSort) ? rawSort : 'createdAt';
        const sortOrder = req.query.order === 'asc' ? 1 : -1;

        // ── Execute ───────────────────────────────────────────────────────
        const [totalRecords, data] = await Promise.all([
            RuleEngine.countDocuments(filter),
            RuleEngine.find(filter)
                .sort({ [sortField]: sortOrder })
                .skip(skip)
                .limit(limit)
                .populate('client', 'name')
                .populate('branch', 'name')
                .lean(),
        ]);

        const pagination = {};
        if (skip + limit < totalRecords) pagination.next = { page: page + 1, limit };
        if (skip > 0)                    pagination.prev = { page: page - 1, limit };

        // Can the evaluation engine execute this rule (logic tree, structured
        // conditions, or parseable DSL)? ~half the imported catalogue is
        // natural-language prose — the UI uses this to mark rules that can't
        // be backtested/evaluated.
        for (const row of data) {
            row.evaluable = !!ruleEvaluation.resolveExecutable(row);
        }

        res.advancedResults = {
            success:     true,
            totalRecords,
            totalPages:  Math.ceil(totalRecords / limit),
            currentPage: page,
            count:       data.length,
            pagination,
            data,
        };

        next();
    } catch (err) {
        next(err);
    }
};

module.exports = ruleEngineResults;
