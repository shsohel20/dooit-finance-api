// scripts/migrate-clientrule-schema.js
//
// Migrates the ClientRule collection to the new schema shape:
//   1. Drop the legacy global unique index on `ruleId` (`ruleId_1`).
//   2. Build the new tenant-scoped unique index on `{ client, ruleId }`.
//   3. Backfill defaults on existing rows for the new optional fields
//      (`status`, `appliesTo`, `version`, `actions`, `hitCount`, …) so
//      the DB matches what Mongoose returns on read.
//   4. Report any cross-tenant `ruleId` collisions that would block the
//      new unique index from building, so they can be fixed first.
//
// Idempotent — safe to re-run.
//
// Usage:
//   node seeds/migrate-clientrule-schema.js
//   node seeds/migrate-clientrule-schema.js --dry-run

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const ClientRule = require("../models/RuleEngine"); // model renamed; collection is still `clientrules`

const DRY_RUN = process.argv.includes("--dry-run");

async function run() {
  console.log(`[migrate-clientrule] connecting to MongoDB${DRY_RUN ? " (dry-run)" : ""}…`);
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[migrate-clientrule] connected");

  const coll = ClientRule.collection;

  // ───────────────────────────────────────────────────────────────────────────
  // Step 1: detect cross-tenant collisions on (client, ruleId)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[1/4] checking for (client, ruleId) duplicates…");
  const dupes = await coll
    .aggregate([
      { $group: { _id: { client: "$client", ruleId: "$ruleId" }, n: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  if (dupes.length > 0) {
    console.error(
      `[migrate-clientrule] ❌ Found ${dupes.length} duplicate (client, ruleId) groups. ` +
        `The new unique index cannot be built until these are resolved:`
    );
    dupes.forEach((d) =>
      console.error(
        `  client=${d._id.client} ruleId=${d._id.ruleId} → ${d.n} docs (_ids: ${d.ids.join(", ")})`
      )
    );
    console.error("[migrate-clientrule] aborting. Fix the duplicates and re-run.");
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log("[1/4] ✓ no duplicates");

  // ───────────────────────────────────────────────────────────────────────────
  // Step 2: drop the legacy global unique index `ruleId_1`
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[2/4] dropping legacy global unique index on ruleId…");
  const indexes = await coll.indexes();
  const legacy = indexes.find(
    (ix) =>
      ix.name === "ruleId_1" ||
      (ix.unique && ix.key && Object.keys(ix.key).length === 1 && ix.key.ruleId === 1)
  );
  if (legacy) {
    if (DRY_RUN) {
      console.log(`[2/4] (dry-run) would drop index '${legacy.name}'`);
    } else {
      await coll.dropIndex(legacy.name);
      console.log(`[2/4] ✓ dropped '${legacy.name}'`);
    }
  } else {
    console.log("[2/4] ✓ no legacy global unique index found (already migrated?)");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Step 3: backfill defaults for new optional fields
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[3/4] backfilling defaults on existing rows…");
  const backfillFilter = {
    $or: [
      { status: { $exists: false } },
      { appliesTo: { $exists: false } },
      { version: { $exists: false } },
      { hitCount: { $exists: false } },
      { actions: { $exists: false } },
      { deletedAt: { $exists: false } },
    ],
  };

  const toBackfill = await coll.countDocuments(backfillFilter);
  if (toBackfill === 0) {
    console.log("[3/4] ✓ nothing to backfill");
  } else if (DRY_RUN) {
    console.log(`[3/4] (dry-run) would backfill ${toBackfill} document(s)`);
  } else {
    const res = await coll.updateMany(backfillFilter, [
      {
        $set: {
          status: { $ifNull: ["$status", "active"] },
          appliesTo: { $ifNull: ["$appliesTo", "transaction"] },
          version: { $ifNull: ["$version", 1] },
          hitCount: { $ifNull: ["$hitCount", 0] },
          actions: { $ifNull: ["$actions", []] },
          deletedAt: { $ifNull: ["$deletedAt", null] },
          effectiveFrom: { $ifNull: ["$effectiveFrom", null] },
          effectiveTo: { $ifNull: ["$effectiveTo", null] },
          lastFiredAt: { $ifNull: ["$lastFiredAt", null] },
          createdBy: { $ifNull: ["$createdBy", null] },
          updatedBy: { $ifNull: ["$updatedBy", null] },
        },
      },
    ]);
    console.log(`[3/4] ✓ backfilled ${res.modifiedCount}/${toBackfill} document(s)`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Step 4: build the new compound unique index
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[4/4] ensuring compound unique index { client, ruleId }…");
  if (DRY_RUN) {
    console.log("[4/4] (dry-run) would call ClientRule.syncIndexes()");
  } else {
    // syncIndexes builds any indexes declared on the schema that aren't on the
    // collection yet, and drops indexes on the collection that aren't on the
    // schema. The legacy `ruleId_1` was already dropped in step 2.
    const result = await ClientRule.syncIndexes();
    console.log("[4/4] ✓ syncIndexes result:", result);
  }

  console.log("\n[migrate-clientrule] done.");
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[migrate-clientrule] failed:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
