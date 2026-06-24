/**
 * bootstrapAdmin.js — create the first platform admin on a fresh DB
 *
 * There is no public path to a privileged user (register() only makes an
 * inactive `userType:"user"` customer). This wires the three pieces the auth
 * stack needs together:
 *
 *   1. Roles            — a role document whose `name` equals User.role.
 *                         protect() resolves User.role (string) → Roles by name
 *                         → RolePermission by that role _id.
 *   2. Users            — the admin, isActive:true, with role = that name.
 *   3. RolePermission   — grants the role EVERY permission string in
 *                         _data/permissionjson.json (incl. PRIVACY.ENCRYPTVIEW
 *                         so the admin sees decrypted PII), scope client/branch = null.
 *
 * Idempotent: re-running finds the user by emailHash and won't duplicate.
 * Use --force to reset the password of an existing user.
 *
 * Run from anywhere:
 *   node api/seeds/bootstrapAdmin.js --email you@dooit.ai --password 'S3cret!!'
 *   node seeds/bootstrapAdmin.js --email you@dooit.ai --password 'S3cret!!' --force
 *
 * Args (or ADMIN_* env vars):
 *   --email      / ADMIN_EMAIL       (required)
 *   --password   / ADMIN_PASSWORD    (required, min 6 chars)
 *   --name       / ADMIN_NAME        (default "Super Admin")
 *   --username   / ADMIN_USERNAME    (default: email local-part)
 *   --role       / ADMIN_ROLE        (default "admin")
 *   --userType   / ADMIN_USER_TYPE   (default "dooit" — platform owner, unscoped)
 *   --force                          (reset password if the user already exists)
 *
 * SECURITY: pass the password as an arg/env only on a trusted shell; rotate it
 * after first login. Prefer ADMIN_PASSWORD env over shell history.
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
require("colors");

const User = require("../models/User");
const UserType = require("../models/UserType");
const Role = require("../models/Role");
const Permission = require("../models/Permission");
const RolePermission = require("../models/RolePermission");
const { hashForSearch } = require("../utils/encryption");
const permissionCatalog = require("../_data/permissionjson.json");

// ── arg parsing (supports --k v and --k=v) ──────────────────────────────────
function parseArgs(argv) {
  const out = { _flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[a.slice(2)] = next; i++; }
      else out._flags.add(a.slice(2));
    }
  }
  return out;
}

function fail(msg) {
  console.log(`\n✗ ${msg}\n`.red);
  process.exit(1);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  const email    = args.email    || process.env.ADMIN_EMAIL;
  const password = args.password || process.env.ADMIN_PASSWORD;
  const name     = args.name     || process.env.ADMIN_NAME     || "Super Admin";
  const role     = args.role     || process.env.ADMIN_ROLE     || "admin";
  const userType = args.userType || process.env.ADMIN_USER_TYPE || "dooit";
  const force    = args._flags.has("force");

  if (!email)    fail("Missing --email (or ADMIN_EMAIL).");
  if (!password) fail("Missing --password (or ADMIN_PASSWORD).");
  if (String(password).length < 6) fail("Password must be at least 6 characters.");

  const userName = args.username || process.env.ADMIN_USERNAME || String(email).split("@")[0];

  if (!process.env.MONGO_URI) fail("MONGO_URI not set in config/config.env.");

  // Flatten the permission catalog → every action string (incl. PRIVACY.ENCRYPTVIEW).
  const allPermissions = permissionCatalog.flatMap((m) => m.permissions.map((p) => p.value));

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB".gray);
  console.log(`Target: ${process.env.MONGO_URI.replace(/\/\/[^@]*@/, "//****@")}`.gray);

  // 1. Role ───────────────────────────────────────────────────────────────
  let roleDoc = await Role.findOne({ name: { $regex: new RegExp(`^${role}$`, "i") } });
  if (!roleDoc) {
    roleDoc = await Role.create({ name: role, description: "Platform administrator (bootstrap)", isActive: true });
    console.log(`✓ Role created: ${role}`.green);
  } else {
    console.log(`• Role exists: ${roleDoc.name}`.gray);
  }

  // 2. User ────────────────────────────────────────────────────────────────
  // Look up by emailHash (deterministic) — email itself is non-deterministic ciphertext.
  let user = await User.findOne({ emailHash: hashForSearch(email) });

  if (!user) {
    // New doc via .save() so pre-save hooks run: password hash, emailHash, slug,
    // uid, and roleEncryptionPlugin encryption of name/email/userName.
    // NOTE: role/userType are NOT in User schema anymore — they live in UserType.
    user = new User({ name, userName, email, password, isActive: true });
    await user.save();
    console.log(`✓ Admin user created: ${email}  (uid ${user.uid})`.green);
  } else {
    // Existing user: ensure isActive; password reset on --force.
    const set = { isActive: true };
    if (force) {
      const salt = await bcrypt.genSalt(10);
      set.password = await bcrypt.hash(String(password), salt);
    }
    await User.updateOne({ _id: user._id }, { $set: set });
    console.log(
      `• Admin user already existed — ensured isActive${force ? " + reset password" : ""}.`.yellow
    );
    if (!force) console.log(`  (pass --force to reset the password)`.gray);
  }

  // 2b. UserType — seed the admin membership so protect() can resolve a hat ──
  await UserType.findOneAndUpdate(
    { user: user._id, userType, role, clientBelongs: null, branchBelongs: null },
    { $setOnInsert: { isActive: true, assignedBy: user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`✓ UserType membership seeded: userType=${userType}  role=${role}`.green);

  // 3. RolePermission — grant the role all permissions, global scope ─────────
  await RolePermission.findOneAndUpdate(
    { role: roleDoc._id, client: null, branch: null },
    {
      $set: { permissions: allPermissions, isActive: true, grantedBy: user._id, expiresAt: null },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`✓ RolePermission set: ${allPermissions.length} permissions granted to "${roleDoc.name}".`.green);

  // 4. (bonus) seed the Permission catalog collection — harmless, idempotent ──
  const permOps = allPermissions.map((value) => ({
    updateOne: { filter: { name: value }, update: { $setOnInsert: { name: value, isActive: true } }, upsert: true },
  }));
  if (permOps.length) {
    const r = await Permission.bulkWrite(permOps, { ordered: false });
    console.log(`✓ Permission catalog: ${r.upsertedCount} added (${allPermissions.length} total).`.green);
  }

  console.log("\nDone. You can now log in:".cyan.bold);
  console.log(`  email:    ${email}`.gray);
  console.log(`  password: (the one you supplied)`.gray);
  console.log(`  role:     ${role}   userType: ${userType}`.gray);
  console.log("\nPrivacy: PRIVACY.ENCRYPTVIEW is granted, so PII shows decrypted for this role.".gray);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error(`\n✗ bootstrapAdmin failed:`.red, err.message);
  if (err.code === 11000) {
    console.error(`  Duplicate key — a user with that name/userName/phone may already exist.`.gray);
  }
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
