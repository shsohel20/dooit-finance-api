// scripts/categorize-clientrules.js
//
// Phase 2 of ClientRule data quality work.
//
// Tags every ClientRule with a `category` value so the engine and downstream
// parsers know how to handle each rule's `ruleCondition`. The current corpus
// mixes four distinct DSL families:
//
//   dsl-natural        — operator-style natural language
//                        e.g. "Account open days < 30 AND amount > 50,000"
//
//   dsl-dotted         — namespaced expression (Sardine-style FRD-* rules)
//                        e.g. "Device.OrientationState.FaceUp == 100"
//
//   external-screening — prose describing a list/registry/sanctions match;
//                        the real "logic" lives outside the DB.
//                        e.g. "Direct match with UNSC sanctions list"
//
//   behavioral-pattern — multi-step / temporal narrative; needs hand-crafted
//                        detection logic, not a parsed predicate.
//                        e.g. "Pattern of small investments → fake returns →
//                              large final payment"
//
//   ambiguous          — couldn't classify confidently; flag for review.
//
// Usage:
//   node seeds/categorize-clientrules.js              # dry-run + CSV report
//   node seeds/categorize-clientrules.js --apply      # writes `category` field
//
// Re-run safely after Phase 1 (mojibake repair) for cleanest classification.

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const ClientRule = require("../models/RuleEngine"); // model renamed; collection is still `clientrules`

const APPLY = process.argv.includes("--apply");

// ── Heuristic patterns ───────────────────────────────────────────────────────
const DOTTED_PREFIX = /\b(Device|Email|Phone|IP|TrueIP|TrueLocation|Session|User|Biometric|Transaction|PaymentMethod|GPS|CustomerSession|Recipient)\.[A-Z][A-Za-z0-9]*/;

const SCREENING = new RegExp(
  [
    "match(?:ed)? with",
    "on .* (?:list|register|watchlist|blacklist)",
    "\\bsanctions?\\b",
    "\\bOFAC\\b",
    "\\bUNSC\\b",
    "\\bBFIU\\b",
    "\\bFATF\\b",
    "\\bSDN\\b",
    "\\bcircular\\b",
    "consolidated list",
    "sanctioned (?:list|target|region|country|currency)",
    "\\bidentified as\\b",
    "\\b(?:foreign|domestic) PEP\\b",
    "adverse media",
  ].join("|"),
  "i"
);

const BEHAVIORAL = new RegExp(
  [
    "pattern of",
    "followed by",
    "sequence of",
    "cascading",
    "consolidation",
    "funnel",
    "rapid(?:ly)?",
    "burst",
    "\\bwash\\b",
    "hopping",
    "pig butchering",
    "romance scam",
    "(?:account )?takeover",
    "\\bmule\\b",
    "structuring",
    "round.?tripping",
    "layering",
    "circular funds",
    "immediately (?:sent|cashed)",
    "(?:before|after) (?:transaction|tx|withdrawal)",
  ].join("|"),
  "i"
);

const NARRATIVE_KYC = /^\s*(?:Customer|Client) (?:identified|requests?|establishes?|approaches|states?|attempts?|unable|unwilling|asks?|purchases?|supplies)\b/i;

const OPERATOR_TOKENS = /[<>]=?|==|!=|\s=\s|=\s*"|\bAND\b|\bOR\b|\bin\s*\[/;

// ── Classifier ───────────────────────────────────────────────────────────────
function classify(rawText = "") {
  const text = (rawText || "").trim();
  if (!text) return "ambiguous";

  // Dotted-path always wins. The Sardine / FRD-* rules are unambiguous.
  if (DOTTED_PREFIX.test(text)) return "dsl-dotted";

  const hasOperator = OPERATOR_TOKENS.test(text);
  const isScreening = SCREENING.test(text);
  const isBehavioral = BEHAVIORAL.test(text);

  // Pure prose → external screening (most likely a list/PEP/sanctions match)
  if (isScreening && !hasOperator) return "external-screening";

  // Multi-step narrative → behavioral
  if (isBehavioral && !hasOperator) return "behavioral-pattern";

  // Has comparators / boolean glue → parseable natural-language DSL
  if (hasOperator) return "dsl-natural";

  // KYC narrative ("Customer requests / establishes …") — treat as screening
  if (NARRATIVE_KYC.test(text)) return "external-screening";

  return "ambiguous";
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function run() {
  console.log(`[categorize] connecting… mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  await mongoose.connect(process.env.MONGO_URI);

  const counts = {};
  const rows = [];
  const cursor = ClientRule.find({}, { ruleId: 1, ruleCondition: 1, category: 1 }).cursor();

  let scanned = 0;
  let updated = 0;
  for await (const doc of cursor) {
    scanned++;
    const next = classify(doc.ruleCondition);
    counts[next] = (counts[next] || 0) + 1;
    rows.push({
      ruleId: doc.ruleId,
      previous: doc.category || "",
      next,
      ruleCondition: doc.ruleCondition || "",
    });
    if (APPLY && doc.category !== next) {
      await ClientRule.updateOne({ _id: doc._id }, { $set: { category: next } });
      updated++;
    }
  }

  // CSV report — always written, even in apply mode (for audit trail)
  const reportPath = path.resolve(__dirname, "../tmp/category-report.csv");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const csv = [
    "ruleId,previous,next,ruleCondition",
    ...rows.map((r) =>
      [r.ruleId, r.previous, r.next, JSON.stringify(r.ruleCondition)].join(",")
    ),
  ].join("\n");
  fs.writeFileSync(reportPath, csv);

  console.log("[categorize] counts:", counts);
  console.log(`[categorize] scanned=${scanned} updated=${updated} report=${reportPath}`);
  if (!APPLY) {
    console.log(
      "[categorize] DRY-RUN only — eyeball the CSV, especially the `ambiguous` rows, then re-run with --apply."
    );
  }
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[categorize] failed:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
