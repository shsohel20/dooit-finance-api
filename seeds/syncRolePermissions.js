/**
 * syncRolePermissions.js — give every Role a RolePermission grant
 *
 * The API no longer authorises by role NAME (authorize("admin","client",…));
 * every staff route is guarded by authorizePermission(). That means a role with
 * no RolePermission document can reach nothing at all — which is exactly the
 * state "Compliance officer", "Senior manager", "Governing body" and
 * "Customer Facing" were in: the Role documents exist, but the permission
 * strings that back them do not.
 *
 * This script is the bridge. It is idempotent and safe to re-run.
 *
 *   node api/seeds/syncRolePermissions.js                 # apply defaults
 *   node api/seeds/syncRolePermissions.js --dry-run       # print, change nothing
 *   node api/seeds/syncRolePermissions.js --report        # audit what each role has
 *   node api/seeds/syncRolePermissions.js --force         # overwrite existing grants
 *
 * Without --force an existing RolePermission is only TOPPED UP: permissions the
 * script would add are unioned in, and nothing an operator granted by hand is
 * removed. With --force the role's permission set is replaced by the profile.
 *
 * Roles not listed in PROFILES are left alone (reported, never guessed at) —
 * apart from getting an empty active grant document so the admin UI can edit
 * them. Add new roles to PROFILES rather than editing rows by hand.
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });

const mongoose = require("mongoose");
require("colors");

const Role = require("../models/Role");
const User = require("../models/User");
const UserType = require("../models/UserType");
const Permission = require("../models/Permission");
const RolePermission = require("../models/RolePermission");
const permissionCatalog = require("../_data/permissionjson.json");

// Every action string in the catalog, and the per-module helpers used below.
const ALL = permissionCatalog.flatMap((m) => m.permissions.map((p) => p.value));
const mod = (key) => ALL.filter((p) => p.startsWith(key + "."));
const read = (...keys) => keys.map((k) => `${k}.GET`);
// TRAINING.ADMIN (delete a module, grant module access) is deliberately not part
// of the training bundle a manager gets — only the platform admin holds it.
const TRAINING_NO_ADMIN = mod("TRAINING").filter((p) => p !== "TRAINING.ADMIN");

// ── Default permission profiles, keyed by lower-cased Role.name ─────────────
// Keep these aligned with the guards in api/routes/*.js. A profile is a
// starting point an operator can refine in the Role Permission UI, not a
// hard-coded policy — nothing in the request path reads this file.
const PROFILES = {
  // Platform owner — the whole catalog, including PRIVACY.ENCRYPTVIEW so PII
  // renders decrypted. Matches what bootstrapAdmin grants.
  admin: ALL,

  // Tenant owner: everything inside their own tenant, no platform admin.
  client: [
    ...mod("USER"), ...mod("BRANCH"), ...mod("STAFF"), ...mod("CUSTOMER"),
    ...mod("CUSTOMER_ACCOUNT"), ...mod("ONBOARDING"), ...mod("SUMSUB"),
    ...mod("TRANSACTION"), ...mod("ALERT"), ...mod("CASE"), ...mod("RFI"),
    ...mod("CLIENT_RULE"), ...mod("POLICY_HUB"), ...mod("RISK_ASSESSMENT"),
    ...mod("REPORT"), ...TRAINING_NO_ADMIN, ...mod("AML_DOC"), ...mod("AFC_DOC"),
    ...mod("NOTIFY"), ...mod("GRC"), ...mod("EWRA"), ...mod("REFERENCE"),
    "CLIENT.GET", "CLIENT.EDIT", "ROLE.GET",
    "PRIVACY.ENCRYPTVIEW",
  ],

  // Branch: same day-to-day work as a client, no tenant-level configuration.
  branch: [
    ...mod("STAFF"), ...mod("CUSTOMER"), ...mod("CUSTOMER_ACCOUNT"),
    ...mod("ONBOARDING"), ...mod("SUMSUB"), ...mod("TRANSACTION"),
    ...mod("ALERT"), ...mod("CASE"), ...mod("RFI"), ...mod("REPORT"),
    ...mod("NOTIFY"), "TRAINING.GET",
    ...read("CLIENT", "BRANCH", "POLICY_HUB", "RISK_ASSESSMENT", "CLIENT_RULE",
            "GRC", "EWRA", "REFERENCE"),
    "PRIVACY.ENCRYPTVIEW",
  ],

  // ── The roles that exist in the roles collection today ────────────────────

  // Compliance officer — the AML/CTF function. Owns alerts, cases, RFIs and
  // regulatory reports end to end; reads customers and transactions; does not
  // administer users, clients, branches or billing.
  "compliance officer": [
    ...mod("ALERT"), ...mod("CASE"), ...mod("RFI"), ...mod("REPORT"),
    ...mod("RISK_ASSESSMENT"), ...mod("AML_DOC"), ...mod("GRC"),
    ...mod("REFERENCE"),
    "CUSTOMER.GET", "CUSTOMER.EDIT",
    "TRANSACTION.GET", "TRANSACTION.EDIT",
    "ONBOARDING.GET", "ONBOARDING.REVIEW",
    "SUMSUB.GET", "SUMSUB.EDIT",
    "POLICY_HUB.GET", "AFC_DOC.GET", "CLIENT_RULE.GET",
    "STAFF.GET", "NOTIFY.GET", "TRAINING.GET",
    // Authors the enterprise-wide risk assessment but does not sign it off —
    // EWRA.APPROVE sits with the senior manager and the governing body.
    "EWRA.GET", "EWRA.ADD", "EWRA.EDIT",
    // Seeing PII unredacted is inherent to the role; drop this line (or block
    // the user via RolePermission.restrictedUsers) where that is not wanted.
    "PRIVACY.ENCRYPTVIEW",
  ],

  // Senior manager — oversight across the tenant plus training ownership.
  "senior manager": [
    ...mod("STAFF"), ...TRAINING_NO_ADMIN, ...mod("CASE"), ...mod("ALERT"),
    ...mod("RFI"), ...mod("REPORT"), ...mod("POLICY_HUB"),
    ...mod("RISK_ASSESSMENT"),
    "CUSTOMER.GET", "CUSTOMER.EDIT", "CUSTOMER_ACCOUNT.GET",
    "TRANSACTION.GET", "ONBOARDING.GET", "ONBOARDING.REVIEW",
    "SUMSUB.GET", "CLIENT_RULE.GET", "AML_DOC.GET", "AFC_DOC.GET",
    ...mod("GRC"), ...mod("EWRA"),
    ...read("USER", "CLIENT", "BRANCH", "REFERENCE"),
    "PRIVACY.ENCRYPTVIEW",
  ],

  // Governing body — board-level assurance. Read-only everywhere, and
  // deliberately NOT granted PRIVACY.ENCRYPTVIEW: oversight does not need PII.
  "governing body": [
    ...read(
      "USER", "CLIENT", "BRANCH", "STAFF", "CUSTOMER", "CUSTOMER_ACCOUNT",
      "TRANSACTION", "ALERT", "CASE", "RFI", "CLIENT_RULE", "POLICY_HUB",
      "RISK_ASSESSMENT", "ONBOARDING", "SUMSUB", "AML_DOC", "AFC_DOC",
      "NOTIFY", "TRAINING", "GRC", "EWRA", "REFERENCE",
    ),
    ...mod("REPORT"),
    // The one write the board does hold: signing off the enterprise-wide risk
    // assessment is the governing body's statutory function.
    "EWRA.APPROVE",
  ],

  // Customer Facing — front-line onboarding. Creates and services customers;
  // no case work, no reporting, no configuration.
  "customer facing": [
    ...mod("CUSTOMER"), ...mod("CUSTOMER_ACCOUNT"), ...mod("ONBOARDING"),
    "SUMSUB.GET", "SUMSUB.EDIT",
    "ALERT.GET", "RFI.GET", "RFI.ADD",
    "NOTIFY.GET", "NOTIFY.ADD", "TRAINING.GET",
    ...read("CLIENT", "BRANCH", "STAFF", "POLICY_HUB", "REFERENCE"),
    "PRIVACY.ENCRYPTVIEW",
  ],

  // Legacy role names still referenced by older UserType rows.
  manager: null,   // resolved to "senior manager" below
  officer: null,   // resolved to "compliance officer" below
  operator: [
    ...mod("CUSTOMER_ACCOUNT"), ...mod("NOTIFY"),
    "CUSTOMER.GET", "TRANSACTION.GET",
  ],
};
PROFILES.manager = PROFILES["senior manager"];
PROFILES.officer = PROFILES["compliance officer"];

const uniq = (a) => [...new Set(a)];

function parseArgs(argv) {
  const flags = new Set();
  for (const a of argv) if (a.startsWith("--")) flags.add(a.slice(2));
  return flags;
}

async function run() {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const force = flags.has("force");
  const reportOnly = flags.has("report");

  if (!process.env.MONGO_URI) {
    console.log("\n✗ MONGO_URI not set in config/config.env.\n".red);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected: ${process.env.MONGO_URI.replace(/\/\/[^@]*@/, "//****@")}`.gray);

  const roles = await Role.find({}).lean();
  if (!roles.length) {
    console.log("No Role documents found — run bootstrapAdmin first.".yellow);
    await mongoose.disconnect();
    return;
  }

  // grantedBy is required on RolePermission; attribute to a platform admin.
  const adminMembership = await UserType.findOne({ userType: "dooit" }).lean();
  const grantedBy = adminMembership?.user ?? (await User.findOne({}).select("_id").lean())?._id;
  if (!grantedBy && !reportOnly && !dryRun) {
    console.log("\n✗ No user found to attribute grants to (grantedBy).\n".red);
    process.exit(1);
  }

  console.log(`\n${roles.length} role(s):`.cyan.bold);

  for (const role of roles) {
    const key = String(role.name ?? "").trim().toLowerCase();
    const profile = PROFILES[key];
    const existing = await RolePermission.findOne({
      role: role._id,
      client: null,
      branch: null,
    }).lean();
    const current = existing?.permissions ?? [];

    if (reportOnly) {
      const label = existing ? `${current.length} permission(s)` : "NO GRANT — blocked everywhere";
      console.log(`  ${role.name.padEnd(22)} ${label}`[existing && current.length ? "green" : "red"]);
      continue;
    }

    if (!profile) {
      // Unknown role: create an empty active grant so it shows up in the admin
      // UI and can be filled in, but never guess at what it should be allowed.
      if (!existing && !dryRun) {
        await RolePermission.create({
          role: role._id, client: null, branch: null,
          permissions: [], grantedBy, isActive: true,
        });
      }
      console.log(
        `  ${role.name.padEnd(22)} no profile — ${existing ? "left as is" : "empty grant created"}; assign permissions in the Role Permission UI`.yellow
      );
      continue;
    }

    const next = force ? uniq(profile) : uniq([...current, ...profile]);
    const added = next.filter((p) => !current.includes(p));
    const removed = current.filter((p) => !next.includes(p));

    if (!dryRun) {
      await RolePermission.findOneAndUpdate(
        { role: role._id, client: null, branch: null },
        {
          $set: {
            permissions: next,
            isActive: true,
            grantedBy: existing?.grantedBy ?? grantedBy,
            expiresAt: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const verb = dryRun ? "would be" : "now";
    console.log(
      `  ${role.name.padEnd(22)} ${verb} ${next.length} permission(s)` +
      (added.length ? `  +${added.length}`.green : "") +
      (removed.length ? `  -${removed.length}`.red : "")
    );
    if (added.length) console.log(`      + ${added.join(", ")}`.gray);
    if (removed.length) console.log(`      - ${removed.join(", ")}`.gray);
  }

  // Keep the Permission catalog collection in step with the JSON file so the
  // admin UI offers the new modules (CASE, STAFF, ONBOARDING, …).
  if (!reportOnly && !dryRun) {
    const ops = ALL.map((value) => ({
      updateOne: {
        filter: { name: value },
        update: { $setOnInsert: { name: value, isActive: true } },
        upsert: true,
      },
    }));
    const r = await Permission.bulkWrite(ops, { ordered: false });
    console.log(`\n✓ Permission catalog: ${r.upsertedCount} added (${ALL.length} total).`.green);
  }

  if (dryRun) console.log("\n(dry run — nothing was written)".yellow);
  console.log("");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error("\n✗ syncRolePermissions failed:".red, err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
