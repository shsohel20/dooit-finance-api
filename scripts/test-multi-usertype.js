/**
 * test-multi-usertype.js
 *
 * End-to-end smoke tests for all multi-usertype changes.
 *
 * Run:
 *   node api/scripts/test-multi-usertype.js \
 *     --email <dooit-admin-email> \
 *     --password <dooit-admin-password> \
 *     [--client-email <client-email>] [--client-password <client-pwd>]
 *
 * The script logs PASS / FAIL for every case, exits 0 if all pass, 1 otherwise.
 */
"use strict";

const http = require("http");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });

// ── helpers ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    out[a.slice(2)] = argv[i + 1] || "";
    i++;
  }
  return out;
}

function request(method, path, body, token) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
    };
    const PORT = process.env.PORT || 6830;
    const req = http.request(
      { hostname: "localhost", port: PORT, path: `/api/v1${path}`, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json;
          try { json = JSON.parse(raw); } catch { json = null; }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, json: null, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}${detail ? "  →  " + detail : ""}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}${detail ? "  →  " + detail : ""}`);
    fail++;
  }
}

// ── test groups ───────────────────────────────────────────────────────────────
async function testUnauthenticated() {
  console.log("\n[1] Unauthenticated protection");

  let r;
  r = await request("GET", "/auth/me");
  check("GET /auth/me without token → 401", r.status === 401);

  r = await request("GET", "/client");
  check("GET /client without token → 401", r.status === 401);

  r = await request("POST", "/client/new");
  check("POST /client/new without token → 401", r.status === 401);

  r = await request("POST", "/staff");
  check("POST /staff without token → 401", r.status === 401);

  r = await request("GET", "/user");
  check("GET /user without token → 401", r.status === 401);
}

async function testLoginGuards(email, password) {
  console.log("\n[2] Login guards");

  let r;

  // Bad credentials
  r = await request("POST", "/auth/login", { email: "nobody@nowhere.com", password: "wrongpass" });
  check("Login with unknown email → 401", r.status === 401);

  // Wrong userType — request a hat the user doesn't have
  r = await request("POST", "/auth/login", { email, password, userType: "nosuchtype_xyz" });
  check("Login with nonexistent userType → 401", r.status === 401, `got ${r.status}`);

  // Valid login — no userType specified (falls back to oldest membership)
  r = await request("POST", "/auth/login", { email, password });
  check("Login without userType → 200", r.status === 200, `userType=${r.json?.data?.userType}`);

  // Valid login with explicit dooit
  r = await request("POST", "/auth/login", { email, password, userType: "dooit" });
  const dooitOk = r.status === 200 && r.json?.data?.userType === "dooit";
  check("Login with userType:dooit → 200 + userType=dooit", dooitOk, `status=${r.status}`);
  return dooitOk ? r.json.token : null;
}

async function testGetMe(token) {
  console.log("\n[3] GET /auth/me");

  const r = await request("GET", "/auth/me", null, token);
  check("GET /auth/me → 200", r.status === 200);

  const d = r.json?.data;
  check("memberships[] is populated (not empty)", Array.isArray(d?.memberships) && d.memberships.length > 0,
    `memberships.length=${d?.memberships?.length}`);

  const myMembership = d?.memberships?.[0];
  check("membership has userType field", !!myMembership?.userType, `userType=${myMembership?.userType}`);
  check("membership has roleId populated", !!myMembership?.roleId, `roleId=${JSON.stringify(myMembership?.roleId)}`);
}

async function testDooitClientRoutes(token) {
  console.log("\n[4] Client routes — dooit access");

  let r;
  r = await request("GET", "/client", null, token);
  check("GET /client with dooit token → 200", r.status === 200, `status=${r.status}`);

  r = await request("GET", "/client/risk-questions/schema", null, token);
  check("GET /client/risk-questions/schema with dooit (bypass) → not 403", r.status !== 403,
    `status=${r.status}`);
}

async function testClientDenied(token, label) {
  console.log(`\n[5] Client routes — ${label} type denied from dooit-only routes`);

  let r;
  r = await request("GET", "/client", null, token);
  check(`GET /client with ${label} token → 403`, r.status === 403, `status=${r.status}`);

  r = await request("POST", "/client/new", { name: "Test" }, token);
  check(`POST /client/new with ${label} token → 403`, r.status === 403, `status=${r.status}`);
}

async function testSwitchContext(token) {
  console.log("\n[6] Switch context");

  // Get memberships from /me
  const me = await request("GET", "/auth/me", null, token);
  const memberships = me.json?.data?.memberships ?? [];
  if (memberships.length < 1) {
    console.log("  - SKIP (no memberships to switch to)");
    return;
  }
  const targetId = memberships[0]._id;
  const r = await request("POST", `/auth/switch-context/${targetId}`, {}, token);
  check("POST /auth/switch-context/:id → 200 + new token", r.status === 200 && !!r.json?.token,
    `status=${r.status}`);
}

async function testUserList(token) {
  console.log("\n[7] User list (skipClientFilter)");
  const r = await request("GET", "/user", null, token);
  check("GET /user → 200", r.status === 200, `status=${r.status}`);

  // All users should be returned regardless of tenant
  const count = r.json?.count ?? 0;
  check("User list count > 0", count > 0, `count=${count}`);
}

async function testAuthorizePermission(token) {
  console.log("\n[8] authorizePermission — dooit admin should have CLIENT.GET");
  const r = await request("GET", "/client", null, token);
  check("GET /client passes CLIENT.GET permission check", r.status === 200, `status=${r.status}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email;
  const password = args.password;
  const clientEmail = args["client-email"];
  const clientPassword = args["client-password"];

  if (!email || !password) {
    console.error("Usage: node test-multi-usertype.js --email <e> --password <p>");
    process.exit(1);
  }

  console.log("=== Multi-UserType Smoke Tests ===");
  console.log(`Server: http://localhost:${process.env.PORT || 6830}/api/v1`);

  await testUnauthenticated();

  const dooitToken = await testLoginGuards(email, password);

  if (!dooitToken) {
    console.log("\n⚠  Could not obtain dooit token — skipping authenticated tests.");
    console.log(`   Check that ${email} has an active userType:dooit membership.\n`);
  } else {
    await testGetMe(dooitToken);
    await testDooitClientRoutes(dooitToken);
    await testSwitchContext(dooitToken);
    await testUserList(dooitToken);
    await testAuthorizePermission(dooitToken);
  }

  if (clientEmail && clientPassword) {
    const r = await request("POST", "/auth/login", { email: clientEmail, password: clientPassword, userType: "client" });
    if (r.status === 200) {
      await testClientDenied(r.json.token, "client");
    } else {
      console.log(`\n[5] SKIP — client login failed (${r.status})`);
    }
  } else {
    console.log("\n[5] SKIP — pass --client-email and --client-password to test client type denial");
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
