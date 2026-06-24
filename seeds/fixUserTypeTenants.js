"use strict";
/**
 * fixUserTypeTenants.js — one-time repair for UserType rows where
 * clientBelongs/branchBelongs is null because the UserType was seeded
 * before the Client/Branch document was created.
 *
 * Run:  node api/seeds/fixUserTypeTenants.js
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });

const mongoose = require("mongoose");
require("colors");

// Register all models needed by populate/refs
require("../models/User");
require("../models/Role");
const Client   = require("../models/Client");
const Branch   = require("../models/Branch");
const UserType = require("../models/UserType");

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("✗ MONGO_URI not set".red);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB".gray);

  // ── Fix client-type rows with null clientBelongs ─────────────────────────
  const clientRows = await UserType.find({ userType: "client", clientBelongs: null }).lean();
  console.log(`\nClient rows with null clientBelongs: ${clientRows.length}`);
  for (const row of clientRows) {
    const c = await Client.findOne({ user: row.user }).lean();
    if (!c) { console.log(`  ⚠  user ${row.user} — no Client found, skipped`.yellow); continue; }
    await UserType.deleteOne({ _id: row._id });
    await UserType.findOneAndUpdate(
      { user: row.user, userType: "client", role: row.role, clientBelongs: c._id, branchBelongs: null },
      { $setOnInsert: { isActive: row.isActive !== false, assignedBy: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`  ✓  user ${row.user} → client ${c._id}  (role: ${row.role})`.green);
  }

  // ── Fix branch-type rows with null branchBelongs ─────────────────────────
  const branchRows = await UserType.find({ userType: "branch", branchBelongs: null }).lean();
  console.log(`\nBranch rows with null branchBelongs: ${branchRows.length}`);
  for (const row of branchRows) {
    const b = await Branch.findOne({ user: row.user }).lean();
    if (!b) { console.log(`  ⚠  user ${row.user} — no Branch found, skipped`.yellow); continue; }
    await UserType.deleteOne({ _id: row._id });
    await UserType.findOneAndUpdate(
      { user: row.user, userType: "branch", role: row.role, clientBelongs: b.client ?? null, branchBelongs: b._id },
      { $setOnInsert: { isActive: row.isActive !== false, assignedBy: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`  ✓  user ${row.user} → branch ${b._id}  client ${b.client ?? "null"}  (role: ${row.role})`.green);
  }

  console.log("\nDone.\n".green.bold);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("✗ fixUserTypeTenants failed:".red, err.message);
  process.exit(1);
});
