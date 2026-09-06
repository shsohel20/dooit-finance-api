// seeds/backfill-alert-origin.js
//
// `Alert.alertOrigin` tells an auditor whether a rule or a model raised the
// alert. It has a schema default, but documents written before the field
// existed — or by a path that set it explicitly to null — carry no value, and
// the alert queue then shows a blank where the provenance should be
// (docs/74 C14; 1 such record in the sandbox as of 22 Aug 2026).
//
// The value is inferred, not guessed: an alert carrying a `ruleRef` was raised
// by the rule engine, so it is "Rule Based". Anything else is left alone and
// reported — a blank we cannot explain is better than a confident wrong label.
//
// Idempotent: only documents with a missing/null origin are touched.
//
// Usage:
//   node seeds/backfill-alert-origin.js            # dry-run (counts only)
//   node seeds/backfill-alert-origin.js --apply

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const Alert = require("../models/Alert");

const APPLY = process.argv.includes("--apply");

async function run() {
  console.log(`[alert-origin] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  await mongoose.connect(process.env.MONGO_URI);

  const missing = { alertOrigin: { $in: [null, ""] } };

  const [total, withRule] = await Promise.all([
    Alert.countDocuments(missing),
    Alert.countDocuments({ ...missing, ruleRef: { $ne: null } }),
  ]);
  const unexplained = total - withRule;

  if (APPLY && withRule > 0) {
    const res = await Alert.updateMany(
      { ...missing, ruleRef: { $ne: null } },
      { $set: { alertOrigin: "Rule Based" } }
    );
    console.log(`[alert-origin] set "Rule Based" on ${res.modifiedCount} alert(s)`);
  }

  console.log(
    `[alert-origin] missing=${total} inferable=${withRule} left-blank=${unexplained} ` +
      (APPLY ? "" : "(re-run with --apply)")
  );
  if (unexplained > 0) {
    console.log(
      `[alert-origin] ${unexplained} alert(s) have no ruleRef, so their origin cannot be inferred — set them by hand.`
    );
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[alert-origin] failed:", err.message);
  await mongoose.disconnect();
  process.exit(1);
});
