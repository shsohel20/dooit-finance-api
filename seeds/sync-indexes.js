// seeds/sync-indexes.js
//
// One-shot script to synchronize MongoDB indexes with the current schema definitions.
// Run this whenever you see Mongoose duplicate index warnings or after schema index changes.
//
// Usage:
//   node seeds/sync-indexes.js             # drop stale + create missing indexes
//   node seeds/sync-indexes.js --dry-run   # preview only

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");

const DRY_RUN = process.argv.includes("--dry-run");

const MODELS = [
  { name: "RuleEngine",        require: "../models/RuleEngine" },
  { name: "RiskFactorOption",  require: "../models/RiskFactorOption" },
  { name: "Transaction",       require: "../models/Transaction" },
  { name: "Alert",             require: "../models/Alert" },
  { name: "Case",              require: "../models/Case" },
  { name: "Customer",          require: "../models/Customer" },
];

async function run() {
  console.log(`[sync-indexes] connecting${DRY_RUN ? " (dry-run)" : ""}…`);
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[sync-indexes] connected\n");

  for (const entry of MODELS) {
    const Model = require(entry.require);
    const collectionName = Model.collection.collectionName;

    if (DRY_RUN) {
      console.log(`[${entry.name}] (dry-run) would syncIndexes on '${collectionName}'`);
      const schemaIndexes = Model.schema.indexes().map((i) => JSON.stringify(i[0]));
      console.log(`  schema indexes: ${schemaIndexes.join(", ")}`);
      continue;
    }

    try {
      const result = await Model.syncIndexes();
      const dropped = result.dropped?.length ?? 0;
      const created = typeof result === "object" ? JSON.stringify(result) : result;
      console.log(`[${entry.name}] syncIndexes on '${collectionName}': ${created}`);
    } catch (err) {
      console.error(`[${entry.name}] syncIndexes failed:`, err.message);
    }
  }

  console.log("\n[sync-indexes] done.");
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[sync-indexes] failed:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
