/**
 * One-off migration: trust_details.settlor_name -> settlor.full_name
 * (docs/65 Step 60)
 *
 * `settlor_name` was removed from TrustKycSchema, so Mongoose can no longer
 * see it — a hydrated document drops paths that aren't in the schema. This
 * script therefore works through the NATIVE driver, which still sees the
 * stored field, copies it onto the canonical `settlor.full_name` where that
 * is empty, and then unsets the retired path.
 *
 * Safe to re-run: it only matches documents that still have the old field,
 * and never overwrites a settlor.full_name that already has a value.
 *
 * Usage:
 *   node api/scripts/migrate-trust-settlor-name.js          # apply
 *   node api/scripts/migrate-trust-settlor-name.js --dry    # report only
 */
const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });

const DRY = process.argv.includes("--dry");

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) {
    console.error("No Mongo connection string found (MONGO_URI / MONGODB_URI / DATABASE_URL).");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.db.collection("trustkycs");

  const filter = { "trust_details.settlor_name": { $exists: true, $nin: [null, ""] } };
  const total = await col.countDocuments(filter);
  console.log(`${total} trust record(s) still carry trust_details.settlor_name.`);

  let copied = 0;
  let alreadySet = 0;

  const cursor = col.find(filter, { projection: { "trust_details.settlor_name": 1, "settlor.full_name": 1 } });
  const ops = [];
  for await (const doc of cursor) {
    const legacy = String(doc.trust_details?.settlor_name || "").trim();
    const canonical = String(doc.settlor?.full_name || "").trim();
    const update = { $unset: { "trust_details.settlor_name": "" } };

    if (legacy && !canonical) {
      update.$set = { "settlor.full_name": legacy };
      copied += 1;
    } else {
      // Canonical already populated — the legacy copy is redundant, so it's
      // only removed. Never overwrite a deliberate value with a stale one.
      alreadySet += 1;
    }
    ops.push({ updateOne: { filter: { _id: doc._id }, update } });
  }

  if (DRY) {
    console.log(`[dry run] would copy ${copied}, drop-only ${alreadySet}. Nothing written.`);
  } else if (ops.length) {
    const res = await col.bulkWrite(ops, { ordered: false });
    console.log(`Migrated ${res.modifiedCount} record(s): ${copied} name(s) copied, ${alreadySet} redundant copy/copies removed.`);
  } else {
    console.log("Nothing to migrate.");
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Migration failed:", err.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
