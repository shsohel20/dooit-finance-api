/**
 * One-off migration: shareholders[].beneficial_arrangement reshape
 * (docs/65 Step 66)
 *
 *   type            -> arrangement_type
 *   beneficiary_name-> beneficiary.full_name
 *   date_of_birth   -> beneficiary.date_of_birth
 *   (new)           -> beneficiary_type: "individual"
 *
 * The old paths were removed from ShareholderSchema, so Mongoose can no
 * longer see them — a hydrated document drops paths that aren't in the
 * schema, which is why this works through the NATIVE driver, the same way
 * migrate-trust-settlor-name.js (Step 60) does.
 *
 * `beneficiary_type` is set to "individual" because that is what the old
 * shape could only ever mean: one free-text name field, documented as "the
 * nominee principal's name, or the minor's name". Rows whose beneficiary was
 * really a company are indistinguishable in the old data and need correcting
 * by hand — they're listed at the end of a --dry run so they can be reviewed.
 *
 * Safe to re-run: only matches shareholders that still carry an old path, and
 * never overwrites a new-shape value that is already populated.
 *
 * Usage:
 *   node api/scripts/migrate-beneficial-arrangement.js         # apply
 *   node api/scripts/migrate-beneficial-arrangement.js --dry   # report only
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
  const col = mongoose.connection.db.collection("companykycs");

  // Any company with at least one shareholder still on an old path.
  const filter = {
    shareholders: {
      $elemMatch: {
        $or: [
          { "beneficial_arrangement.type": { $exists: true } },
          { "beneficial_arrangement.beneficiary_name": { $exists: true } },
          { "beneficial_arrangement.date_of_birth": { $exists: true } },
        ],
      },
    },
  };

  const total = await col.countDocuments(filter);
  console.log(`${total} company record(s) carry a legacy beneficial_arrangement.`);

  let rowsTouched = 0;
  const needsReview = [];
  const ops = [];

  const cursor = col.find(filter, { projection: { shareholders: 1, "general_information.legal_name": 1 } });
  for await (const doc of cursor) {
    const set = {};
    const unset = {};

    (doc.shareholders || []).forEach((sh, i) => {
      const ba = sh?.beneficial_arrangement;
      if (!ba) return;
      const hasLegacy = "type" in ba || "beneficiary_name" in ba || "date_of_birth" in ba;
      if (!hasLegacy) return;

      const p = `shareholders.${i}.beneficial_arrangement`;
      // Never clobber a value already written in the new shape.
      if (ba.type && !ba.arrangement_type) set[`${p}.arrangement_type`] = ba.type;
      if (ba.beneficiary_name && !ba.beneficiary?.full_name) set[`${p}.beneficiary.full_name`] = ba.beneficiary_name;
      if (ba.date_of_birth && !ba.beneficiary?.date_of_birth) set[`${p}.beneficiary.date_of_birth`] = ba.date_of_birth;
      if (!ba.beneficiary_type && (ba.beneficiary_name || ba.type)) set[`${p}.beneficiary_type`] = "individual";

      unset[`${p}.type`] = "";
      unset[`${p}.beneficiary_name`] = "";
      unset[`${p}.date_of_birth`] = "";
      rowsTouched += 1;

      // A name that looks like a company is worth a human check, since the
      // old shape had no way to say so.
      if (/\b(pty|ltd|limited|inc|llc|plc|corp|company|holdings|nominees)\b/i.test(ba.beneficiary_name || "")) {
        needsReview.push(
          `  ${doc.general_information?.legal_name || doc._id} — shareholders[${i}] beneficiary "${ba.beneficiary_name}"`,
        );
      }
    });

    if (Object.keys(unset).length) {
      const update = { $unset: unset };
      if (Object.keys(set).length) update.$set = set;
      ops.push({ updateOne: { filter: { _id: doc._id }, update } });
    }
  }

  if (DRY) {
    console.log(`[dry run] would reshape ${rowsTouched} shareholder row(s) across ${ops.length} company/companies. Nothing written.`);
  } else if (ops.length) {
    const res = await col.bulkWrite(ops, { ordered: false });
    console.log(`Migrated ${res.modifiedCount} company record(s), ${rowsTouched} shareholder row(s) reshaped.`);
  } else {
    console.log("Nothing to migrate.");
  }

  if (needsReview.length) {
    console.log(
      `\n${needsReview.length} beneficiary name(s) look like companies but were migrated as beneficiary_type "individual" — review and correct:`,
    );
    needsReview.forEach((line) => console.log(line));
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Migration failed:", err.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
