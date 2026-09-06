// seeds/repair-rule-conditions.js
//
// Phase 4 of RuleEngine data quality work — make the structured conditions
// honest, and stamp `engine`.
//
// Findings this repairs (live corpus, 21 Aug 2026):
//
//   a. 20 leaves whose `field` contains operator/grouping text — the DSL
//      parser split a sentence in the wrong place, e.g. field = "New account (".
//      → leaf dropped. If nothing is left, `conditions`/`logic` are cleared so
//        resolveExecutable() reports the rule as not evaluable instead of
//        evaluating garbage.
//   b. 17 rules whose text says "A AND B" but whose tree has one/zero leaves —
//      half-parsed. → tree cleared for the same reason.
//   c. 36 leaves comparing to the strings "YES"/"NO" (`Legal hold flag = YES`).
//      → value coerced to boolean true/false so the evaluator's boolean-aware
//        eq can match real flags.
//   e. 587 rules have `actions: []`. The schema default ([create_alert]) only
//      applies to NEW documents → backfilled here so imported rules can fire.
//
//   d. `engine` is a new field. Derived from what the rule actually is:
//        aggregate  — has an aggregation window (count / sumThreshold)
//        screening  — category 'external-screening'
//        manual     — category 'behavioral-pattern', or 'ambiguous' with no
//                     evaluable tree (narrative typologies the engine must skip)
//        predicate  — everything else
//
// Run `categorize-clientrules.js --apply` first — step d reads `category`.
//
// Usage:
//   node seeds/repair-rule-conditions.js            # dry-run + CSV report
//   node seeds/repair-rule-conditions.js --apply    # write changes
//   node seeds/repair-rule-conditions.js --client=<id>

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const RuleEngine = require("../models/RuleEngine");
const { resolveExecutable, hasAggregation } = require("../services/ruleEvaluation");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const clientArg = argv.find((a) => a.startsWith("--client="));
const CLIENT_ID = clientArg ? clientArg.split("=")[1] : null;

// Same rule as the model's LEAF_FIELD_PATTERN — a field must never carry these.
const BROKEN_FIELD = /[()<>=!&|]/;
const YES_NO = { yes: true, no: false, true: true, false: false };

// ── Leaf / tree repair ───────────────────────────────────────────────────────

/** Fix one leaf in place-copy. Returns null when the leaf must be dropped. */
function repairLeaf(leaf, notes) {
  if (!leaf || !leaf.field) return leaf;
  if (BROKEN_FIELD.test(leaf.field)) {
    notes.push(`dropped broken leaf "${leaf.field.slice(0, 40)}"`);
    return null;
  }
  if (typeof leaf.value === "string" && leaf.value.trim().toLowerCase() in YES_NO) {
    const bool = YES_NO[leaf.value.trim().toLowerCase()];
    notes.push(`${leaf.field}: "${leaf.value}" → ${bool}`);
    return { ...leaf, value: bool };
  }
  return leaf;
}

/** Walk a logic tree, repairing leaves and pruning empty branches. */
function repairTree(node, notes) {
  if (!node || typeof node !== "object") return node;
  if (node.field) return repairLeaf(node, notes);
  if (Array.isArray(node.children)) {
    const children = node.children.map((c) => repairTree(c, notes)).filter(Boolean);
    if (!children.length) return null;
    return { ...node, children };
  }
  return node;
}

/** Count leaves in a tree. */
function leafCount(node) {
  if (!node || typeof node !== "object") return 0;
  if (node.field) return 1;
  return (node.children || []).reduce((n, c) => n + leafCount(c), 0);
}

/**
 * Repair one rule. Returns { conditions, logic, engine, notes, cleared }.
 * `conditions: undefined` / `logic: null` means "unset in the DB".
 */
function repairRule(rule) {
  const notes = [];

  // a + c — leaves
  let conditions = Array.isArray(rule.conditions)
    ? rule.conditions.map((l) => repairLeaf(l, notes)).filter(Boolean)
    : undefined;
  let logic = rule.logic ? repairTree(rule.logic, notes) : null;

  // b — half-parsed: text has a boolean connective but the tree has < 2 leaves
  const textIsCompound = /\b(AND|OR)\b/.test(rule.ruleCondition || "");
  const treeLeaves = Math.max(leafCount(logic), (conditions || []).length);
  let cleared = false;
  if (textIsCompound && treeLeaves > 0 && treeLeaves < 2) {
    notes.push(`cleared half-parsed tree (${treeLeaves} leaf for a compound sentence)`);
    conditions = undefined;
    logic = null;
    cleared = true;
  }
  if (conditions && !conditions.length) conditions = undefined;

  // d — engine
  const probe = { ...rule, conditions, logic };
  let engine = "predicate";
  if (hasAggregation(rule)) engine = "aggregate";
  else if (rule.category === "external-screening") engine = "screening";
  else if (rule.category === "behavioral-pattern") engine = "manual";
  else if (rule.category === "ambiguous" && !resolveExecutable(probe)) engine = "manual";

  return { conditions, logic, engine, notes, cleared };
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function run() {
  console.log(`[repair] mode=${APPLY ? "APPLY" : "DRY-RUN"}${CLIENT_ID ? ` client=${CLIENT_ID}` : ""}`);
  await mongoose.connect(process.env.MONGO_URI);

  const rules = await RuleEngine.find(CLIENT_ID ? { client: CLIENT_ID } : {}).lean();
  const counts = { leavesFixed: 0, treesCleared: 0, actionsFilled: 0, engine: {}, updated: 0 };
  const report = [];

  for (const rule of rules) {
    const { conditions, logic, engine, notes, cleared } = repairRule(rule);
    counts.engine[engine] = (counts.engine[engine] || 0) + 1;
    if (cleared) counts.treesCleared++;
    counts.leavesFixed += notes.filter((n) => !n.startsWith("cleared")).length;

    // `rule.engine` is undefined on every pre-existing doc — stamp it even
    // when the derived value equals the schema default.
    const engineChanged = rule.engine !== engine;
    const treeChanged = notes.length > 0;
    const needsActions = !(Array.isArray(rule.actions) && rule.actions.length);
    if (needsActions) counts.actionsFilled++;
    report.push({ ruleId: rule.ruleId, engine, category: rule.category || "", notes: notes.join("; "), ruleCondition: rule.ruleCondition || "" });

    if (APPLY && (engineChanged || treeChanged || needsActions)) {
      const $set = { engine };
      if (needsActions) $set.actions = [{ type: "create_alert", params: {} }];
      const $unset = {};
      if (treeChanged) {
        if (conditions) $set.conditions = conditions; else $unset.conditions = "";
        $set.logic = logic; // null clears it (schema default)
      }
      const update = { $set };
      if (Object.keys($unset).length) update.$unset = $unset;
      // runValidators so the new LEAF_FIELD_PATTERN check guards what we write
      await RuleEngine.updateOne({ _id: rule._id }, update, { runValidators: true });
      counts.updated++;
    }
  }

  const reportPath = path.resolve(__dirname, "../tmp/repair-conditions-report.csv");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const q = (s) => JSON.stringify(s || "");
  fs.writeFileSync(
    reportPath,
    ["ruleId,engine,category,notes,ruleCondition", ...report.map((r) => [r.ruleId, r.engine, r.category, q(r.notes), q(r.ruleCondition)].join(","))].join("\n")
  );

  console.log(`[repair] scanned=${rules.length} leafFixes=${counts.leavesFixed} treesCleared=${counts.treesCleared} actionsFilled=${counts.actionsFilled}`);
  console.log(`[repair] engine split:`, counts.engine);
  console.log(`[repair] ${APPLY ? "updated" : "would update"}=${APPLY ? counts.updated : report.filter((r) => r.notes).length}+engine stamps  report=${reportPath}`);
  if (!APPLY) console.log("[repair] nothing written — re-run with --apply.");
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[repair] failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
