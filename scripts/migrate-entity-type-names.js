"use strict";

/**
 * Migration: strip "Tranche X - " prefix from EntityType names.
 *
 * Before: "Tranche 1 - Banks & ADIs"
 * After:  "Banks & ADIs"
 *
 * Only renames documents whose name contains " - ".
 * Safe to re-run — already-renamed documents are skipped.
 *
 * Run: node api/scripts/migrate-entity-type-names.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../config/config.env") });
const mongoose   = require("mongoose");
const EntityType = require("../models/EntityType");

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGO_URI found in config/config.env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB\n");

  const all = await EntityType.find({}).lean();
  let renamed = 0;
  let skipped = 0;

  for (const et of all) {
    if (!et.name.includes(" - ")) {
      console.log(`  ~  "${et.name}" — no prefix, skipped`);
      skipped++;
      continue;
    }

    const shortName = et.name.split(" - ").slice(1).join(" - ").trim();
    await EntityType.updateOne({ _id: et._id }, { $set: { name: shortName } });
    console.log(`  ✓  "${et.name}" → "${shortName}"`);
    renamed++;
  }

  console.log(`\nDone — ${renamed} renamed, ${skipped} already short-named.`);
  await mongoose.disconnect();
};

run().catch(e => {
  console.error(e);
  process.exit(1);
});
