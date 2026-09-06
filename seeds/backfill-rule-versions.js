// seeds/backfill-rule-versions.js
//
// One-off baseline for RuleEngineVersion. Rules that existed before the
// version-history hooks (21 Aug 2026) have no snapshot for their current
// `version`; this records one per rule so an auditor can resolve
// Alert.ruleVersion → snapshot for every rule, not only ones edited later.
//
// Idempotent: RuleEngineVersion.record() is a no-op for an existing
// (rule, version) pair, so re-running never duplicates.
//
// Usage:
//   node seeds/backfill-rule-versions.js            # dry-run (counts only)
//   node seeds/backfill-rule-versions.js --apply

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const RuleEngine = require("../models/RuleEngine");
const RuleEngineVersion = require("../models/RuleEngineVersion");

const APPLY = process.argv.includes("--apply");

async function run() {
  console.log(`[versions] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  await mongoose.connect(process.env.MONGO_URI);

  const rules = await RuleEngine.find({}).lean();
  let missing = 0;
  let written = 0;

  for (const rule of rules) {
    const exists = await RuleEngineVersion.exists({ rule: rule._id, version: rule.version });
    if (exists) continue;
    missing++;
    if (APPLY) {
      const rec = await RuleEngineVersion.record(rule, { changedPaths: [] });
      if (rec) written++;
    }
  }

  console.log(`[versions] rules=${rules.length} without-snapshot=${missing} ${APPLY ? `written=${written}` : "(re-run with --apply)"}`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[versions] failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
