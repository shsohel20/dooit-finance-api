// controllers/ruleEngineController.js
//
// Renamed from `clientRuleController` — see models/RuleEngine.js for context.
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const RuleEngine = require("../models/RuleEngine");
const { Parser } = require("json2csv");
const { Readable } = require("stream");
const csv = require("csv-parser");

function bufferToStream(buffer) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}

// CSV column → schema field mapping
const CSV_HEADERS = {
    "Rule ID": "ruleId",
    "Rule Name": "ruleName",
    "Rule Condition (Logic Summary)": "ruleCondition",
    "Descriptive Explanation": "descriptiveExplanation",
    "Rule Domain_subdomain": "ruleDomainSubdomain",
    "main_domain": "mainDomain",
    "Case Type": "caseType",
    "Risk Score": "riskScore",
    "Risk Label": "riskLabel",
};

const VALID_CASE_TYPES = new Set(["Fraud", "AML", "Compliance", "TF"]);
const VALID_RISK_LABELS = new Set(["Low", "Medium", "High", "Critical", "Info"]);
const VALID_APPLIES_TO = new Set(["transaction", "customer", "account"]);
const VALID_STATUSES = new Set(["draft", "active", "paused", "archived"]);
const VALID_WINDOW_UNITS = new Set(["minute", "hour", "day"]);
const VALID_ACTION_TYPES = new Set(["create_alert", "assign", "notify", "escalate", "block"]);

// Safely JSON.parse a CSV cell. Returns the parsed value, or `undefined`
// when the cell is blank / unparseable. The caller decides whether a parse
// failure is fatal (we report it via the auto-fill log).
const tryParseJson = (raw) => {
    if (raw === null || raw === undefined) return undefined;
    const s = String(raw).trim();
    if (!s) return undefined;
    try { return JSON.parse(s); } catch { return null; }   // null = parse error sentinel
};

// Coerce a date-ish cell to a Date (or null when blank/invalid)
const tryParseDate = (raw) => {
    if (!raw) return null;
    const d = new Date(String(raw).trim());
    return isNaN(d.getTime()) ? null : d;
};

// ── DSL → structured conditions ──────────────────────────────────────────────
//
// Parse a rule-condition string back into the same shape the UI builder
// produces. Mirrors the inverse of `conditionToExpr` in
// `ui/.../RuleEditor.js`. Tolerant: returns `null` for anything we can't
// parse cleanly so the caller falls back to keeping the string only.
//
// Handles the operators the builder emits:
//   gt/gte/lt/lte/eq/ne, in/nin, between, contains, startsWith, endsWith,
//   exists, regex, and the common "=" alias for eq.

const stripQuotes = (s) => s.trim().replace(/^["'](.*)["']$/, '$1');

const coerceValue = (raw) => {
    const t = stripQuotes(String(raw));
    if (t === '') return t;
    // Strip thousand-separator commas (e.g. "1,000" → 1000, "50,000" → 50000)
    const stripped = t.replace(/,(?=\d{3}(\D|$))/g, '');
    if (/^-?\d+(\.\d+)?$/.test(stripped)) {
        const n = Number(stripped);
        if (Number.isFinite(n)) return n;
    }
    if (t.toLowerCase() === 'true') return true;
    if (t.toLowerCase() === 'false') return false;
    return t;
};

const splitList = (inner) =>
    inner.split(',').map((v) => coerceValue(v.trim())).filter((v) => v !== '');

// Match against a single expression (no AND/OR splitters). Order matters —
// longest/most-specific patterns first.
const LEAF_PATTERNS = [
    {
        re: /^(.+?)\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'between', min: coerceValue(m[2]), max: coerceValue(m[3]) })
    },
    {
        re: /^(.+?)\s+NOT\s+IN\s+\[(.*)\]$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'nin', values: splitList(m[2]) })
    },
    {
        re: /^(.+?)\s+IN\s+\[(.*)\]$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'in', values: splitList(m[2]) })
    },
    {
        re: /^(.+?)\s+STARTS\s+WITH\s+(.+)$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'startsWith', value: stripQuotes(m[2]) })
    },
    {
        re: /^(.+?)\s+ENDS\s+WITH\s+(.+)$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'endsWith', value: stripQuotes(m[2]) })
    },
    {
        re: /^(.+?)\s+CONTAINS\s+(.+)$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'contains', value: stripQuotes(m[2]) })
    },
    {
        re: /^(.+?)\s+MATCHES\s+\/(.+)\/$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'regex', value: m[2] })
    },
    {
        re: /^(.+?)\s+EXISTS$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'exists' })
    },
    {
        re: /^(.+?)\s*>=\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'gte', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*<=\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'lte', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*!=\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'ne', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*==\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'eq', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*>\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'gt', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*<\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'lt', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*=\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'eq', value: coerceValue(m[2]) })
    },
];

const parseLeaf = (expr) => {
    const trimmed = expr.trim();
    if (!trimmed) return null;
    for (const p of LEAF_PATTERNS) {
        const m = trimmed.match(p.re);
        if (m) return p.build(m);
    }
    return null;
};

// Split the DSL on top-level AND / OR, ignoring:
//   - the AND that is part of "BETWEEN x AND y"
//   - any AND/OR appearing inside [...] lists
// Returns [{ expr, combinator }] where the first row's combinator is 'AND'.
const splitTopLevel = (s) => {
    // Mask the AND inside BETWEEN first so it isn't a splitter
    let masked = s.replace(
        /(\bBETWEEN\b\s+\S+(?:\s+\S+)*?)\s+AND\s+/gi,
        '$1 @@BAND@@ '
    );
    // Mask AND/OR inside bracket lists
    masked = masked.replace(/\[([^\]]*)\]/g, (_, inner) =>
        '[' +
        inner
            .replace(/\bAND\b/gi, '@@LAND@@')
            .replace(/\bOR\b/gi, '@@LOR@@') +
        ']'
    );

    const parts = masked.split(/\s+(AND|OR)\s+/i);
    if (!parts.length) return [];

    const tokens = [];
    for (let i = 0; i < parts.length; i += 2) {
        const expr = parts[i]
            .replace(/@@BAND@@/g, 'AND')
            .replace(/@@LAND@@/g, 'AND')
            .replace(/@@LOR@@/g, 'OR')
            .trim();
        const combinator = i === 0 ? 'AND' : parts[i - 1].toUpperCase();
        if (expr) tokens.push({ expr, combinator });
    }
    return tokens;
};

// Build the logic tree from leaves with combinators (AND has precedence over OR)
// e.g. A AND B OR C  →  { logic: 'OR', children: [{ logic: 'AND', children: [A, B] }, C] }
const buildLogicTreeFromLeaves = (leaves) => {
    if (!leaves.length) return null;
    const stripCombinator = ({ combinator, ...rest }) => rest;
    if (leaves.length === 1) return stripCombinator(leaves[0]);

    const orGroups = [];
    let chunk = [stripCombinator(leaves[0])];
    for (let i = 1; i < leaves.length; i++) {
        if (leaves[i].combinator === 'OR') {
            orGroups.push(chunk);
            chunk = [stripCombinator(leaves[i])];
        } else {
            chunk.push(stripCombinator(leaves[i]));
        }
    }
    orGroups.push(chunk);

    const orChildren = orGroups.map((g) =>
        g.length === 1 ? g[0] : { logic: 'AND', children: g }
    );
    return orChildren.length === 1
        ? orChildren[0]
        : { logic: 'OR', children: orChildren };
};

// Top-level: parse a DSL string into { conditions, logic } or null if any
// part fails to parse (caller keeps just the string ruleCondition).
const parseRuleConditionDSL = (dsl) => {
    if (!dsl || typeof dsl !== 'string') return null;
    const tokens = splitTopLevel(dsl);
    if (!tokens.length) return null;

    const leaves = [];
    for (const t of tokens) {
        const leaf = parseLeaf(t.expr);
        if (!leaf) return null;        // bail on any unparseable expr
        leaves.push({ ...leaf, combinator: t.combinator });
    }
    if (!leaves.length) return null;

    const conditions = leaves.map(({ combinator, ...rest }) => rest);
    const logic = buildLogicTreeFromLeaves(leaves);
    return { conditions, logic };
};

// ── Import helpers ────────────────────────────────────────────────────────────

// Infer caseType from any available text when the column is blank/invalid.
// Priority: explicit column value → text signals → 'Fraud' fallback.
const inferCaseType = (raw, ...contextFields) => {
    if (VALID_CASE_TYPES.has(raw)) return raw;
    const text = contextFields.join(' ').toLowerCase();
    if (/terrorist|terrorism financ|\btf\b|proliferation/.test(text)) return 'TF';
    if (/\baml\b|anti.money|money launder|hawala|hundi|sanctions|watchlist/.test(text)) return 'AML';
    if (/\bcompliance\b|gdpr|app lawful|regulatory|data protect/.test(text)) return 'Compliance';
    return 'Fraud';
};

// score → canonical label
const scoreToLabel = (score) => {
    if (score >= 95) return 'Critical';
    if (score >= 75) return 'High';
    if (score >= 50) return 'Medium';
    if (score >= 25) return 'Low';
    return 'Info';
};

// canonical label → representative score (used when score is blank)
const LABEL_TO_SCORE = { Critical: 90, High: 75, Medium: 50, Low: 25, Info: 10 };

// True if the row looks like a repeated header or section divider, not a rule.
const isHeaderOrSection = (ruleId) => {
    if (!ruleId) return true;
    // Repeated column-header rows: "Rule ID"
    if (ruleId === 'Rule ID' || ruleId === 'Base Rule ID') return true;
    // Section-title rows: "B. LAYER 1: ...", "A.", etc.
    if (/^[A-Z]\.\s/.test(ruleId)) return true;
    // Combinatorial table headers (VEL:, DOR:, STR: etc.)
    if (/^[A-Z]{2,5}:/.test(ruleId)) return true;
    return false;
};

// Whitelist of fields callers may set/change. Anything else in req.body is
// dropped — prevents privilege escalation via mass-assignment (e.g. flipping
// `client` on someone else's rule, faking `hitCount`, etc.).
const WRITABLE_FIELDS = [
    "ruleId",
    "ruleName",
    "ruleCondition",
    "descriptiveExplanation",
    "ruleDomainSubdomain",
    "mainDomain",
    "caseType",
    "riskScore",
    "riskLabel",
    "appliesTo",
    "category",
    "status",
    "effectiveFrom",
    "effectiveTo",
    "logic",
    "conditions",
    "aggregation",
    "actions",
];

const pickWritable = (body = {}) => {
    const out = {};
    for (const k of WRITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
    }
    return out;
};

// Tenant resolution helpers ───────────────────────────────────────────────────
//
// - `dooit` users see every rule (platform admin)
// - everyone else is scoped to their own client; cross-tenant access returns
//   404 (not 403 — never leak existence)
const isDooit = (user) => user?.userType === "dooit";

const userTenant = (user) => ({
    client: user?.client?._id ?? user?.clientBelongs ?? null,
    branch: user?.branch?._id ?? user?.branchBelongs ?? null,
});

// tenantFilter — broad visibility filter used by export / domains endpoints.
//   dooit  : all rules
//   client : own rules + system rules that are visible to clients
const tenantFilter = (user) => {
    if (isDooit(user)) return {};
    const { client, branch } = userTenant(user);
    const ownClauses = branch
        ? [
              { client, branch },
              { client, branch: null },
              { client, branch: { $exists: false } },
          ]
        : [{ client: client ?? null }];
    return { $or: [...ownClauses, { client: null, visibleToClients: true }] };
};

// True if `doc` belongs to `user`'s tenant (or user is dooit).
// Rules:
//   1. Clients must match (always required).
//   2. Branch match only when BOTH the doc and the user have a branch — a
//      branch-scoped user cannot access another branch's rule, but a
//      client-level user (no branch) can access all branches within their client,
//      and a rule with no branch is accessible by any user in the client.
const sameTenant = (doc, user) => {
    if (isDooit(user)) return true;
    const { client, branch } = userTenant(user);
    if (!client) return false;

    // Resolve client id whether doc.client is populated or a raw ObjectId
    const docClientId = doc?.client?._id ?? doc?.client;
    if (docClientId?.toString?.() !== client.toString()) return false;

    // Branch sub-scoping: both sides must carry a branch for it to matter
    if (branch && doc?.branch) {
        const docBranchId = doc?.branch?._id ?? doc?.branch;
        return docBranchId?.toString?.() === branch.toString();
    }

    return true;
};

// canView — a user may read a rule when:
//   - they are dooit (sees everything), OR
//   - the rule is a system rule AND visibleToClients is true, OR
//   - the rule belongs to their own tenant
const canView = (doc, user) => {
    if (isDooit(user)) return true;
    const docClientId = doc?.client?._id ?? doc?.client;
    if (!docClientId) return !!doc.visibleToClients; // system rule: only if published
    return sameTenant(doc, user);
};

// canWrite — a user may create/update/delete a rule when:
//   - they are dooit AND the rule is a system rule (client === null)
//   - they are a client user AND the rule belongs to their own tenant
const canWrite = (doc, user) => {
    if (isDooit(user)) {
        const docClientId = doc?.client?._id ?? doc?.client;
        return !docClientId; // system rules only
    }
    return sameTenant(doc, user);
};

/**
 * Filter helper (used by advancedResults POST search)
 */
exports.filterRuleSection = (doc, requestBody) => {
    if (requestBody.ruleName) {
        return doc.ruleName
            ?.toLowerCase()
            .includes(requestBody.ruleName.toLowerCase());
    }
    return true;
};

// @desc    Get distinct mainDomain + ruleDomainSubdomain values for this tenant
// @route   GET /api/v1/rule-engine/domains
// @access  Private
exports.getRuleDomains = asyncHandler(async (req, res) => {
    const filter = { ...tenantFilter(req.user), deletedAt: null };

    const [mainDomains, subDomains] = await Promise.all([
        RuleEngine.distinct("mainDomain",        { ...filter, mainDomain:         { $ne: null, $ne: "" } }),
        RuleEngine.distinct("ruleDomainSubdomain",{ ...filter, ruleDomainSubdomain:{ $ne: null, $ne: "" } }),
    ]);

    res.status(200).json({
        success:     true,
        mainDomains: mainDomains.filter(Boolean).sort(),
        subDomains:  subDomains.filter(Boolean).sort(),
    });
});

// @desc    Get all rules
// @route   GET /api/v1/rule-engine
// @access  Private
exports.getRules = asyncHandler(async (req, res) => {
    res.status(200).json(res.advancedResults);
});

// @desc    Get all rules (POST filter)
// @route   POST /api/v1/rule-engine
// @access  Private
exports.getRulesPost = asyncHandler(async (req, res) => {
    res.status(200).json(res.advancedResults);
});

// @desc    Create rule
// @route   POST /api/v1/rule-engine/new
// @access  Private (tenant-scoped)
exports.createRule = asyncHandler(async (req, res, next) => {
    const { client, branch } = userTenant(req.user);

    if (!client && !isDooit(req.user)) {
        return next(new ErrorResponse("A tenant is required to create a rule", 400));
    }

    const payload = pickWritable(req.body);

    // Server-controlled fields — clients cannot set these directly
    payload.client = client;
    payload.branch = branch;
    payload.createdBy = req.user._id;
    payload.updatedBy = req.user._id;

    const rule = await RuleEngine.create(payload);

    res.status(201).json({ success: true, data: rule });
});

// @desc    Get single rule
// @route   GET /api/v1/rule-engine/:id
// @access  Private (tenant-scoped)
exports.getRule = asyncHandler(async (req, res, next) => {
    const rule = await RuleEngine.findById(req.params.id)
        .populate("client", "name")
        .populate("branch", "name")
        .populate("createdBy", "name email")
        .populate("updatedBy", "name email");

    if (!rule || !canView(rule, req.user)) {
        return next(
            new ErrorResponse(`Rule not found with id ${req.params.id}`, 404)
        );
    }

    res.status(200).json({ success: true, data: rule });
});

// @desc    Update rule
// @route   PUT /api/v1/rule-engine/:id
// @access  Private — dooit: system rules only; client: own rules only
exports.updateRule = asyncHandler(async (req, res, next) => {
    const existing = await RuleEngine.findById(req.params.id).select('client branch');
    if (!existing || !canWrite(existing, req.user)) {
        return next(new ErrorResponse(`Rule not found with id ${req.params.id}`, 404));
    }

    const update = pickWritable(req.body);
    update.updatedBy = req.user._id;

    const rule = await RuleEngine.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
    });

    res.status(200).json({ success: true, data: rule });
});

// @desc    Delete rule
// @route   DELETE /api/v1/rule-engine/:id
// @access  Private — dooit: system rules only; client: own rules only
exports.deleteRule = asyncHandler(async (req, res, next) => {
    const rule = await RuleEngine.findById(req.params.id).select('client branch');
    if (!rule || !canWrite(rule, req.user)) {
        return next(new ErrorResponse(`Rule not found with id ${req.params.id}`, 404));
    }

    await rule.deleteOne();

    res.status(200).json({ success: true, data: req.params.id });
});

// @desc    Toggle visibleToClients on a system rule
// @route   PATCH /api/v1/rule-engine/:id/visibility
// @access  Private — dooit only; system rules only
exports.toggleRuleVisibility = asyncHandler(async (req, res, next) => {
    if (!isDooit(req.user)) {
        return next(new ErrorResponse('Not authorized', 403));
    }

    const rule = await RuleEngine.findById(req.params.id).select('client visibleToClients');
    if (!rule) {
        return next(new ErrorResponse(`Rule not found with id ${req.params.id}`, 404));
    }

    const docClientId = rule?.client?._id ?? rule?.client;
    if (docClientId) {
        return next(new ErrorResponse('Visibility can only be set on system rules', 400));
    }

    const updated = await RuleEngine.findByIdAndUpdate(
        req.params.id,
        { visibleToClients: !rule.visibleToClients, updatedBy: req.user._id },
        { new: true }
    );

    res.status(200).json({ success: true, data: updated });
});

// @desc    Export rules as CSV
// @route   GET /api/v1/rule-engine/export
// @access  Private (tenant-scoped)
//
// Round-trippable export: nested fields (conditions, logic, aggregation,
// actions) are JSON-stringified into their own columns so a re-import can
// reconstruct them verbatim.
exports.exportRulesCsv = asyncHandler(async (req, res, next) => {
    const filter = tenantFilter(req.user);
    const rules = await RuleEngine.find(filter).lean();

    if (!rules.length) {
        return next(new ErrorResponse("No rules found to export", 404));
    }

    const stringifyOrEmpty = (v) =>
        v === null || v === undefined ||
            (Array.isArray(v) && v.length === 0) ||
            (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
            ? ''
            : JSON.stringify(v);

    const toIsoOrEmpty = (d) => (d ? new Date(d).toISOString() : '');

    const fields = [
        { label: "Rule ID", value: "ruleId" },
        { label: "Rule Name", value: "ruleName" },
        { label: "Rule Condition (Logic Summary)", value: "ruleCondition" },
        { label: "Descriptive Explanation", value: "descriptiveExplanation" },
        { label: "Rule Domain_subdomain", value: "ruleDomainSubdomain" },
        { label: "main_domain", value: "mainDomain" },
        { label: "Case Type", value: "caseType" },
        { label: "Risk Score", value: "riskScore" },
        { label: "Risk Label", value: "riskLabel" },
        { label: "Applies To", value: "appliesTo" },
        { label: "Category", value: "category" },
        { label: "Status", value: "status" },
        { label: "Version", value: "version" },
        { label: "Effective From", value: (row) => toIsoOrEmpty(row.effectiveFrom) },
        { label: "Effective To", value: (row) => toIsoOrEmpty(row.effectiveTo) },
        { label: "Conditions JSON", value: (row) => stringifyOrEmpty(row.conditions) },
        { label: "Logic JSON", value: (row) => stringifyOrEmpty(row.logic) },
        { label: "Aggregation JSON", value: (row) => stringifyOrEmpty(row.aggregation) },
        { label: "Actions JSON", value: (row) => stringifyOrEmpty(row.actions) },
    ];

    const parser = new Parser({ fields });
    const csvData = parser.parse(rules);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="rule-engine.csv"');
    return res.send(csvData);
});

// @desc    Import rules from CSV
// @route   POST /api/v1/rule-engine/import
// @access  Private (tenant-scoped)
//
// Resilient import — rows with missing caseType / riskScore / riskLabel are
// NOT rejected; instead those fields are inferred from available context.
// Rows that are genuinely non-rule data (section headers, repeated column
// headers, keyword library entries with no ruleCondition) are skipped and
// reported separately.
//
// Round-trips with the export above. Recognised columns:
//   Identity:       Rule ID, Rule Name
//   DSL:            Rule Condition (Logic Summary) | Rule Condition
//   Description:    Descriptive Explanation | Description
//   Taxonomy:       Rule Domain_subdomain, main_domain, Category
//   Classification: Case Type, Risk Score, Risk Label
//   Lifecycle:      Applies To, Status, Effective From, Effective To
//   Structured:     Conditions JSON, Logic JSON, Aggregation JSON, Actions JSON
// JSON columns are JSON.parse'd; an unparseable cell is reported in the
// auto-fill log and the field falls back to its default (logic=null, etc.).
exports.importRulesCsv = asyncHandler(async (req, res, next) => {
    if (!req.file) {
        return next(new ErrorResponse("CSV file is required", 400));
    }

    const { client, branch } = userTenant(req.user);
    if (!client && !isDooit(req.user)) {
        return next(new ErrorResponse("A tenant is required to import rules", 400));
    }

    const rows = [];
    const skipped = [];
    const autoFills = []; // rows that needed at least one field inferred

    await new Promise((resolve, reject) => {
        bufferToStream(req.file.buffer)
            .pipe(csv())
            .on("data", (row) => {
                // ── 1. Extract rule ID (hard requirement) ──────────────────
                const ruleId = (
                    row["Rule ID"] || row["Base Rule ID"] || ""
                ).trim();

                // Skip section headers, repeated column-header rows, empty rows
                if (isHeaderOrSection(ruleId)) return;

                // ── 2. Core identity fields ────────────────────────────────
                const ruleName = (row["Rule Name"] || "").trim();
                // Accept both column name variants found in the CSV
                const ruleCondition = (
                    row["Rule Condition (Logic Summary)"] ||
                    row["Rule Condition"] ||
                    ""
                ).trim();

                if (!ruleName) {
                    skipped.push({ ruleId, reason: "Missing ruleName" });
                    return;
                }
                if (!ruleCondition) {
                    skipped.push({ ruleId, reason: "Missing ruleCondition — likely a keyword/section entry" });
                    return;
                }

                // ── 3. Optional descriptive fields ────────────────────────
                const descriptiveExplanation = (
                    row["Descriptive Explanation"] || row["Description"] || ""
                ).trim();
                const ruleDomainSubdomain = (row["Rule Domain_subdomain"] || "").trim();
                const mainDomain = (row["main_domain"] || "").trim();

                // ── 4. caseType — infer if blank/invalid ──────────────────
                const rawCaseType = (row["Case Type"] || "").trim();
                let caseType;
                const fills = [];

                if (VALID_CASE_TYPES.has(rawCaseType)) {
                    caseType = rawCaseType;
                } else {
                    caseType = inferCaseType(
                        rawCaseType,
                        ruleName, ruleCondition, descriptiveExplanation,
                        ruleDomainSubdomain, mainDomain
                    );
                    fills.push(
                        rawCaseType
                            ? `caseType "${rawCaseType}" → "${caseType}"`
                            : `caseType defaulted to "${caseType}"`
                    );
                }

                // ── 5. riskScore / riskLabel — cross-populate if one is blank ──
                const rawScore = (row["Risk Score"] || "").toString().trim();
                const rawLabel = (row["Risk Label"] || "").toString().trim();

                const numScore = Number(rawScore);
                const scoreValid = rawScore !== "" && !isNaN(numScore) && numScore >= 0 && numScore <= 100;
                const labelValid = VALID_RISK_LABELS.has(rawLabel);

                let riskScore, riskLabel;

                if (scoreValid && labelValid) {
                    // Both present and valid — use as-is
                    riskScore = numScore;
                    riskLabel = rawLabel;
                } else if (scoreValid) {
                    // Score present, label missing — derive label from score
                    riskScore = numScore;
                    riskLabel = scoreToLabel(numScore);
                    fills.push(`riskLabel inferred as "${riskLabel}" from score ${numScore}`);
                } else if (labelValid) {
                    // Label present, score missing — derive score from label
                    riskLabel = rawLabel;
                    riskScore = LABEL_TO_SCORE[rawLabel];
                    fills.push(`riskScore defaulted to ${riskScore} from label "${rawLabel}"`);
                } else {
                    // Both missing — set safe defaults
                    riskScore = 50;
                    riskLabel = "Medium";
                    fills.push("riskScore/riskLabel defaulted to 50 / Medium");
                }

                // ── 6. Lifecycle / classification extras ─────────────────
                const rawAppliesTo = (row["Applies To"] || "").trim().toLowerCase();
                const appliesTo = VALID_APPLIES_TO.has(rawAppliesTo) ? rawAppliesTo : "transaction";

                const rawStatus = (row["Status"] || "").trim().toLowerCase();
                const status = VALID_STATUSES.has(rawStatus) ? rawStatus : "active";

                const category = (row["Category"] || "").trim() || undefined;

                const effectiveFrom = tryParseDate(row["Effective From"]);
                const effectiveTo = tryParseDate(row["Effective To"]);

                // ── 8. conditions + logic ─────────────────────────────────
                // Priority 1 — always try to parse the DSL string in
                // ruleCondition. This is the primary source for Rule_Book CSVs.
                let conditions;
                let logic = null;

                const dslParsed = parseRuleConditionDSL(ruleCondition);

                console.log(dslParsed)

                if (dslParsed) {
                    conditions = dslParsed.conditions;
                    logic = dslParsed.logic;
                    fills.push(`conditions/logic parsed from ruleCondition (${dslParsed.conditions.length} leaf${dslParsed.conditions.length === 1 ? '' : 's'})`);
                }

                // Priority 2 — JSON columns (present on our own exports) override
                // the DSL-derived values when the column is non-empty.
                const condJson = tryParseJson(row["Conditions JSON"]);
                if (condJson === null) {
                    fills.push("Conditions JSON unparseable — ignored");
                } else if (Array.isArray(condJson) && condJson.length) {
                    conditions = condJson;
                }

                const logicJson = tryParseJson(row["Logic JSON"]);
                if (logicJson === null) {
                    fills.push("Logic JSON unparseable — ignored");
                } else if (logicJson && typeof logicJson === 'object') {
                    logic = logicJson;
                }

                // aggregation: { window: { value, unit }, count, sumThreshold }
                const aggJson = tryParseJson(row["Aggregation JSON"]);
                let aggregation;
                if (aggJson === null) {
                    fills.push("Aggregation JSON unparseable — dropped");
                } else if (aggJson && typeof aggJson === 'object') {
                    // Sanitize window.unit
                    if (aggJson.window?.unit && !VALID_WINDOW_UNITS.has(aggJson.window.unit)) {
                        aggJson.window.unit = 'minute';
                        fills.push('aggregation.window.unit defaulted to "minute"');
                    }
                    aggregation = aggJson;
                }

                // actions: array of { type, params }
                const actJson = tryParseJson(row["Actions JSON"]);
                let actions = [];
                if (actJson === null) {
                    fills.push("Actions JSON unparseable — dropped");
                } else if (Array.isArray(actJson)) {
                    actions = actJson
                        .filter((a) => a && VALID_ACTION_TYPES.has(a.type))
                        .map((a) => ({ type: a.type, params: a.params || {} }));
                }

                // ── 9. Collect auto-fill report ───────────────────────────
                if (fills.length) autoFills.push({ ruleId, fills });

                const doc = {
                    ruleId,
                    ruleName,
                    ruleCondition,
                    descriptiveExplanation,
                    ruleDomainSubdomain,
                    mainDomain,
                    caseType,
                    riskScore,
                    riskLabel,
                    appliesTo,
                    status,
                    effectiveFrom,
                    effectiveTo,
                    actions,
                    client,
                    branch,
                    createdBy: req.user._id,
                    updatedBy: req.user._id,
                };
                if (category) doc.category = category;
                if (conditions) doc.conditions = conditions;
                if (logic) doc.logic = logic;
                if (aggregation) doc.aggregation = aggregation;

                rows.push(doc);
            })
            .on("end", resolve)
            .on("error", reject);
    });

    if (!rows.length) {
        return next(new ErrorResponse("No valid rule rows found in CSV", 400));
    }

    // Upsert per tenant — a second tenant importing the same ruleId must NOT
    // overwrite the first tenant's document.
    const bulkOps = rows.map((rule) => ({
        updateOne: {
            filter: { client: rule.client ?? null, ruleId: rule.ruleId },
            update: { $set: rule },
            upsert: true,
        },
    }));

    const result = await RuleEngine.bulkWrite(bulkOps, { ordered: false });

    res.status(200).json({
        success: true,
        inserted: result.upsertedCount,
        updated: result.modifiedCount,
        total: rows.length,
        skipped: skipped.length,
        autoFilled: autoFills.length,
        skippedDetails: skipped,
        autoFilledDetails: autoFills,
    });
});
