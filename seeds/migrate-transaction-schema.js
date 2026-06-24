// seeds/migrate-transaction-schema.js
//
// Migrates the `transactions` collection to the updated schema shape.
//
// CHANGES APPLIED:
//   T1. Move top-level `customer` (ObjectId) into the correct party sub-doc:
//         - type "transfer"   → sender.customer  (sender is the primary party)
//         - type "deposit"    → receiver.customer (receiver is the primary party)
//         - type "withdrawal" → sender.customer
//         - type "exchange" / "other" / unknown → sender.customer (fallback)
//       Only sets the nested field when it is not already populated.
//       Then removes the top-level `customer` field.
//
//   T2. Backfill new top-level field defaults:
//         - uid               : "TXN_<timestamp>" if missing
//         - relatedPartyTxnId : ""    (String, default "")
//         - relatedPartyFlag  : false (Boolean, default false)
//         - travelRule        : {}    (embedded sub-doc, default {})
//         - investigation     : {}    (embedded sub-doc, default {})
//         - riskScore         : 0
//         - riskFlags         : []
//         - forensic          : {}
//
//   T3. Sync indexes via Mongoose model.
//
// Idempotent — safe to re-run.
//
// Usage:
//   node seeds/migrate-transaction-schema.js
//   node seeds/migrate-transaction-schema.js --dry-run

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");

const DRY_RUN = process.argv.includes("--dry-run");

const log  = (...a) => console.log("[migrate]  ", ...a);
const warn = (...a) => console.warn("[migrate] ⚠", ...a);
const ok   = (...a) => console.log("[migrate] ✓", ...a);
const fail = (...a) => console.error("[migrate] ✗", ...a);

// ─────────────────────────────────────────────────────────────────────────────
// T1 — move top-level customer → party sub-doc
// ─────────────────────────────────────────────────────────────────────────────
async function migrateCustomerField(coll) {
  log("\n══════════════════════════════════════════");
  log(" T1  top-level customer → party sub-doc");
  log("══════════════════════════════════════════");

  const filter = { customer: { $exists: true } };
  const total  = await coll.countDocuments(filter);
  log(`     ${total} document(s) still carry a top-level \`customer\` field`);

  if (total === 0) {
    ok("     nothing to migrate");
    return;
  }

  if (DRY_RUN) {
    warn(`     (dry-run) would migrate ${total} document(s)`);
    return;
  }

  // For "deposit" → put customer into receiver.customer
  // For everything else (transfer, withdrawal, exchange, other, missing) → sender.customer
  // We only overwrite the nested field when it is currently unset / null.

  // Step T1-a: deposit — customer → receiver.customer
  const depositFilter = {
    customer: { $exists: true },
    type: "deposit",
    $or: [
      { "receiver.customer": { $exists: false } },
      { "receiver.customer": null },
    ],
  };
  const depositCount = await coll.countDocuments(depositFilter);
  log(`\n  T1a: deposit — ${depositCount} doc(s) need receiver.customer set`);
  if (depositCount > 0) {
    const res = await coll.updateMany(depositFilter, [
      { $set: { "receiver.customer": "$customer" } },
    ]);
    ok(`       updated ${res.modifiedCount} document(s)`);
  }

  // Step T1-b: non-deposit — customer → sender.customer
  const senderFilter = {
    customer: { $exists: true },
    type: { $ne: "deposit" },
    $or: [
      { "sender.customer": { $exists: false } },
      { "sender.customer": null },
    ],
  };
  const senderCount = await coll.countDocuments(senderFilter);
  log(`\n  T1b: non-deposit — ${senderCount} doc(s) need sender.customer set`);
  if (senderCount > 0) {
    const res = await coll.updateMany(senderFilter, [
      { $set: { "sender.customer": "$customer" } },
    ]);
    ok(`       updated ${res.modifiedCount} document(s)`);
  }

  // Step T1-c: remove the top-level customer field from all affected docs
  log(`\n  T1c: removing top-level \`customer\` field from ${total} document(s)`);
  const removeRes = await coll.updateMany(filter, { $unset: { customer: "" } });
  ok(`       unset on ${removeRes.modifiedCount} document(s)`);

  ok("\n  T1 complete.");
}

// ─────────────────────────────────────────────────────────────────────────────
// T2 — backfill new field defaults
// ─────────────────────────────────────────────────────────────────────────────
async function backfillDefaults(coll) {
  log("\n══════════════════════════════════════════");
  log(" T2  backfill new field defaults");
  log("══════════════════════════════════════════");

  // uid — must be unique; generate per-document via cursor if missing
  log("\n  T2a: uid — backfill missing values");
  const missingUid = await coll.countDocuments({ uid: { $exists: false } });
  log(`       ${missingUid} document(s) are missing uid`);

  if (missingUid > 0) {
    if (DRY_RUN) {
      warn("       (dry-run) would set uid on missing docs");
    } else {
      const cursor = coll.find({ uid: { $exists: false } });
      let uidCount = 0;
      for await (const doc of cursor) {
        const uid = `TXN_${doc._id.toHexString().slice(-8).toUpperCase()}_${Date.now()}`;
        await coll.updateOne({ _id: doc._id }, { $set: { uid } });
        uidCount++;
      }
      ok(`       backfilled uid on ${uidCount} document(s)`);
    }
  } else {
    ok("       all docs have uid — skipping");
  }

  // scalar / object defaults — safe to do in one bulk update
  const bulkFilter = {
    $or: [
      { relatedPartyTxnId: { $exists: false } },
      { relatedPartyFlag:  { $exists: false } },
      { travelRule:        { $exists: false } },
      { investigation:     { $exists: false } },
      { riskScore:         { $exists: false } },
      { riskFlags:         { $exists: false } },
      { forensic:          { $exists: false } },
    ],
  };

  const bulkCount = await coll.countDocuments(bulkFilter);
  log(`\n  T2b: ${bulkCount} document(s) need field defaults backfilled`);

  if (bulkCount > 0) {
    if (DRY_RUN) {
      warn(`       (dry-run) would backfill ${bulkCount} document(s)`);
    } else {
      const res = await coll.updateMany(bulkFilter, [
        {
          $set: {
            relatedPartyTxnId: { $ifNull: ["$relatedPartyTxnId", ""] },
            relatedPartyFlag:  { $ifNull: ["$relatedPartyFlag",  false] },
            travelRule:        { $ifNull: ["$travelRule",        {}] },
            investigation:     { $ifNull: ["$investigation",     {}] },
            riskScore:         { $ifNull: ["$riskScore",         0] },
            riskFlags:         { $ifNull: ["$riskFlags",         []] },
            forensic:          { $ifNull: ["$forensic",          {}] },
          },
        },
      ]);
      ok(`       backfilled ${res.modifiedCount} document(s)`);
    }
  } else {
    ok("       nothing to backfill");
  }

  ok("\n  T2 complete.");

  // T2c — backfill investigation sub-doc field defaults
  // investigation: {} was already set above, but the inner fields
  // (flagged, caseId, investigatorNotes) may still be missing.
  log("\n  T2c: backfilling investigation sub-doc field defaults…");
  const subFilter = {
    $or: [
      { "investigation.flagged":           { $exists: false } },
      { "investigation.caseId":            { $exists: false } },
      { "investigation.investigatorNotes": { $exists: false } },
    ],
  };
  const subCount = await coll.countDocuments(subFilter);
  log(`       ${subCount} document(s) need investigation sub-fields backfilled`);
  if (subCount > 0) {
    if (DRY_RUN) {
      warn(`       (dry-run) would backfill ${subCount} document(s)`);
    } else {
      const res = await coll.updateMany(subFilter, [
        {
          $set: {
            "investigation.flagged":           { $ifNull: ["$investigation.flagged",           false] },
            "investigation.caseId":            { $ifNull: ["$investigation.caseId",            null] },
            "investigation.investigatorNotes": { $ifNull: ["$investigation.investigatorNotes", null] },
          },
        },
      ]);
      ok(`       backfilled ${res.modifiedCount} document(s)`);
    }
  } else {
    ok("       nothing to backfill");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// T3 — sync indexes
// ─────────────────────────────────────────────────────────────────────────────
async function syncIndexes() {
  log("\n══════════════════════════════════════════");
  log(" T3  sync indexes via Mongoose model");
  log("══════════════════════════════════════════");

  if (DRY_RUN) {
    warn("     (dry-run) skipping syncIndexes");
    return;
  }

  const Transaction = require("../models/Transaction");
  const result = await Transaction.syncIndexes();
  ok("     syncIndexes result:", result);
  ok("\n  T3 complete.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  log(`connecting to MongoDB${DRY_RUN ? " (DRY-RUN — no writes)" : ""}…`);
  await mongoose.connect(process.env.MONGO_URI);
  log("connected\n");

  const db   = mongoose.connection.db;
  const coll = db.collection("transactions");

  try {
    await migrateCustomerField(coll);
    await backfillDefaults(coll);
    await syncIndexes();

    log("\n══════════════════════════════════════════");
    log(` ALL DONE${DRY_RUN ? " (dry-run — nothing written)" : ""}`);
    log("══════════════════════════════════════════\n");
  } catch (e) {
    fail("migration failed:", e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    log("disconnected");
  }
}

run().catch(async (e) => {
  fail("unhandled error:", e);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
