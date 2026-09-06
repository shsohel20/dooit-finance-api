// controllers/ruleEngineController.js
//
// Renamed from `clientRuleController` — see models/RuleEngine.js for context.
const mongoose = require("mongoose");
const { isDeepStrictEqual } = require("util");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const RuleEngine = require("../models/RuleEngine");
const Transaction = require("../models/Transaction");
const ruleEvaluation = require("../services/ruleEvaluation");
const { Parser } = require("json2csv");
const { Readable } = require("stream");
const csv = require("csv-parser");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");

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
const VALID_APPLIES_TO = new Set(["transaction", "customer"]);
const VALID_ENGINES = new Set(["predicate", "aggregate", "screening", "manual"]);
const VALID_GROUP_BY = new Set(["customer", "sender", "beneficiary"]);
const VALID_DEDUPE_BY = new Set(["rule_customer_txn", "rule_customer_day"]);
const VALID_STATUSES = new Set(["draft", "active", "paused", "archived"]);
const VALID_WINDOW_UNITS = new Set(["minute", "hour", "day"]);
const VALID_ACTION_TYPES = new Set(["create_alert", "assign", "notify", "escalate", "block", "create_report"]);

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
// Extracted to utils/ruleConditionParser.js so services/ruleEvaluation can
// share it without a circular require.
const { parseRuleConditionDSL } = require("../utils/ruleConditionParser");

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
    "engine",
    "category",
    "status",
    "dedupeBy",
    "cooldownMinutes",
    "slaHours",
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

// @desc    Get distinct mainDomain / ruleDomainSubdomain / category values for
//          this tenant — feeds the filter + creatable dropdowns in the UI
// @route   GET /api/v1/rule-engine/domains
// @access  Private
exports.getRuleDomains = asyncHandler(async (req, res) => {
    const filter = { ...tenantFilter(req.user), deletedAt: null };
    const nonEmpty = { $nin: [null, ""] };

    const [mainDomains, subDomains, categories] = await Promise.all([
        RuleEngine.distinct("mainDomain",          { ...filter, mainDomain:          nonEmpty }),
        RuleEngine.distinct("ruleDomainSubdomain", { ...filter, ruleDomainSubdomain: nonEmpty }),
        RuleEngine.distinct("category",            { ...filter, category:            nonEmpty }),
    ]);

    res.status(200).json({
        success:     true,
        mainDomains: mainDomains.filter(Boolean).sort(),
        subDomains:  subDomains.filter(Boolean).sort(),
        categories:  categories.filter(Boolean).sort(),
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

    logEvent({
        req,
        service: "rule",
        action: "rule_created",
        target: rule.ruleId || String(rule._id),
        afterValue: { name: rule.ruleName, ruleId: rule.ruleId, status: rule.status },
    });

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

    // Same flag the list middleware attaches — can the engine execute this rule?
    const data = rule.toObject();
    data.evaluable = !!ruleEvaluation.resolveExecutable(data);

    res.status(200).json({ success: true, data });
});

// @desc    Update rule
// @route   PUT /api/v1/rule-engine/:id
// @access  Private — dooit: system rules only; client: own rules only
exports.updateRule = asyncHandler(async (req, res, next) => {
    const existing = await RuleEngine.findById(req.params.id)
        .select('client branch status ruleCondition logic conditions aggregation actions');
    if (!existing || !canWrite(existing, req.user)) {
        return next(new ErrorResponse(`Rule not found with id ${req.params.id}`, 404));
    }

    const update = pickWritable(req.body);

    // The UI resends logic-bearing fields on every save; drop the ones that
    // are unchanged so the model's version hook only bumps on real logic
    // changes (auditors rely on version as a "logic changed" signal).
    const existingObj = existing.toObject();
    const normalize = (v) => JSON.parse(JSON.stringify(v ?? null));
    for (const key of ["ruleCondition", "logic", "conditions", "aggregation", "actions"]) {
        if (key in update && isDeepStrictEqual(normalize(update[key]), normalize(existingObj[key]))) {
            delete update[key];
        }
    }

    update.updatedBy = req.user._id;

    const rule = await RuleEngine.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
    });

    // Audit — large structures (conditions/logic/actions) are summarised as a
    // changed-keys list; status is recorded explicitly before/after.
    const auditedKeys = ["conditions", "logic", "actions", "status", "effectiveFrom", "effectiveTo"];
    const changed = auditedKeys.filter((k) => update[k] !== undefined);
    if (changed.length) {
        logEvent({
            req,
            service: "rule",
            action: "rule_updated",
            target: rule.ruleId || String(rule._id),
            beforeValue: { changed, status: existing.status },
            afterValue: { changed, status: rule.status },
        });
    }

    res.status(200).json({ success: true, data: rule });
});

// @desc    Delete rule
// @route   DELETE /api/v1/rule-engine/:id
// @access  Private — dooit: system rules only; client: own rules only
exports.deleteRule = asyncHandler(async (req, res, next) => {
    const rule = await RuleEngine.findById(req.params.id).select('client branch ruleId ruleName status');
    if (!rule || !canWrite(rule, req.user)) {
        return next(new ErrorResponse(`Rule not found with id ${req.params.id}`, 404));
    }

    // Hard delete — snapshot identifying fields before the doc is gone
    const beforeValue = { ruleId: rule.ruleId, name: rule.ruleName, status: rule.status };

    await rule.deleteOne();

    logEvent({
        req,
        service: "rule",
        action: "rule_deleted",
        target: rule.ruleId || String(rule._id),
        beforeValue,
    });

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

    logEvent({
        req,
        service: "rule",
        action: "rule_visibility_changed",
        target: updated.ruleId || String(updated._id),
        beforeValue: { visibleToClients: rule.visibleToClients },
        afterValue: { visibleToClients: updated.visibleToClients },
    });
    recordDevice({ req, purpose: "admin_action" });

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
        { label: "Engine", value: "engine" },
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
                    if (aggJson.groupBy && !VALID_GROUP_BY.has(aggJson.groupBy)) {
                        aggJson.groupBy = 'customer';
                        fills.push('aggregation.groupBy defaulted to "customer"');
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
                // A rule with no actions can never produce anything — fall back
                // to the schema default so imported rules fire alerts.
                if (!actions.length) {
                    actions = [{ type: "create_alert", params: {} }];
                    fills.push('actions defaulted to [create_alert]');
                }

                // engine: how the rule evaluates (schema default 'predicate';
                // 'aggregate' is implied whenever an aggregation window is given)
                const rawEngine = (row["Engine"] || "").trim().toLowerCase();
                let engine = VALID_ENGINES.has(rawEngine) ? rawEngine : "predicate";
                if (engine === "predicate" && aggregation && (aggregation.count || aggregation.sumThreshold)) {
                    engine = "aggregate";
                    fills.push('engine set to "aggregate" (aggregation present)');
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
                    engine,
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

    logEvent({
        req,
        service: "rule",
        action: "rule_import",
        afterValue: {
            created: result.upsertedCount,
            updated: result.modifiedCount,
            skipped: skipped.length,
            autoFills: autoFills.length,
        },
    });

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

// ── Backtest ──────────────────────────────────────────────────────────────────

// Hard cap on how many transactions a single backtest run will evaluate.
// The response reports `truncated: true` when the range holds more.
const BACKTEST_MAX_SCAN = 20000;
const BACKTEST_DEFAULT_DAYS = 90;
// Widest window a single run may cover — bounds the zero-filled per-day
// series (one entry per day) and keeps a typo'd "from" year from producing
// a decades-long scan.
const BACKTEST_MAX_RANGE_DAYS = 731;

// Minimal customer projection the evaluator's customer.* aliases read.
const BACKTEST_CUSTOMER_SELECT = "isPep sanction amlStatus kycStatus country status given_name surname";
const BACKTEST_PARTY_PATHS = ["sender", "receiver", "beneficiary", "intermediary"];

// @desc    Backtest a rule against historical transactions (read-only —
//          creates no alerts, bumps no telemetry)
// @route   POST /api/v1/rule-engine/backtest
// @access  Private (tenant-scoped)
//
// Body:
//   ruleId       — Mongo _id of a saved rule (must pass canView), OR
//   rule         — inline draft {conditions|logic|ruleCondition, aggregation, …}
//   from / to    — ISO dates; default: last 90 days ending now
//   sampleLimit  — max matched samples returned (1–100, default 25)
//   clientId     — dooit only: narrow the transaction pool to one client
exports.backtestRule = asyncHandler(async (req, res, next) => {
    const { ruleId, rule: inlineRule, from, to, sampleLimit, clientId } = req.body || {};

    // Same guard as createRule — a client user without a resolved tenant must
    // never fall through to an unscoped (all-tenants) transaction query.
    const { client, branch } = userTenant(req.user);
    if (!client && !isDooit(req.user)) {
        return next(new ErrorResponse("A tenant is required to run a backtest", 400));
    }

    // ── 1. Resolve the rule under test ────────────────────────────────────
    let rule;
    if (ruleId) {
        const doc = await RuleEngine.findById(ruleId).lean();
        if (!doc || !canView(doc, req.user)) {
            return next(new ErrorResponse(`Rule not found with id ${ruleId}`, 404));
        }
        rule = doc;
    } else if (inlineRule && typeof inlineRule === "object") {
        rule = pickWritable(inlineRule);
    } else {
        return next(new ErrorResponse("Provide ruleId or an inline rule to backtest", 400));
    }

    const executable = ruleEvaluation.resolveExecutable(rule);
    if (!executable) {
        return next(
            new ErrorResponse(
                "Rule has no evaluable logic — no logic tree, no structured conditions, and its DSL string could not be parsed",
                422
            )
        );
    }

    // ── 2. Date window ────────────────────────────────────────────────────
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from
        ? new Date(from)
        : new Date(toDate.getTime() - BACKTEST_DEFAULT_DAYS * 86400e3);
    if (isNaN(toDate) || isNaN(fromDate)) {
        return next(new ErrorResponse("Invalid from/to date", 400));
    }
    if (fromDate >= toDate) {
        return next(new ErrorResponse("`from` must be before `to`", 400));
    }
    if (toDate - fromDate > BACKTEST_MAX_RANGE_DAYS * 86400e3) {
        return next(
            new ErrorResponse(`Date range too wide — maximum ${BACKTEST_MAX_RANGE_DAYS} days per run`, 400)
        );
    }

    // ── 3. Tenant-scoped transaction pool ─────────────────────────────────
    // Mirrors transactionController.buildTxFilter tenancy.
    const txFilter = { timestamp: { $gte: fromDate, $lte: toDate } };
    if (client) {
        txFilter.client = client;
    } else if (isDooit(req.user) && clientId) {
        if (!mongoose.isValidObjectId(clientId)) {
            return next(new ErrorResponse("Invalid clientId", 400));
        }
        txFilter.client = clientId;
    }
    if (branch) txFilter.branch = branch;

    const totalInRange = await Transaction.countDocuments(txFilter);

    // Autopopulate is disabled and replaced with a minimal projection —
    // the evaluator only reads a handful of customer flags.
    const cursor = Transaction.find(txFilter)
        .sort({ timestamp: 1 })
        .limit(BACKTEST_MAX_SCAN)
        .setOptions({ autopopulate: false })
        .populate(
            BACKTEST_PARTY_PATHS.map((p) => ({
                path: `${p}.customer`,
                select: BACKTEST_CUSTOMER_SELECT,
            }))
        )
        .lean()
        .cursor();

    // ── 4. Streamed evaluation ────────────────────────────────────────────
    const limit = Math.min(Math.max(Number(sampleLimit) || 25, 1), 100);
    const perDay = new Map();      // 'YYYY-MM-DD' → {evaluated, matched}
    const fieldMissCounts = new Map();
    const uniqueSubjects = new Set();
    const matchedRows = [];        // slim rows for aggregation windows
    const sample = [];
    let scanned = 0;
    let matchedCount = 0;
    let matchedAmount = 0;
    let lastScannedTs = null;      // cursor is sorted asc → ends at the max

    for await (const txn of cursor) {
        scanned++;
        const tsRaw = new Date(txn.timestamp || txn.createdAt || 0);
        if (!isNaN(tsRaw)) lastScannedTs = tsRaw;
        const dayKey = (isNaN(tsRaw) ? new Date(0) : tsRaw).toISOString().slice(0, 10);
        let day = perDay.get(dayKey);
        if (!day) { day = { evaluated: 0, matched: 0 }; perDay.set(dayKey, day); }
        day.evaluated++;

        // Customer rules resolve their fields on the customer, not the txn
        const result = ruleEvaluation.evaluateTree(executable.tree, txn, { subject: rule.appliesTo });
        for (const f of result.fieldMisses) {
            fieldMissCounts.set(f, (fieldMissCounts.get(f) || 0) + 1);
        }
        if (!result.matched) continue;

        matchedCount++;
        day.matched++;
        const amount = Number(ruleEvaluation.effectiveAmount(txn)) || 0;
        matchedAmount += amount;
        const subject = ruleEvaluation.subjectKey(txn);
        uniqueSubjects.add(subject);
        matchedRows.push({ id: txn._id, ts: txn.timestamp || txn.createdAt, subject, amount });

        if (sample.length < limit) {
            sample.push({
                id: String(txn._id),
                uid: txn.uid || txn.reference || null,
                timestamp: txn.timestamp || txn.createdAt,
                type: txn.type,
                channel: txn.channel || null,
                status: txn.status,
                amount: txn.amount,
                currency: txn.currency,
                convertedAmountAUD: txn.convertedAmountAUD ?? null,
                senderName: txn.sender?.name || null,
                receiverName: txn.receiver?.name || null,
                leaves: result.leaves,
            });
        }
    }

    // ── 5. Aggregation windows (velocity rules) ───────────────────────────
    const aggregated = ruleEvaluation.hasAggregation(rule);
    let aggregation = null;
    if (aggregated) {
        const { windows, firedWindows, firedTxnIds } = ruleEvaluation.applyAggregation(
            rule.aggregation,
            matchedRows
        );
        aggregation = {
            window: rule.aggregation.window || null,
            count: rule.aggregation.count ?? null,
            sumThreshold: rule.aggregation.sumThreshold ?? null,
            windowsEvaluated: windows.length,
            windowsFired: firedWindows.length,
            txnsInFiredWindows: firedTxnIds.size,
            firedWindows: firedWindows.slice(0, limit).map((w) => ({
                subject: w.subject,
                windowStart: w.windowStart,
                count: w.count,
                sum: w.sum,
            })),
        };
        for (const s of sample) s.inFiredWindow = firedTxnIds.has(s.id);
    }

    // Would-be alert volume: one per fired window for velocity rules,
    // one per matched transaction otherwise (doc 72 §5.2: alert per fired rule).
    const wouldFireAlerts = aggregated ? aggregation.windowsFired : matchedCount;

    // ── 6. Daily series — zero-filled so the chart shows true gaps ────────
    const series = [];
    for (let t = Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate());
         t <= toDate.getTime();
         t += 86400e3) {
        const key = new Date(t).toISOString().slice(0, 10);
        const d = perDay.get(key);
        series.push({ date: key, evaluated: d?.evaluated || 0, matched: d?.matched || 0 });
    }

    const rangeDays = Math.max(1, (toDate - fromDate) / 86400e3);

    // When the scan hit BACKTEST_MAX_SCAN the window was only covered up to
    // the last scanned transaction — divide the alert rate by the days
    // actually covered, not the full requested range.
    const truncated = totalInRange > scanned;
    const coveredDays = truncated && lastScannedTs
        ? Math.max(1, (lastScannedTs - fromDate) / 86400e3)
        : rangeDays;

    logEvent({
        req,
        service: "rule",
        action: "rule_backtest",
        target: rule.ruleId || (ruleId ? String(ruleId) : "inline-draft"),
        afterValue: {
            from: fromDate,
            to: toDate,
            scanned,
            matched: matchedCount,
            wouldFireAlerts,
            source: executable.source,
        },
    });

    res.status(200).json({
        success: true,
        rule: {
            _id: rule._id || null,
            ruleId: rule.ruleId || null,
            ruleName: rule.ruleName || "Inline draft",
            version: rule.version || null,
            riskLabel: rule.riskLabel || null,
            caseType: rule.caseType || null,
        },
        evaluationSource: executable.source, // 'logic' | 'conditions' | 'dsl'
        range: { from: fromDate, to: toDate, days: Math.round(rangeDays) },
        scanned,
        totalInRange,
        truncated,
        matchedCount,
        hitRate: scanned ? matchedCount / scanned : 0,
        wouldFireAlerts,
        alertsPerDay: wouldFireAlerts / coveredDays,
        uniqueCustomers: uniqueSubjects.size,
        matchedAmount,
        aggregation,
        perDay: series,
        sample,
        fieldMisses: [...fieldMissCounts.entries()]
            .map(([field, count]) => ({ field, count }))
            .sort((a, b) => b.count - a.count),
    });
});
