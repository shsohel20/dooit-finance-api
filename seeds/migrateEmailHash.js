/**
 * Migration: backfill emailHash for all existing users
 *
 * Run once:
 *   node scripts/migrateEmailHash.js
 *
 * Reads via raw MongoDB driver (bypasses Mongoose post-find hooks, so
 * encrypted email fields are never masked to "***" before hashing).
 *
 * Safe to re-run — overwrites any previously wrong emailHash values too.
 */

const dotenv = require("dotenv");
dotenv.config({ path: "./config/config.env" });

const mongoose = require("mongoose");
require("colors");
const { decrypt, hashForSearch } = require("../utils/encryption");

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("MongoDB connected".green);

  // Use raw collection — bypasses ALL Mongoose middleware / post-find hooks
  const collection = mongoose.connection.collection("users");

  const users = await collection
    .find({}, { projection: { email: 1, isDataEncrypted: 1 } })
    .toArray();

  console.log(`Found ${users.length} user(s) to process`.yellow);

  let success = 0;
  let failed = 0;

  for (const user of users) {
    try {
      let plainEmail = user.email;

      if (user.isDataEncrypted) {
        try {
          plainEmail = decrypt(user.email);
        } catch {
          // Flag was set but email was never actually encrypted — use as-is
        }
      }

      await collection.updateOne(
        { _id: user._id },
        { $set: { emailHash: hashForSearch(plainEmail) } }
      );

      success++;
    } catch (err) {
      console.error(`  ✗ User ${user._id}: ${err.message}`.red);
      failed++;
    }
  }

  console.log(`\nDone — ${success} updated, ${failed} failed`.cyan);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error(err.message.red);
  process.exit(1);
});
