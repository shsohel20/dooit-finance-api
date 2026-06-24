"use strict";

/**
 * Backfill: add matchKeywords to existing EntityType documents.
 *
 * Maps each EntityType by name pattern to a list of lowercase keywords.
 * Uses $addToSet so it is safe to re-run — never duplicates or overwrites
 * keywords already set by an admin.
 *
 * Run: node api/scripts/seed-entity-type-keywords.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../config/config.env") });
const mongoose   = require("mongoose");
const EntityType = require("../models/EntityType");

// name pattern → default keywords
const KEYWORD_MAP = [
  { pattern: /lawyer|conveyancer/i,            keywords: ["lawyer", "conveyancer", "law firm", "solicitor"] },
  { pattern: /accountant/i,                    keywords: ["accountant", "accounting", "cpa", "tax agent", "bookkeeper"] },
  { pattern: /real.?estate/i,                  keywords: ["real estate", "property", "realestate", "agent", "conveyancing"] },
  { pattern: /precious.?metal|jewel/i,         keywords: ["precious metal", "jeweller", "jeweler", "gold", "silver", "bullion"] },
  { pattern: /tcsp|trust.*company/i,           keywords: ["tcsp", "trust company", "trust service", "company formation"] },
  { pattern: /bank|adi/i,                      keywords: ["bank", "adi", "credit union", "financial institution", "financial", "building society", "mutual bank"] },
  { pattern: /remittance|money.?transfer/i,    keywords: ["remittance", "money transfer", "forex", "foreign exchange", "wire transfer"] },
  { pattern: /vasp|dcep|crypto|digital.?asset/i, keywords: ["vasp", "crypto", "cryptocurrency", "dcep", "digital asset", "nft", "exchange", "defi"] },
  { pattern: /gambl|casino/i,                  keywords: ["gambling", "casino", "betting", "wagering", "lottery"] },
  { pattern: /insurance/i,                     keywords: ["insurance", "insurer", "underwriter", "life insurance", "general insurance"] },
];

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGO_URI found in config/config.env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB\n");

  const allTypes = await EntityType.find({}).lean();
  if (allTypes.length === 0) {
    console.log("No EntityType documents found — nothing to backfill.");
    await mongoose.disconnect();
    return;
  }

  let updated = 0;
  let skipped = 0;

  for (const et of allTypes) {
    const entry = KEYWORD_MAP.find(m => m.pattern.test(et.name));
    if (!entry) {
      console.log(`  -- "${et.name}" — no keyword mapping, skipped`);
      skipped++;
      continue;
    }

    const result = await EntityType.updateOne(
      { _id: et._id },
      { $addToSet: { matchKeywords: { $each: entry.keywords } } }
    );

    const changed = result.modifiedCount > 0;
    console.log(`  ${changed ? "✓" : "~"} "${et.name}" → [${entry.keywords.join(", ")}]${changed ? "" : " (already set)"}`);
    updated++;
  }

  console.log(`\nDone — ${updated} records updated/confirmed, ${skipped} skipped (no mapping).`);
  await mongoose.disconnect();
};

run().catch(e => {
  console.error(e);
  process.exit(1);
});
