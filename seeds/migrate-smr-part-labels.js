/**
 * migrate-smr-part-labels.js — align seeded SMR Part A/G values with the form
 *
 * Parts A and G of the AUSTRAC suspicious matter report are checklists against
 * fixed option lists (ui/components/smr-parts/options.js). Earlier seed runs
 * wrote monitoring-engine vocabulary ("rapid-movement") and shorthand service
 * names ("Item 1 - account and deposit taking") into those fields. A value that
 * is not on the list renders as an unticked box, so the recorded reason
 * effectively disappears from the report.
 *
 * Only documents this seeder wrote are touched (uid contains "SEED").
 *
 * Usage (from api/):
 *   node seeds/migrate-smr-part-labels.js --dry-run          preview, no writes
 *   node seeds/migrate-smr-part-labels.js                    every seeded SMR
 *   node seeds/migrate-smr-part-labels.js --client=<id>      one tenant only
 */
require("dotenv").config({ path: "./config/config.env" });
require("colors");

const mongoose = require("mongoose");
const SMR = require("../models/SmrReport");

const DRY_RUN = process.argv.includes("--dry-run");
const CLIENT = (process.argv.find((a) => a.startsWith("--client=")) || "").split("=")[1];

// Mirrors ui/components/smr-parts/options.js.
const DESIGNATED_SERVICES = [
  "Account/deposit taking services",
  "Currency exchange services",
];

const REASON_BY_FLAG = {
  structuring: "Avoiding reporting obligations",
  "threshold-avoidance": "Avoiding reporting obligations",
  "high-value": "Unusually large transfer",
  "cash-intensive": "Unusual use/exchange of cash",
  "high-risk-jurisdiction": "Country/jurisdiction risk",
  "rapid-movement": "Unusual account activity",
  "unusual-pattern": "Inconsistent with customer profile",
};

// Prose offence wording → the listed statutory offence. "None identified"
// deliberately maps to nothing: a resolved matter ticks no offence.
const OFFENCE_BY_PROSE = {
  "money laundering": "Money laundering",
  "proceeds of crime": "Proceeds of crime",
  "terrorism financing": "Financing of terrorism",
  "financing of terrorism": "Financing of terrorism",
  fraud: "Offence against a Commonwealth, State or Territory law",
  "tax evasion": "Tax evasion",
};

const OFFENCE_TYPES = new Set(Object.values(OFFENCE_BY_PROSE));

const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const filter = { uid: /SEED/ };
  if (CLIENT) {
    if (!mongoose.Types.ObjectId.isValid(CLIENT)) {
      throw new Error(`--client is not a valid ObjectId: ${CLIENT}`);
    }
    filter.client = new mongoose.Types.ObjectId(CLIENT);
  }

  const reports = await SMR.find(filter).select("_id uid partA partG").lean();
  console.log(
    `\n  Seeded SMRs ${CLIENT ? `for client ${CLIENT}` : "(all tenants)"}: ${reports.length}` +
      `${DRY_RUN ? "   (dry run — nothing written)" : ""}`
  );

  let touched = 0;
  const samples = [];

  for (const r of reports) {
    const beforeReasons = r.partA?.suspicionReasons || [];
    const beforeOffence = r.partG?.likelyOffence || [];

    const reasons = uniq(beforeReasons.map((f) => REASON_BY_FLAG[f] ?? f));
    const suspicionReasons = reasons.length ? reasons : ["Inconsistent with customer profile"];

    // Already-canonical values pass through untouched; prose maps across;
    // anything unrecognised is dropped rather than left to render unticked.
    const likelyOffence = uniq(
      beforeOffence.map((o) =>
        OFFENCE_TYPES.has(o) ? o : OFFENCE_BY_PROSE[String(o).trim().toLowerCase()]
      )
    );

    if (!DRY_RUN) {
      await SMR.updateOne(
        { _id: r._id },
        {
          $set: {
            "partA.designatedServices": DESIGNATED_SERVICES,
            "partA.suspicionReasons": suspicionReasons,
            "partG.likelyOffence": likelyOffence,
          },
        }
      );
    }

    if (samples.length < 5) {
      samples.push({ uid: r.uid, beforeReasons, suspicionReasons, beforeOffence, likelyOffence });
    }
    touched += 1;
  }

  console.log(`  Updated: ${touched}\n`);
  console.log("  Sample:");
  for (const s of samples) {
    console.log(`    ${s.uid}`);
    console.log(`      reasons  ${JSON.stringify(s.beforeReasons)} → ${JSON.stringify(s.suspicionReasons)}`);
    console.log(`      offence  ${JSON.stringify(s.beforeOffence)} → ${JSON.stringify(s.likelyOffence)}`);
  }

  await mongoose.disconnect();
  console.log("\n  Done.\n");
}

main().catch(async (err) => {
  console.error("\n  Migration failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
