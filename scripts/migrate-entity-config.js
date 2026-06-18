"use strict";

/**
 * Migration: drop legacy `entity_config` collection.
 *
 * The old `entity_config` collection was a pivot-table structure
 * (one document per config_field, entity types as column keys).
 * It has been superseded by the `entityconfigs` collection, backed by
 * the EntityConfig Mongoose model (one document per entity type).
 *
 * This script verifies `entityconfigs` has data, then drops `entity_config`.
 * Safe to re-run — exits cleanly if `entity_config` is already gone.
 *
 * Run: node api/scripts/migrate-entity-config.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../config/config.env") });
const mongoose = require("mongoose");
const EntityConfig = require("../models/EntityConfig");
const { ENTITY_CONFIG_SEED } = require("../data/riskPoolSeed");

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGO_URI found in config/config.env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  // 1. Ensure entityconfigs is populated
  const count = await EntityConfig.countDocuments();
  if (count === 0) {
    console.log("entityconfigs is empty — seeding from ENTITY_CONFIG_SEED…");
    const ops = ENTITY_CONFIG_SEED.map((cfg) => ({
      updateOne: {
        filter: { entityType: cfg.entityType },
        update: { $setOnInsert: cfg },
        upsert: true,
      },
    }));
    const result = await EntityConfig.bulkWrite(ops, { ordered: false });
    console.log(`  Seeded ${result.upsertedCount} entity configs into entityconfigs.`);
  } else {
    console.log(`entityconfigs already has ${count} documents — no seed needed.`);
  }

  // 2. Drop the old pivot collection
  const collections = await db.listCollections({ name: "entity_config" }, { nameOnly: true }).toArray();
  if (collections.length === 0) {
    console.log("entity_config collection does not exist — nothing to drop.");
  } else {
    await db.collection("entity_config").drop();
    console.log("Dropped collection: entity_config");
  }

  await mongoose.disconnect();
  console.log("\nMigration complete.");
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
