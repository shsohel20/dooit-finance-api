// scripts/repair-clientrule-mojibake.js
//
// Phase 1 of ClientRule data quality work.
//
// Repairs CP1252-decoded UTF-8 mojibake observed in the `ruleCondition`
// field. Examples found in production data:
//
//   "Document uploaded between 00:00â03:00"          → 00:00–03:00
//   "Sender institution country â  sender country"   → Sender ... ≠ sender ...
//   "Beneficiary name contains â¥3 consecutive…"     → ≥3
//   "Pattern of small investments â fake returns"    → → (arrow)
//   "$9,000â9,999"                                   → $9,000–9,999
//
// Strategy: pattern-based replacement, ordered most-specific → most-generic.
// We do NOT attempt algorithmic Latin1↔UTF-8 round-trip because the data was
// mangled inconsistently — some bytes have been dropped along the way.
//
// Usage:
//   node seeds/repair-clientrule-mojibake.js              # dry-run, writes CSV report
//   node seeds/repair-clientrule-mojibake.js --apply      # writes the repairs

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const ClientRule = require("../models/RuleEngine"); // model renamed; collection is still `clientrules`

const APPLY = process.argv.includes("--apply");

// Order matters: most-specific patterns first.
const REPLACEMENTS = [
  // ≠  (≠ between two phrases — "country â  country")
  { name: "not-equal (≠)", from: /\bâ\s{1,2}/g, to: "≠ " },

  // ≥  ("contains â¥3")
  { name: "greater-or-equal (≥)", from: /â¥/g, to: "≥" },

  // ≤
  { name: "less-or-equal (≤)", from: /â¤/g, to: "≤" },

  // → arrow used in chains: "A â B â C" → "A → B → C"
  { name: "arrow (→)", from: /\sâ\s/g, to: " → " },

  // en-dash in numeric ranges: "00:00â03:00", "$9,000â9,999"
  { name: "numeric range (–)", from: /(\d)â(\d)/g, to: "$1–$2" },

  // Lingering stray "â" with nothing recoverable next to it. We strip it
  // rather than guess. Run last.
  { name: "stray (removed)", from: /â/g, to: "" },
];

async function run() {
  console.log(`[repair-mojibake] connecting… mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  await mongoose.connect(process.env.MONGO_URI);

  const changes = [];
  let scanned = 0;
  const cursor = ClientRule.find({}, { ruleId: 1, ruleCondition: 1 }).cursor();

  for await (const doc of cursor) {
    scanned++;
    const original = doc.ruleCondition || "";
    if (!original.includes("â")) continue; // fast-path: nothing to do

    let repaired = original;
    const applied = [];
    for (const r of REPLACEMENTS) {
      if (r.from.test(repaired)) {
        repaired = repaired.replace(r.from, r.to);
        applied.push(r.name);
      }
    }

    if (repaired !== original) {
      changes.push({
        _id: doc._id.toString(),
        ruleId: doc.ruleId,
        original,
        repaired,
        applied: applied.join("; "),
      });
      if (APPLY) {
        await ClientRule.updateOne(
          { _id: doc._id },
          { $set: { ruleCondition: repaired } }
        );
      }
    }
  }

  // Write CSV report
  const reportPath = path.resolve(__dirname, "../tmp/mojibake-report.csv");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const csvLines = [
    "ruleId,_id,applied,original,repaired",
    ...changes.map((c) =>
      [
        c.ruleId,
        c._id,
        JSON.stringify(c.applied),
        JSON.stringify(c.original),
        JSON.stringify(c.repaired),
      ].join(",")
    ),
  ];
  fs.writeFileSync(reportPath, csvLines.join("\n"));

  console.log(
    `[repair-mojibake] scanned=${scanned} changed=${changes.length} report=${reportPath}`
  );
  if (!APPLY) {
    console.log(
      "[repair-mojibake] DRY-RUN only — review the CSV, then re-run with --apply."
    );
  }
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[repair-mojibake] failed:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
