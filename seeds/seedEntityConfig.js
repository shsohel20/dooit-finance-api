"use strict";

/**
 * Seeds EntityConfig documents into the `entityconfigs` collection.
 * Data source: api/data/riskPoolSeed.js  (ENTITY_CONFIG_SEED)
 * Safe to re-run — uses upsert; existing records are not overwritten.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../config/config.env") });
const mongoose = require("mongoose");
const EntityConfig = require("../models/EntityConfig");
const { ENTITY_CONFIG_SEED } = require("../data/riskPoolSeed");

async function seed() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("No MONGO_URI found"); process.exit(1); }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const ops = ENTITY_CONFIG_SEED.map((cfg) => ({
    updateOne: {
      filter: { entityType: cfg.entityType },
      update: { $setOnInsert: cfg },
      upsert: true,
    },
  }));

  const result = await EntityConfig.bulkWrite(ops, { ordered: false });
  console.log(`Entity config seeded: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);

  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
