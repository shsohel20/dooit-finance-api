// seeds/backfill-case-uid.js
//
// Gives a uid to cases that were saved without one (docs/74 C17).
//
// Every case created through the API before 26 Aug 2026 has `uid: null`: the
// old derivation read `sequence`, which mongoose-sequence assigns in a hook
// that runs after the schema's own pre('save'), so it always saw `undefined`.
// Seeded cases were unaffected because the seeder sets its own uid, which is
// why the gap stayed invisible.
//
// The uid is minted from the case's OWN `createdAt`, not from a counter and not
// from the time this script runs — a case's reference should say when the case
// was opened. Matches the format the model now generates: CA-<ms>-<nnn>.
//
// Idempotent: only documents with no uid are touched, and a uid that somehow
// collides is retried with a fresh suffix.
//
// Usage:
//   node seeds/backfill-case-uid.js            # dry-run (counts + a sample)
//   node seeds/backfill-case-uid.js --apply

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const Case = require("../models/Case");

const APPLY = process.argv.includes("--apply");

const suffix = () => String(Math.floor(Math.random() * 1000)).padStart(3, "0");
const uidFor = (doc) => `CA-${new Date(doc.createdAt || Date.now()).getTime()}-${suffix()}`;

async function run() {
  console.log(`[case-uid] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  await mongoose.connect(process.env.MONGO_URI);

  const missing = { $or: [{ uid: null }, { uid: { $exists: false } }, { uid: "" }] };
  const cases = await Case.find(missing).select("_id createdAt title").sort({ createdAt: 1 }).lean();

  if (!cases.length) {
    console.log("[case-uid] every case already has a uid — nothing to do");
    await mongoose.disconnect();
    return;
  }

  // Mint every uid up front so the value printed below is the value written —
  // computing it again at write time would make the log a plausible fiction.
  const planned = cases.map((doc) => ({ doc, uid: uidFor(doc) }));

  console.log(`[case-uid] ${cases.length} case(s) without a uid`);
  for (const { doc, uid } of planned.slice(0, 5)) {
    console.log(`  ${doc._id}  ${new Date(doc.createdAt).toISOString()}  →  ${uid}`);
  }
  if (cases.length > 5) console.log(`  … and ${cases.length - 5} more`);

  if (!APPLY) {
    console.log("[case-uid] (re-run with --apply)");
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  let failed = 0;
  for (const { doc, uid } of planned) {
    // Two attempts is plenty: the only way the first can fail is a suffix
    // collision inside the same millisecond, which a fresh suffix resolves.
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      const candidate = attempt === 0 ? uid : uidFor(doc);
      try {
        await Case.updateOne({ _id: doc._id }, { $set: { uid: candidate } });
        written++;
        done = true;
      } catch (err) {
        if (attempt === 1) {
          failed++;
          console.error(`[case-uid] ${doc._id} failed: ${err.message}`);
        }
      }
    }
  }

  console.log(`[case-uid] written=${written}${failed ? ` failed=${failed}` : ""}`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[case-uid] failed:", err.message);
  await mongoose.disconnect();
  process.exit(1);
});
