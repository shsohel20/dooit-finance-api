/**
 * Migration: align RuleEngine condition fields/values with the evaluation engine.
 *
 * Problem: most seeded rules never fire because their condition leaves don't
 * resolve against real transaction data —
 *   - field names the evaluator can't resolve ("Sender country", "PEP status",
 *     "HOPS_FROM_ILLICIT_CLUSTER") where a real schema path exists,
 *   - string values that never match typed data ("YES" vs boolean true,
 *     "50,000" vs number 50000),
 *   - vendor-scale thresholds ("Fraud score > 900" against riskScore 0–100).
 *
 * This script rewrites `conditions[]` and the `logic` tree of every rule to
 * canonical, resolvable fields and typed values, regenerates the display DSL
 * (`ruleCondition`) for changed rules, and reports — without touching — rules
 * whose fields reference data that does not exist on the Transaction schema
 * at all (device/session/email analytics, KYC review fields, …).
 *
 * Safe to re-run: transforms are idempotent (canonical input → no change).
 * Version bumping: updates go through the Mongoose model, so the existing
 * pre-update hook increments `version` on every rule whose logic changed.
 *
 * Usage:
 *   node api/scripts/align-rule-engine-fields.js          # dry-run (report only)
 *   node api/scripts/align-rule-engine-fields.js --apply  # write changes
 */
const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });

const ruleEvaluation = require("../services/ruleEvaluation");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Field mapping — legacy analyst vocabulary → canonical resolvable field
//
// Keys are matched case-insensitively with spaces/underscores collapsed, so
// "Sender Country", "sender_country" and "SENDER COUNTRY" all hit one entry.
// Every target below either exists in the evaluator's alias map or is a real
// dotted path on the Transaction schema (models/Transaction.js).
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_MAP = {
    // Party fields → PartySchema paths
    "sender name":                 "sender.name",
    "beneficiary name":            "beneficiary.name",
    "receiver name":               "receiver.name",
    "sender account":              "sender.account",
    "beneficiary account":         "beneficiary.account",
    "sender institution":          "sender.institution",
    "beneficiary institution":     "beneficiary.institution",
    "sender country":              "sender.institutionCountry",
    "beneficiary country":         "beneficiary.institutionCountry",
    "sender institution country":  "sender.institutionCountry",

    // Amount variants
    "total aud":                   "convertedAmountAUD",

    // Vendor fraud score (0–1000) → transaction riskScore (0–100); values are
    // rescaled below in normalizeLeafValue.
    "fraud score":                 "riskScore",

    // Crypto / forensic → CryptoSchema + forensic subdoc paths
    "hops from illicit cluster":   "hops",
    "crypto network":              "crypto.network",
    "network":                     "crypto.network",
    "cluster name":                "crypto.cluster",
    "path analysis":               "forensic.notes",
    "chainalysis score":           "chainalysisScore",

    // Travel Rule → TravelRuleSchema paths
    "travel rule message":         "travelRule.travelMessageId",
    "travel rule protocol":        "travelRule.protocol",
    "originator vasp name":        "travelRule.originatorVaspName",
    "originator vasp legal name":  "travelRule.originatorVaspName",
    "beneficiary vasp name":       "travelRule.beneficiaryVaspName",
    "beneficiary vasp legal name": "travelRule.beneficiaryVaspName",

    // Customer screening flags → evaluator aliases (resolve against any
    // populated party customer)
    "pep status":                  "pep",
    "sanctions hit":               "sanction",

    // Misc direct fixes
    "tx reference":                "reference",
};

// Vendor fraud-score thresholds arrive on a 0–1000 scale; riskScore is 0–100.
const FRAUD_SCORE_LEGACY_MAX = 100;

// Common data typos worth fixing while we're here.
const VALUE_TYPO_MAP = {
    "banghladesh": "Bangladesh",
};

// Operators whose value is a free-text fragment — never coerce those to
// numbers/booleans ("contains 'test'" must stay a string).
const TEXT_OPERATORS = new Set(["contains", "startsWith", "endsWith", "regex"]);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Resolvability check
//
// Instead of duplicating the evaluator's alias list here, we ask the evaluator
// itself: a field is resolvable when resolveField() finds it on a sample
// transaction that has every schema path populated.
// ─────────────────────────────────────────────────────────────────────────────
const SAMPLE_CUSTOMER = {
    _id: "sample-customer",
    isPep: true,
    sanction: true,
    amlStatus: "clear",
    kycStatus: "verified",
    country: "AU",
    status: "active",
    given_name: "Sample",
    surname: "Customer",
    amlRiskLabels: ["pep", "sanctions", "adverseMedia"],
};

const SAMPLE_PARTY = {
    customer: SAMPLE_CUSTOMER,
    name: "Sample Name",
    account: "12345678",
    institution: "Sample Bank",
    institutionCountry: "AU",
    bic: "SAMPAU2S",
    address: "1 Sample St",
};

const SAMPLE_TXN = {
    uid: "TXN-SAMPLE",
    timestamp: new Date(),
    type: "transfer",
    subtype: "manual",
    amount: 1000,
    currency: "AUD",
    convertedAmountAUD: 1000,
    reference: "REF-1",
    narrative: "sample narrative",
    status: "completed",
    channel: "online",
    sender: SAMPLE_PARTY,
    receiver: SAMPLE_PARTY,
    beneficiary: SAMPLE_PARTY,
    intermediary: SAMPLE_PARTY,
    purpose: "payment",
    remittancePurposeCode: "RP01",
    crypto: { walletAddress: "0xabc", txHash: "0xdef", network: "ETH", hops: 1, cluster: "sample" },
    riskScore: 10,
    riskFlags: ["sample"],
    forensic: { walletCluster: "sample", chainalysisScore: 1, notes: "sample" },
    travelRule: {
        originatorVaspId: "V1", originatorVaspName: "VASP A", originatorVaspLicense: "L1",
        beneficiaryVaspId: "V2", beneficiaryVaspName: "VASP B",
        travelMessageId: "TRM-1", protocol: "IVMS101",
    },
    relatedPartyTxnId: "TXN-REL",
    relatedPartyFlag: true,
};

const isResolvable = (field) =>
    ruleEvaluation.resolveField(SAMPLE_TXN, field).found;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Leaf transforms
// ─────────────────────────────────────────────────────────────────────────────

// "Sender_Country " → "sender country" so FIELD_MAP lookups are forgiving.
const normalizeKey = (field) =>
    String(field || "").trim().toLowerCase().replace(/[_\s]+/g, " ");

// A leaf whose field or value embeds a whole expression ("a == b && c > d")
// came from a broken import — it cannot be fixed mechanically.
const isMalformedLeaf = (leaf) => {
    const blob = `${leaf.field ?? ""} ${leaf.value ?? ""} ${leaf.min ?? ""} ${leaf.max ?? ""}`;
    return /&&|\|\||==/.test(blob);
};

// Coerce one raw value to what the data actually holds:
// booleans for YES/NO/TRUE/FALSE, numbers for numeric strings (commas
// stripped), typo fixes for known bad country names.
const normalizeValue = (raw, operator) => {
    if (typeof raw !== "string") return raw;
    const t = raw.trim();

    if (TEXT_OPERATORS.has(operator)) {
        return VALUE_TYPO_MAP[t.toLowerCase()] ?? t;
    }

    const lower = t.toLowerCase();
    if (lower === "yes" || lower === "true") return true;
    if (lower === "no" || lower === "false") return false;
    if (VALUE_TYPO_MAP[lower]) return VALUE_TYPO_MAP[lower];

    // "50,000" → 50000 — same coercion the DSL parser applies
    const stripped = t.replace(/,(?=\d{3}(\D|$))/g, "");
    if (/^-?\d+(\.\d+)?$/.test(stripped)) return Number(stripped);

    return t;
};

/**
 * Align one condition leaf. Returns:
 *   { leaf, changed, notes[] }              — aligned (or already-canonical) leaf
 *   { leaf, changed:false, unresolvable }   — field has no transaction data
 *   { leaf, changed:false, malformed }      — compound expression, needs a human
 */
const alignLeaf = (original) => {
    const notes = [];

    if (isMalformedLeaf(original)) {
        return { leaf: original, changed: false, malformed: true };
    }

    const leaf = { ...original };
    const key = normalizeKey(leaf.field);

    // ── Special semantic rewrites (whole-leaf, before plain field mapping) ──
    // "Type = CRYPTO" — there is no crypto transaction type; a crypto txn is
    // one that carries a wallet address.
    if (key === "type" && normalizeKey(leaf.value) === "crypto") {
        return {
            leaf: { field: "crypto.walletAddress", operator: "exists" },
            changed: true,
            notes: ['rewrote "Type = CRYPTO" → "crypto.walletAddress exists"'],
        };
    }
    // "Type = FOREIGN_EXCHANGE" — the schema enum calls it "exchange".
    if (key === "type" && normalizeKey(leaf.value) === "foreign exchange") {
        return {
            leaf: { field: "type", operator: "eq", value: "exchange" },
            changed: true,
            notes: ['rewrote "Type = FOREIGN_EXCHANGE" → "type = exchange"'],
        };
    }
    // "Adverse media = YES" — lives on the customer's amlRiskLabels list.
    if (key === "adverse media") {
        return {
            leaf: { field: "customer.amlRiskLabels", operator: "contains", value: "adverseMedia" },
            changed: true,
            notes: ['rewrote "Adverse media = YES" → customer.amlRiskLabels contains "adverseMedia"'],
        };
    }

    // ── Field mapping ────────────────────────────────────────────────────────
    const mapped = FIELD_MAP[key];
    if (mapped && mapped !== leaf.field) {
        notes.push(`field "${leaf.field}" → "${mapped}"`);
        leaf.field = mapped;
    }

    // ── Value normalisation ──────────────────────────────────────────────────
    for (const prop of ["value", "min", "max"]) {
        if (leaf[prop] === undefined) continue;
        const next = normalizeValue(leaf[prop], leaf.operator);
        if (next !== leaf[prop]) {
            notes.push(`${prop} ${JSON.stringify(leaf[prop])} → ${JSON.stringify(next)}`);
            leaf[prop] = next;
        }
    }
    if (Array.isArray(leaf.values)) {
        const next = leaf.values.map((v) => normalizeValue(v, leaf.operator));
        if (JSON.stringify(next) !== JSON.stringify(leaf.values)) {
            notes.push("values list normalised");
            leaf.values = next;
        }
    }

    // Vendor fraud score arrived on a 0–1000 scale — rescale to riskScore 0–100
    if (key === "fraud score" && typeof leaf.value === "number" && leaf.value > FRAUD_SCORE_LEGACY_MAX) {
        const scaled = leaf.value / 10;
        notes.push(`fraud-score threshold ${leaf.value} rescaled → ${scaled} (riskScore is 0–100)`);
        leaf.value = scaled;
    }

    // ── Verdict ──────────────────────────────────────────────────────────────
    if (!isResolvable(leaf.field)) {
        // No transaction data backs this field — leave the rule untouched and
        // surface it in the report for a human decision.
        return { leaf: original, changed: false, unresolvable: true };
    }

    return { leaf, changed: notes.length > 0, notes };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tree + rule transforms
// ─────────────────────────────────────────────────────────────────────────────

const isLeafNode = (node) => node && typeof node === "object" && node.field && node.operator;

/**
 * Walk a logic tree, aligning every leaf. Collects notes/unresolvable/malformed
 * findings into `report`.
 */
const alignTree = (node, report) => {
    if (!node || typeof node !== "object") return { node, changed: false };

    if (isLeafNode(node)) {
        const result = alignLeaf(node);
        if (result.unresolvable) report.unresolvable.push(node.field);
        if (result.malformed) report.malformed.push(node.field);
        if (result.notes?.length) report.notes.push(...result.notes);
        return { node: result.leaf, changed: result.changed };
    }

    if (Array.isArray(node.children)) {
        let changed = false;
        const children = node.children.map((child) => {
            const r = alignTree(child, report);
            changed = changed || r.changed;
            return r.node;
        });
        return { node: { ...node, children }, changed };
    }

    return { node, changed: false };
};

// Rebuild the human-readable DSL from an aligned tree so the UI stays
// consistent with what actually executes. Mirrors the UI builder's syntax.
const leafToExpr = (leaf) => {
    switch (leaf.operator) {
        case "gt":         return `${leaf.field} > ${leaf.value}`;
        case "gte":        return `${leaf.field} >= ${leaf.value}`;
        case "lt":         return `${leaf.field} < ${leaf.value}`;
        case "lte":        return `${leaf.field} <= ${leaf.value}`;
        case "eq":         return `${leaf.field} == ${leaf.value}`;
        case "ne":         return `${leaf.field} != ${leaf.value}`;
        case "in":         return `${leaf.field} IN [${(leaf.values || []).join(", ")}]`;
        case "nin":        return `${leaf.field} NOT IN [${(leaf.values || []).join(", ")}]`;
        case "between":    return `${leaf.field} BETWEEN ${leaf.min} AND ${leaf.max}`;
        case "contains":   return `${leaf.field} CONTAINS "${leaf.value}"`;
        case "startsWith": return `${leaf.field} STARTS WITH "${leaf.value}"`;
        case "endsWith":   return `${leaf.field} ENDS WITH "${leaf.value}"`;
        case "exists":     return `${leaf.field} EXISTS`;
        case "regex":      return `${leaf.field} MATCHES /${leaf.value}/`;
        default:           return `${leaf.field} ${leaf.operator} ${leaf.value}`;
    }
};

const treeToDsl = (node, topLevel = true) => {
    if (isLeafNode(node)) return leafToExpr(node);
    if (!node || !Array.isArray(node.children)) return "";
    const joiner = String(node.logic).toUpperCase() === "OR" ? " OR " : " AND ";
    const body = node.children.map((c) => treeToDsl(c, false)).filter(Boolean).join(joiner);
    return topLevel ? body : `(${body})`;
};

/**
 * Align one rule document. Returns null when nothing changed, else
 * { update, report } where `update` is the $set payload.
 */
const alignRule = (rule) => {
    const report = { notes: [], unresolvable: [], malformed: [] };
    const update = {};
    let changed = false;

    if (Array.isArray(rule.conditions) && rule.conditions.length) {
        let condChanged = false;
        const conditions = rule.conditions.map((leaf) => {
            const r = alignTree(leaf, report);
            condChanged = condChanged || r.changed;
            return r.node;
        });
        if (condChanged) {
            update.conditions = conditions;
            changed = true;
        }
    }

    if (rule.logic && typeof rule.logic === "object") {
        const r = alignTree(rule.logic, report);
        if (r.changed) {
            update.logic = r.node;
            changed = true;
        }
    }

    // Keep the display string in sync with what will actually execute.
    if (changed && update.logic) {
        update.ruleCondition = treeToDsl(update.logic);
    }

    return { changed, update, report };
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. CLI runner
// ─────────────────────────────────────────────────────────────────────────────
const main = async () => {
    const APPLY = process.argv.includes("--apply");

    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL;
    if (!uri) {
        console.error("No Mongo connection string found (MONGO_URI / MONGODB_URI / DATABASE_URL).");
        process.exit(1);
    }

    await mongoose.connect(uri);
    const RuleEngine = require("../models/RuleEngine");

    const rules = await RuleEngine.find({ deletedAt: null }).lean();
    console.log(`Scanning ${rules.length} rule(s)… mode: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

    let changedCount = 0;
    const unresolvableCounts = new Map(); // field → count of rules referencing it
    const malformedRules = [];

    for (const rule of rules) {
        const { changed, update, report } = alignRule(rule);

        for (const f of new Set(report.unresolvable)) {
            unresolvableCounts.set(f, (unresolvableCounts.get(f) || 0) + 1);
        }
        if (report.malformed.length) malformedRules.push(rule.ruleId);

        if (!changed) continue;
        changedCount++;

        console.log(`— ${rule.ruleId} (${rule.ruleName})`);
        for (const note of report.notes) console.log(`    · ${note}`);

        if (APPLY) {
            // Through the model so the pre-update hook bumps `version`.
            await RuleEngine.updateOne({ _id: rule._id }, { $set: update });
        }
    }

    console.log(`\n${changedCount} rule(s) ${APPLY ? "updated" : "would be updated"}.`);

    if (unresolvableCounts.size) {
        console.log(
            "\nFields with NO backing transaction data (rules left untouched — " +
            "these need either new data ingestion or a rule redesign):"
        );
        const sorted = [...unresolvableCounts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [field, count] of sorted) {
            console.log(`    ${String(count).padStart(3)}× ${field}`);
        }
    }

    if (malformedRules.length) {
        console.log(
            `\nMalformed leaves (whole expressions crammed into field/value — need manual fix): ` +
            malformedRules.join(", ")
        );
    }

    await mongoose.disconnect();
};

// Export the pure transforms so they can be unit-tested without a DB.
module.exports = { alignLeaf, alignRule, alignTree, treeToDsl, SAMPLE_TXN };

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
