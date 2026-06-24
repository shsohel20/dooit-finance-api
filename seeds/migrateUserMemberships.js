"use strict";
/**
 * migrateUserMemberships.js  —  one-time idempotent backfill
 *
 * Reads legacy scalar fields (role, userType, clientBelongs, branchBelongs)
 * stored on raw User documents in MongoDB and upserts a UserType membership row
 * for each. Safe to re-run: uses findOneAndUpdate+upsert on the compound unique
 * index so duplicates are never created.
 *
 * Run standalone:
 *   node api/seeds/migrateUserMemberships.js
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });

const mongoose = require("mongoose");
require("colors");

const User     = require("../models/User");
const UserType = require("../models/UserType");
const Role     = require("../models/Role");

async function migrateUserMemberships() {
  // Native collection cursor — Mongoose strips legacy fields not in the schema,
  // but those raw values (role, userType, clientBelongs, branchBelongs) are still
  // present in MongoDB documents from before Phase 5 cleanup.
  const cursor = User.collection.find(
    {},
    { projection: { role: 1, userType: 1, clientBelongs: 1, branchBelongs: 1, isActive: 1 } }
  );

  // Cache role ID lookups so we don't hit the DB for every user.
  const roleCache = {};
  async function getRoleId(name) {
    const key = (name || "user").toLowerCase();
    if (roleCache[key] !== undefined) return roleCache[key];
    const doc = await Role.findOne({ name: new RegExp(`^${key}$`, "i") }).select("_id").lean();
    roleCache[key] = doc?._id ?? null;
    return roleCache[key];
  }

  let processed = 0;
  let upserted  = 0;
  let skipped   = 0;
  let errors    = 0;

  for await (const u of cursor) {
    const roleName      = ((u.role || "user") + "").toLowerCase();
    const userType      = u.userType  || "user";
    const clientBelongs = u.clientBelongs  ?? null;
    const branchBelongs = u.branchBelongs  ?? null;
    const roleId        = await getRoleId(roleName);

    try {
      const result = await UserType.collection.findOneAndUpdate(
        { user: u._id, userType, role: roleName, clientBelongs, branchBelongs },
        {
          $setOnInsert: {
            user: u._id,
            userType,
            role:         roleName,
            roleId:       roleId   ?? null,
            clientBelongs,
            branchBelongs,
            isActive:     u.isActive !== false,
            assignedBy:   null,
            createdAt:    new Date(),
            updatedAt:    new Date(),
          },
        },
        { upsert: true, returnDocument: "after" }
      );
      // lastErrorObject.updatedExisting === false → inserted (upsert); true → already existed
      if (result?.lastErrorObject?.updatedExisting === false) {
        upserted++;
      } else {
        skipped++;
      }
    } catch (err) {
      if (err.code === 11000) {
        // Duplicate key — row already exists via another path (Mongoose upsert race).
        skipped++;
      } else {
        console.error(`  ✗ user ${u._id}: ${err.message}`.red);
        errors++;
      }
    }
    processed++;
  }

  return { processed, upserted, skipped, errors };
}

module.exports = migrateUserMemberships;

// ── Standalone runner ────────────────────────────────────────────────────────
if (require.main === module) {
  if (!process.env.MONGO_URI) {
    console.error("✗ MONGO_URI not set in config/config.env".red);
    process.exit(1);
  }

  (async () => {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`Connected to MongoDB`.gray);
    console.log(`Target: ${process.env.MONGO_URI.replace(/\/\/[^@]*@/, "//****@")}`.gray);
    console.log("\nRunning migrateUserMemberships backfill...\n".cyan);

    const { processed, upserted, skipped, errors } = await migrateUserMemberships();

    console.log("Done.".green.bold);
    console.log(`  Users scanned     : ${processed}`.gray);
    console.log(`  Memberships added : ${upserted}`.gray);
    console.log(`  Already existed   : ${skipped}`.gray);
    console.log(`  Errors            : ${errors}${errors ? " ✗" : " ✓"}`.gray);

    await mongoose.disconnect();
    process.exit(errors ? 1 : 0);
  })().catch((err) => {
    console.error("\n✗ Migration failed:".red, err.message);
    process.exit(1);
  });
}
