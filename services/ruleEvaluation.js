// services/ruleEvaluation.js
//
// Rule evaluation engine — the first consumer of RuleEngine.logic /
// conditions / aggregation (doc 72 K1). Currently used by the read-only
// backtest endpoint; designed so the notify flow and transaction-create
// hooks (doc 72 §5.3) can call the same functions later.
//
// Design rules (doc 72 §3.3 / §5.1):
//   - Every rule is untrusted input: unknown field, bad operator, bad regex
//     → the leaf evaluates false and is reported in `fieldMisses` — never throw.
//   - Analyst vocabulary resolves through the alias map below rather than
//     forcing raw schema paths like `sender.institutionCountry`.
//   - String comparisons are case-insensitive (seed data mixes "Australia"
//     and "DE"-style values).
//   - When a field resolves to multiple values (e.g. `country` across all
//     parties), the leaf passes if ANY value satisfies the operator.

const { parseRuleConditionDSL } = require("../utils/ruleConditionParser");
const { getSafeRegex } = require("../utils/safeRegex");

const PARTY_PATHS = ["sender", "receiver", "beneficiary", "intermediary"];

// ── Field resolution ─────────────────────────────────────────────────────────

const { signalKey } = require("../models/schemas/riskShared");

// ── Risk signals ─────────────────────────────────────────────────────────────
// `signals[]` (Transaction + Customer) holds typed facts with no column of
// their own. A rule can say `signals.beneficiary_on_watchlist` or just the
// analyst label "Beneficiary on watchlist" — both resolve to the same key.
const signalValue = (doc, rawField) => {
    const list = doc && Array.isArray(doc.signals) ? doc.signals : [];
    if (!list.length) return undefined;
    const key = signalKey(rawField.replace(/^signals\./i, ""));
    const now = Date.now();
    const hit = list.find(
        (s) => s && s.key === key && (!s.expiresAt || new Date(s.expiresAt).getTime() > now)
    );
    return hit ? hit.value : undefined;
};

// ── Derived customer facts ───────────────────────────────────────────────────
// Values rules ask for that exist only implicitly on the Customer document.
const DAY_MS = 86400e3;
const yearsSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / (365.25 * DAY_MS)) : undefined);
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY_MS) : undefined);
const customerDob = (c) => c?.personalKyc?.personal_form?.customer_details?.date_of_birth;
const customerSince = (c) => (c?.relations || []).map((r) => r?.registeredAt).filter(Boolean).sort()[0] || c?.createdAt;
const DERIVED_CUSTOMER = {
    age:               (c) => yearsSince(customerDob(c)),
    customer_age:      (c) => yearsSince(customerDob(c)),
    sender_age:        (c) => yearsSince(customerDob(c)),
    account_open_days: (c) => daysSince(customerSince(c)),
    account_age_days:  (c) => daysSince(customerSince(c)),
};

const getPath = (obj, path) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const compact = (arr) => arr.filter((v) => v !== undefined && v !== null && v !== "");

const partyValues = (txn, key) =>
    compact(PARTY_PATHS.map((p) => getPath(txn, `${p}.${key}`)));

// Populated party customers (deduped, tolerant of unpopulated ObjectIds)
const partyCustomers = (txn) => {
    const seen = new Set();
    const out = [];
    for (const p of PARTY_PATHS) {
        const c = txn?.[p]?.customer;
        if (!c || typeof c !== "object") continue;
        const id = String(c._id ?? out.length);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(c);
    }
    return out;
};

const customerValues = (txn, key) =>
    compact(partyCustomers(txn).map((c) => getPath(c, key)));

// Effective monetary value — AUD-threshold rules prefer the converted amount
const effectiveAmount = (txn) =>
    txn?.convertedAmountAUD != null ? txn.convertedAmountAUD : txn?.amount;

// Alias map: analyst rule vocabulary → transaction context values.
// Each resolver returns the raw value; `undefined` means "not present".
const FIELD_ALIASES = {
    amount:                 (txn) => effectiveAmount(txn),
    convertedamountaud:     (txn) => txn?.convertedAmountAUD,
    currency:               (txn) => txn?.currency,
    type:                   (txn) => txn?.type,
    transaction_type:       (txn) => txn?.type,
    subtype:                (txn) => txn?.subtype,
    channel:                (txn) => txn?.channel,
    status:                 (txn) => txn?.status,
    purpose:                (txn) => txn?.purpose,
    remittancepurposecode:  (txn) => txn?.remittancePurposeCode,
    reference:              (txn) => txn?.reference,
    narrative:              (txn) => txn?.narrative,
    riskscore:              (txn) => txn?.riskScore,
    riskflags:              (txn) => txn?.riskFlags,
    risk_flags:             (txn) => txn?.riskFlags,
    country:                (txn) => partyValues(txn, "institutionCountry"),
    institutioncountry:     (txn) => partyValues(txn, "institutionCountry"),
    institution:            (txn) => partyValues(txn, "institution"),
    bic:                    (txn) => partyValues(txn, "bic"),
    hops:                   (txn) => txn?.crypto?.hops,
    chainalysisscore:       (txn) => txn?.forensic?.chainalysisScore,
    relatedpartyflag:       (txn) => txn?.relatedPartyFlag,
    // Customer-side aliases resolve against every populated party customer
    pep:                    (txn) => customerValues(txn, "isPep"),
    pep_status:             (txn) => customerValues(txn, "isPep"),
    ispep:                  (txn) => customerValues(txn, "isPep"),
    sanction:               (txn) => customerValues(txn, "sanction"),
    sanctions:              (txn) => customerValues(txn, "sanction"),
    amlstatus:              (txn) => customerValues(txn, "amlStatus"),
    aml_status:             (txn) => customerValues(txn, "amlStatus"),
    kycstatus:              (txn) => customerValues(txn, "kycStatus"),
    kyc_status:             (txn) => customerValues(txn, "kycStatus"),
};

// Customer-subject aliases: the same analyst vocabulary, resolved directly on
// a Customer document (appliesTo:'customer' rules are evaluated against the
// customer itself — there is no transaction to hop through).
const CUSTOMER_ALIASES = {
    pep:        (c) => c?.isPep,
    pep_status: (c) => c?.isPep,
    ispep:      (c) => c?.isPep,
    sanction:   (c) => c?.sanction,
    sanctions:  (c) => c?.sanction,
    amlstatus:  (c) => c?.amlStatus,
    aml_status: (c) => c?.amlStatus,
    kycstatus:  (c) => c?.kycStatus,
    kyc_status: (c) => c?.kycStatus,
    country:    (c) => c?.country,
    status:     (c) => c?.status,
    ...DERIVED_CUSTOMER,
};

/**
 * Resolve a rule field name against a Customer document (subject = customer).
 * Accepts both bare paths ("isPep", "personalKyc.…") and the transaction-side
 * spelling ("customer.isPep") so a rule can be re-targeted without rewriting.
 */
const resolveCustomerField = (customer, rawField) => {
    const field = rawField.replace(/^customer\./i, "");
    const aliasKey = field.toLowerCase().replace(/\s+/g, "_");
    const alias = CUSTOMER_ALIASES[aliasKey] || CUSTOMER_ALIASES[aliasKey.replace(/[._]/g, "")];
    let value = alias ? alias(customer) : getPath(customer, field);
    // Fall back to a typed signal ("Device fingerprint banned" → signals.device_fingerprint_banned)
    if (value === undefined) value = signalValue(customer, field);
    const empty = value === undefined || value === null || value === "";
    return { found: !empty, value };
};

/**
 * Resolve a rule field name against a subject document.
 * Returns { found, value } where value may be an array (any-match).
 * `opts.subject` is 'transaction' (default) or 'customer' — mirrors
 * RuleEngine.appliesTo.
 */
const resolveField = (txn, rawField, opts = {}) => {
    if (!rawField || typeof rawField !== "string") return { found: false, value: undefined };
    const field = rawField.trim();

    if (opts.subject === "customer") return resolveCustomerField(txn, field);

    // 1. Alias map (normalized: lowercase, dots/spaces collapsed)
    const aliasKey = field.toLowerCase().replace(/\s+/g, "_").replace(/^(txn|transaction)\./, "");
    const alias = FIELD_ALIASES[aliasKey] || FIELD_ALIASES[aliasKey.replace(/[._]/g, "")];
    if (alias) {
        const value = alias(txn);
        const empty = value === undefined || value === null || (Array.isArray(value) && !value.length);
        return { found: !empty, value };
    }

    // 2. `customer.<path>` → any party's populated customer
    if (/^customer\./i.test(field)) {
        const sub = field.replace(/^customer\./i, "");
        const values = customerValues(txn, sub);
        return { found: values.length > 0, value: values };
    }

    // 3. Derived customer facts asked for on a transaction rule ("Sender age")
    const derivedKey = aliasKey.replace(/^customer_/, "");
    if (DERIVED_CUSTOMER[derivedKey] || DERIVED_CUSTOMER[aliasKey]) {
        const fn = DERIVED_CUSTOMER[derivedKey] || DERIVED_CUSTOMER[aliasKey];
        const values = compact(partyCustomers(txn).map(fn));
        if (values.length) return { found: true, value: values };
    }

    // 4. Literal dotted/plain schema path on the transaction
    const direct = getPath(txn, field);
    if (direct !== undefined) return { found: direct !== null, value: direct };

    // 5. Typed signal — on the transaction first, then on any party customer
    const own = signalValue(txn, field);
    if (own !== undefined) return { found: true, value: own };
    const fromCustomers = compact(partyCustomers(txn).map((c) => signalValue(c, field)));
    if (fromCustomers.length) return { found: true, value: fromCustomers };

    return { found: false, value: undefined };
};

// ── Leaf evaluation ──────────────────────────────────────────────────────────

// Strip thousand-separator commas ("50,000" → "50000") so builder-typed
// thresholds compare numerically — mirrors coerceValue in ruleConditionParser.
const stripThousands = (v) =>
    typeof v === "string" ? v.replace(/,(?=\d{3}(\D|$))/g, "") : v;

const isNumericLike = (v) => {
    if (typeof v === "number") return true;
    if (typeof v !== "string" || v.trim() === "") return false;
    return !isNaN(Number(stripThousands(v)));
};

const toNumber = (v) => (typeof v === "number" ? v : Number(stripThousands(v)));

const normStr = (v) => String(v).trim().toLowerCase();

// Rule leaves authored in the UI builder carry booleans as the strings
// "true"/"false" — treat those as booleans when compared against real
// boolean transaction/customer flags (isPep, sanction, relatedPartyFlag…).
const toBooleanLike = (v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true") return true;
        if (s === "false") return false;
    }
    return undefined; // not boolean-like
};

// eq comparison: boolean when either side is boolean(-like), numeric when
// both sides are numeric-like, else case-insensitive string
const looseEquals = (a, b) => {
    if (typeof a === "boolean" || typeof b === "boolean") {
        const ab = toBooleanLike(a);
        const bb = toBooleanLike(b);
        return ab !== undefined && ab === bb;
    }
    if (isNumericLike(a) && isNumericLike(b)) return toNumber(a) === toNumber(b);
    return normStr(a) === normStr(b);
};

const compareNumeric = (a, b, op) => {
    if (!isNumericLike(a) || !isNumericLike(b)) return false;
    const x = toNumber(a);
    const y = toNumber(b);
    switch (op) {
        case "gt":  return x > y;
        case "gte": return x >= y;
        case "lt":  return x < y;
        case "lte": return x <= y;
        default:    return false;
    }
};

// Test ONE scalar actual value against the leaf
const testScalar = (actual, leaf) => {
    switch (leaf.operator) {
        case "eq":  return looseEquals(actual, leaf.value);
        case "ne":  return !looseEquals(actual, leaf.value);
        case "gt": case "gte": case "lt": case "lte":
            return compareNumeric(actual, leaf.value, leaf.operator);
        case "in":
            return Array.isArray(leaf.values) && leaf.values.some((v) => looseEquals(actual, v));
        case "nin":
            return Array.isArray(leaf.values) && !leaf.values.some((v) => looseEquals(actual, v));
        case "between": {
            if (!isNumericLike(actual) || !isNumericLike(leaf.min) || !isNumericLike(leaf.max)) return false;
            const x = toNumber(actual);
            return x >= toNumber(leaf.min) && x <= toNumber(leaf.max);
        }
        case "contains":
            return leaf.value !== undefined && normStr(actual).includes(normStr(leaf.value));
        case "startsWith":
            return leaf.value !== undefined && normStr(actual).startsWith(normStr(leaf.value));
        case "endsWith":
            return leaf.value !== undefined && normStr(actual).endsWith(normStr(leaf.value));
        case "exists":
            return actual !== undefined && actual !== null && actual !== "";
        case "regex": {
            // Untrusted pattern — compiled through the linear-time RE2 engine
            // (utils/safeRegex; fails closed when RE2 is unavailable).
            // Invalid / unsupported / oversized patterns are a tolerant false,
            // like any other malformed leaf. No input truncation: RE2 is
            // linear-time, and slicing would silently break $-anchored
            // patterns against long narratives.
            const re = getSafeRegex(leaf.value);
            if (!re) return false;
            try { return re.test(String(actual)); } catch { return false; }
        }
        default:
            return false; // unknown operator — tolerant false
    }
};

const expectedLabel = (leaf) => {
    if (leaf.operator === "between") return `${leaf.min} – ${leaf.max}`;
    if (leaf.operator === "exists")  return "";
    if (Array.isArray(leaf.values))  return leaf.values.join(", ");
    return leaf.value !== undefined ? String(leaf.value) : "";
};

/**
 * Evaluate one condition leaf against a transaction.
 * Returns { pass, found, field, operator, expected, actual }.
 */
const evalLeaf = (leaf, txn, opts = {}) => {
    const { found, value } = resolveField(txn, leaf.field, opts);
    const result = {
        field: leaf.field,
        operator: leaf.operator,
        expected: expectedLabel(leaf),
        found,
        actual: undefined,
        pass: false,
    };

    if (!found) {
        // `exists` on a missing field is a legitimate false, not a field miss;
        // everything else on a missing field is false too — caller records the miss.
        result.actual = null;
        return result;
    }

    if (Array.isArray(value)) {
        // Any-match across resolved values (e.g. country across all parties)
        const hit = value.find((v) => testScalar(v, leaf));
        result.pass = hit !== undefined;
        result.actual = result.pass ? hit : value.length === 1 ? value[0] : value;
    } else {
        result.pass = testScalar(value, leaf);
        result.actual = value;
    }
    return result;
};

// ── Logic tree walk ──────────────────────────────────────────────────────────

const isLeafNode = (node) => node && typeof node === "object" && node.field && node.operator;

/**
 * Walk a logic tree ({logic:'AND'|'OR', children:[...]} | leaf) against a
 * transaction. All leaves are evaluated (no short-circuit) so callers get the
 * full matched/missed picture. Returns boolean; pushes leaf results into `out`.
 */
const evalNode = (node, txn, out, opts = {}) => {
    if (isLeafNode(node)) {
        const r = evalLeaf(node, txn, opts);
        out.push(r);
        return r.pass;
    }
    if (node && Array.isArray(node.children) && node.children.length) {
        const results = node.children.map((c) => evalNode(c, txn, out, opts));
        return String(node.logic).toUpperCase() === "OR"
            ? results.some(Boolean)
            : results.every(Boolean);
    }
    return false; // malformed node — tolerant false
};

// ── Rule-level API ───────────────────────────────────────────────────────────

/**
 * Resolve a rule's executable logic once (doc 72 §5.1 step 2 priority):
 *   1. `logic` tree  2. `conditions[]` as implicit AND  3. parsed DSL string.
 * Returns { tree, source } or null when nothing is evaluable.
 */
const resolveExecutable = (rule) => {
    if (rule?.logic && (isLeafNode(rule.logic) || Array.isArray(rule.logic.children))) {
        return { tree: rule.logic, source: "logic" };
    }
    if (Array.isArray(rule?.conditions) && rule.conditions.length) {
        return { tree: { logic: "AND", children: rule.conditions }, source: "conditions" };
    }
    const parsed = parseRuleConditionDSL(rule?.ruleCondition);
    if (parsed?.logic) return { tree: parsed.logic, source: "dsl" };
    return null;
};

/**
 * Evaluate a resolved tree against one subject document.
 * `opts.subject` = 'transaction' (default) | 'customer' — pass the rule's
 * appliesTo so customer rules resolve fields on the Customer itself.
 * Returns { matched, leaves, matchedLeaves, missedLeaves, fieldMisses }.
 */
const evaluateTree = (tree, txn, opts = {}) => {
    const leaves = [];
    const matched = evalNode(tree, txn, leaves, opts);
    return {
        matched,
        leaves,
        matchedLeaves: leaves.filter((l) => l.pass),
        missedLeaves: leaves.filter((l) => !l.pass),
        fieldMisses: leaves.filter((l) => !l.found && l.operator !== "exists").map((l) => l.field),
    };
};

// ── Aggregation (velocity rules) ─────────────────────────────────────────────

const WINDOW_MS = { minute: 60e3, hour: 3600e3, day: 86400e3 };

// Subject key for grouping: first party customer id, else party name, else the
// txn itself (so unattributable txns never aggregate with each other).
const subjectKey = (txn) => {
    for (const p of PARTY_PATHS) {
        const c = txn?.[p]?.customer;
        if (c) return String(c._id ?? c);
    }
    return txn?.sender?.name || txn?.receiver?.name || String(txn?._id);
};

/**
 * Tumbling-window approximation of `rule.aggregation` over the txns that
 * matched the rule's conditions: bucket by subject customer × window, fire
 * when every defined threshold (count / sumThreshold) is met.
 * Takes slim rows ({ id, ts, subject, amount }) so callers can stream large
 * scans without retaining full documents.
 * Returns { windows, firedWindows, firedTxnIds:Set }.
 */
const applyAggregation = (aggregation, rows) => {
    const value = aggregation?.window?.value;
    const unit = aggregation?.window?.unit || "minute";
    const winMs = (value || 1) * (WINDOW_MS[unit] || WINDOW_MS.minute);
    const needCount = aggregation?.count ?? null;
    const needSum = aggregation?.sumThreshold ?? null;

    const buckets = new Map();
    for (const row of rows) {
        const ts = new Date(row.ts).getTime();
        const key = `${row.subject}|${Math.floor(ts / winMs)}`;
        let b = buckets.get(key);
        if (!b) {
            b = { subject: row.subject, windowStart: new Date(Math.floor(ts / winMs) * winMs), count: 0, sum: 0, txnIds: [] };
            buckets.set(key, b);
        }
        b.count += 1;
        b.sum += Number(row.amount) || 0;
        b.txnIds.push(String(row.id));
    }

    const windows = [...buckets.values()];
    const firedWindows = windows.filter(
        (b) =>
            (needCount == null || b.count >= needCount) &&
            (needSum == null || b.sum >= needSum)
    );
    const firedTxnIds = new Set(firedWindows.flatMap((b) => b.txnIds));
    return { windows, firedWindows, firedTxnIds };
};

const hasAggregation = (rule) =>
    rule?.aggregation != null &&
    (rule.aggregation.count != null || rule.aggregation.sumThreshold != null);

module.exports = {
    signalValue,
    resolveField,
    evalLeaf,
    resolveExecutable,
    evaluateTree,
    applyAggregation,
    hasAggregation,
    effectiveAmount,
    subjectKey,
};
