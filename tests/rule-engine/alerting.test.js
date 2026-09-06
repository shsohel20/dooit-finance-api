/**
 * ruleAlerting — the rule engine's write side (docs/72 §5, E1).
 *
 * Covers: tenant-aware rule selection, evaluation of a Transaction and a
 * Customer subject, the Alert contract (ruleRef snapshot, dedup key, SLA,
 * priority, origin), dedup / cooldown outcomes, telemetry, evaluation state
 * on the subject, and processNotify's status transitions.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let RuleEngine, Alert, Notify, Transaction, Customer, ruleAlerting;

const CLIENT_A = new mongoose.Types.ObjectId();
const CLIENT_B = new mongoose.Types.ObjectId();

const rule = (over = {}) => ({
  ruleId: over.ruleId || `R-${Math.random().toString(36).slice(2, 7)}`,
  ruleName: over.ruleName || "test rule",
  ruleCondition: "amount > 1000",
  caseType: "AML",
  riskScore: 80,
  riskLabel: "High",
  conditions: [{ field: "amount", operator: "gt", value: 1000 }],
  ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RuleEngine = require("../../models/RuleEngine");
  require("../../models/RuleEngineVersion");
  require("../../models/Counter");
  Alert = require("../../models/Alert");
  Notify = require("../../models/Notify");
  Transaction = require("../../models/Transaction");
  Customer = require("../../models/Customer");
  ruleAlerting = require("../../services/ruleAlerting");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([RuleEngine.deleteMany({}), Alert.deleteMany({}), Notify.deleteMany({}), Transaction.deleteMany({}), Customer.deleteMany({})]);
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeCustomer(over = {}) {
  return Customer.create({ isPep: false, sanction: false, country: "AU", relations: [{ client: CLIENT_A, type: "individual", registeredAt: new Date() }], ...over });
}
async function makeTxn(customer, over = {}) {
  return Transaction.create({ amount: 5000, currency: "AUD", type: "withdrawal", client: CLIENT_A, sender: { customer: customer._id, name: "S" }, ...over });
}

// ── selectRules ──────────────────────────────────────────────────────────────

describe("selectRules", () => {
  test("system rules apply to every tenant; client rules only to their own; manual/aggregate/inactive/expired are excluded", async () => {
    await RuleEngine.create([
      rule({ ruleId: "SYS", client: null }),
      rule({ ruleId: "OWN", client: CLIENT_A }),
      rule({ ruleId: "OTHER", client: CLIENT_B }),
      rule({ ruleId: "MANUAL", engine: "manual" }),
      rule({ ruleId: "AGG", engine: "aggregate" }),
      rule({ ruleId: "PAUSED", status: "paused" }),
      rule({ ruleId: "EXPIRED", effectiveTo: new Date(Date.now() - 1000) }),
      rule({ ruleId: "CUST", appliesTo: "customer" }),
    ]);
    const ids = (await ruleAlerting.selectRules({ client: CLIENT_A, appliesTo: "transaction" })).map((r) => r.ruleId).sort();
    expect(ids).toEqual(["OWN", "SYS"]);
    const cust = (await ruleAlerting.selectRules({ client: CLIENT_A, appliesTo: "customer" })).map((r) => r.ruleId);
    expect(cust).toEqual(["CUST"]);
  });
});

// ── buildAlertDraft ──────────────────────────────────────────────────────────

describe("buildAlertDraft / dedupKeyFor", () => {
  test("honours the Alert contract: snapshot, priority, SLA, origin, dedup key", async () => {
    const customer = await makeCustomer();
    const txn = await makeTxn(customer);
    const r = await RuleEngine.create(rule({ ruleId: "D-1", riskLabel: "Critical", slaHours: 6 }));
    const { fired } = ruleAlerting.evaluateSubject(txn, "transaction", [r]);
    expect(fired).toHaveLength(1);

    const before = Date.now();
    const draft = ruleAlerting.buildAlertDraft(fired[0], txn, "transaction", { client: CLIENT_A, notifyId: "n1" });
    expect(draft.ruleRef).toEqual(r._id);
    expect(draft.ruleId).toBe("D-1");
    expect(draft.ruleVersion).toBe(1);
    expect(draft.ruleMeta.matched[0].field).toBe("amount");
    expect(draft.priority).toBe("critical");
    expect(draft.alertOrigin).toBe("Rule Based");
    expect(draft.customer).toEqual(customer._id);
    expect(draft.transaction).toEqual(txn._id);
    expect(draft.deduplicationKey).toBe(`D-1:${customer._id}:${txn._id}`);
    const hours = (draft.slaDeadline.getTime() - before) / 3600e3;
    expect(hours).toBeGreaterThan(5.9);
    expect(hours).toBeLessThan(6.1);
    expect(draft.explanation).toContain("D-1".length ? "test rule" : "");
  });

  test("covers every Alert field the model does not own itself", async () => {
    const customer = await makeCustomer();
    const txn = await makeTxn(customer);
    const analyst = new mongoose.Types.ObjectId();
    const r = await RuleEngine.create(rule({ ruleId: "COVER", actions: [{ type: "create_alert" }, { type: "assign", params: { analyst: String(analyst) } }, { type: "notify" }] }));
    const { fired } = ruleAlerting.evaluateSubject(txn, "transaction", [r]);
    const draft = ruleAlerting.buildAlertDraft(fired[0], txn, "transaction", { client: CLIENT_A, createdBy: analyst, notifyId: new mongoose.Types.ObjectId() });

    const MODEL_OWNED = new Set(["uid", "sequence", "createdAt", "updatedAt"]);
    const topLevel = new Set(Object.keys(Alert.schema.paths).filter((p) => !p.startsWith("_") && p !== "__v").map((p) => p.split(".")[0]));
    const missing = [...topLevel].filter((p) => !MODEL_OWNED.has(p) && !(p in draft));
    expect(missing).toEqual([]);

    // the explicit values are the honest ones
    expect(draft.status).toBe("new");
    expect(draft.slaStatus).toBe("on_time");
    expect(draft.isDeleted).toBe(false);
    expect(draft.linkedCase).toBeNull();
    expect(draft.analyst).toEqual(analyst);                 // from the assign action
    expect(draft.activity).toHaveLength(1);
    expect(draft.activity[0].title).toBe("Rule COVER fired");
    expect(draft.auditLogs[0].action).toBe("alert_created");
    expect(draft.ruleMeta.pendingActions).toEqual(["notify"]);
    expect(draft.metadata.notify).toEqual(draft.notify);

    // and the model accepts the whole draft as-is
    const saved = await Alert.create(draft);
    expect(saved.uid).toMatch(/^AL-/);
    expect(saved.activity[0].title).toBe("Rule COVER fired");
    expect(saved.activity[0].message).toContain("matched amount gt 1000");
  });

  test("dedupeBy rule_customer_day buckets by day; no transaction falls back to day too", () => {
    const r = { ruleId: "X", dedupeBy: "rule_customer_day" };
    const day = new Date().toISOString().slice(0, 10);
    expect(ruleAlerting.dedupKeyFor(r, { customerId: "c", transactionId: "t" })).toBe(`X:c:${day}`);
    expect(ruleAlerting.dedupKeyFor({ ruleId: "Y" }, { customerId: "c", transactionId: null })).toBe(`Y:c:${day}`);
  });
});

// ── evaluateAndAlert ─────────────────────────────────────────────────────────

describe("evaluateAndAlert", () => {
  test("creates one alert per fired rule, bumps telemetry, writes evaluation state, dedups on re-run", async () => {
    const customer = await makeCustomer();
    const txn = await makeTxn(customer);
    await RuleEngine.create([
      rule({ ruleId: "HIT-1" }),
      rule({ ruleId: "HIT-2", conditions: [{ field: "currency", operator: "eq", value: "AUD" }] }),
      rule({ ruleId: "MISS", conditions: [{ field: "amount", operator: "gt", value: 1e9 }] }),
    ]);

    const first = await ruleAlerting.evaluateAndAlert(txn, "transaction", { client: CLIENT_A });
    expect(first.evaluated).toBe(3);
    expect(first.fired.sort()).toEqual(["HIT-1", "HIT-2"]);
    expect(first.alerts).toHaveLength(2);
    expect(first.outcomes.every((o) => o.outcome === "created")).toBe(true);

    const hit = await RuleEngine.findOne({ ruleId: "HIT-1" }).lean();
    expect(hit.hitCount).toBe(1);
    expect(hit.lastFiredAt).toBeTruthy();

    const fresh = await Transaction.findById(txn._id).lean();
    expect(fresh.evaluation.ruleCount).toBe(3);
    expect(fresh.evaluation.firedRuleIds.sort()).toEqual(["HIT-1", "HIT-2"]);
    expect(fresh.evaluation.firedAlerts).toHaveLength(2);

    const again = await ruleAlerting.evaluateAndAlert(txn, "transaction", { client: CLIENT_A });
    expect(again.alerts).toHaveLength(0);
    expect(again.outcomes.map((o) => `${o.ruleId}:${o.outcome}${o.error ? ":" + o.error : ""}`).sort())
      .toEqual(["HIT-1:deduplicated", "HIT-2:deduplicated"]);
    expect(await Alert.countDocuments()).toBe(2);
  });

  test("cooldown suppresses a re-fire for the same customer on a different transaction", async () => {
    const customer = await makeCustomer();
    await RuleEngine.create(rule({ ruleId: "COOL", cooldownMinutes: 60 }));
    const t1 = await makeTxn(customer);
    const t2 = await makeTxn(customer);
    expect((await ruleAlerting.evaluateAndAlert(t1, "transaction", { client: CLIENT_A })).outcomes[0].outcome).toBe("created");
    expect((await ruleAlerting.evaluateAndAlert(t2, "transaction", { client: CLIENT_A })).outcomes[0].outcome).toBe("cooldown");
  });

  test("customer subject: customer rules evaluate on the customer itself", async () => {
    const customer = await makeCustomer({ isPep: true });
    await RuleEngine.create([
      rule({ ruleId: "PEP", appliesTo: "customer", ruleCondition: "pep == true", conditions: [{ field: "pep", operator: "eq", value: true }] }),
      rule({ ruleId: "TXN-ONLY" }), // transaction rule must not run here
    ]);
    const out = await ruleAlerting.evaluateAndAlert(customer, "customer", { client: CLIENT_A });
    expect(out.ruleCount).toBe(1);
    expect(out.fired).toEqual(["PEP"]);
    expect(out.alerts[0].customer).toEqual(customer._id);
    expect(out.alerts[0].transaction).toBeNull();
    const fresh = await Customer.findById(customer._id).lean();
    expect(fresh.evaluation.firedRuleIds).toEqual(["PEP"]);
  });
});

// ── processNotify ────────────────────────────────────────────────────────────

// ── Tenancy: who the alert belongs to (docs/74 C15) ─────────────────────────

describe("tenant resolution", () => {
  const activeRule = () => RuleEngine.create(rule({ ruleId: "TEN-1" }));

  test("an automatic run with no user takes the tenant from the transaction", async () => {
    const customer = await makeCustomer();
    const BRANCH = new mongoose.Types.ObjectId();
    const txn = await makeTxn(customer, { branch: BRANCH });
    await activeRule();

    // No user, no client passed — exactly how a rule-engine hook fires.
    const res = await ruleAlerting.evaluateAndAlert(txn, "transaction", {});
    expect(res.tenant).toMatchObject({ source: "transaction", ambiguous: false });
    expect(String(res.alerts[0].client)).toBe(String(CLIENT_A));
    expect(String(res.alerts[0].branch)).toBe(String(BRANCH));
    expect(res.alerts[0].ruleMeta.tenant).toEqual({ source: "transaction", ambiguous: false });
  });

  test("a customer-subject run falls back to the customer's own relations", async () => {
    const BRANCH = new mongoose.Types.ObjectId();
    const customer = await makeCustomer({
      isPep: true,
      relations: [{ client: CLIENT_A, branch: BRANCH, type: "individual", registeredAt: new Date() }],
    });
    await RuleEngine.create(
      rule({ ruleId: "TEN-CUST", appliesTo: "customer", engine: "screening", conditions: [{ field: "isPep", operator: "eq", value: true }] })
    );

    const res = await ruleAlerting.evaluateAndAlert(customer, "customer", {});
    expect(res.tenant.source).toBe("customer");
    expect(String(res.alerts[0].client)).toBe(String(CLIENT_A));
    expect(String(res.alerts[0].branch)).toBe(String(BRANCH));
  });

  test("a customer held by several clients still raises an alert, marked ambiguous", async () => {
    const customer = await makeCustomer({
      isPep: true,
      relations: [
        { client: CLIENT_A, type: "individual", registeredAt: new Date("2026-01-01") },
        { client: CLIENT_B, type: "individual", registeredAt: new Date("2026-06-01") },
      ],
    });
    await RuleEngine.create(
      rule({ ruleId: "TEN-AMB", appliesTo: "customer", engine: "screening", conditions: [{ field: "isPep", operator: "eq", value: true }] })
    );

    const res = await ruleAlerting.evaluateAndAlert(customer, "customer", {});
    // The earliest relation wins, and the doubt is recorded rather than hidden.
    expect(String(res.tenant.client)).toBe(String(CLIENT_A));
    expect(res.tenant.ambiguous).toBe(true);
    expect(res.alerts[0].ruleMeta.tenant.ambiguous).toBe(true);
  });

  test("a logged-in reviewer's tenant outranks the transaction's", async () => {
    const customer = await makeCustomer();
    const txn = await makeTxn(customer, { client: CLIENT_A });
    await activeRule();

    // The reviewer belongs to B; their session decides, not the record.
    const res = await ruleAlerting.evaluateAndAlert(txn, "transaction", {
      user: { client: { _id: CLIENT_B } },
    });
    expect(res.tenant.source).toBe("user");
    expect(String(res.alerts[0].client)).toBe(String(CLIENT_B));
  });

  test("an admin reviewer has no tenant of their own, so the subject supplies it", async () => {
    const customer = await makeCustomer();
    const txn = await makeTxn(customer);
    await activeRule();

    // A dooit admin: `user` present, but no client on it.
    const res = await ruleAlerting.evaluateAndAlert(txn, "transaction", { user: { _id: "admin" } });
    expect(res.tenant.source).toBe("transaction");
    expect(String(res.alerts[0].client)).toBe(String(CLIENT_A));
  });
});

describe("processNotify", () => {
  test("transaction notify → processed, alerts linked, evaluation summary stored", async () => {
    const customer = await makeCustomer();
    const txn = await makeTxn(customer);
    await RuleEngine.create(rule({ ruleId: "N-1" }));
    const notify = await Notify.create({ notifyFor: "Transaction", notes: "suspicious", resourceType: "Transaction", resourceId: txn._id, client: CLIENT_A });

    const summary = await ruleAlerting.processNotify(notify, { analyst: null });
    expect(summary.alerts).toHaveLength(1);

    const fresh = await Notify.findById(notify._id).lean();
    expect(fresh.status).toBe("processed");
    expect(fresh.processedAt).toBeTruthy();
    expect(fresh.alerts.map(String)).toEqual([String(summary.alerts[0]._id)]);
    expect(fresh.evaluation.firedRules).toEqual(["N-1"]);
    expect(fresh.evaluation.evaluatedRuleCount).toBe(1);

    const alert = await Alert.findById(summary.alerts[0]._id).lean();
    expect(String(alert.notify)).toBe(String(notify._id));
    expect(alert.uid).toMatch(/^AL-/);
  });

  test("no rule fires → no_match; missing resource → failed with reason", async () => {
    const customer = await makeCustomer();
    const txn = await makeTxn(customer, { amount: 1 });
    await RuleEngine.create(rule({ ruleId: "N-2" }));
    const n1 = await Notify.create({ notifyFor: "Transaction", notes: "x", resourceType: "Transaction", resourceId: txn._id });
    await ruleAlerting.processNotify(n1);
    expect((await Notify.findById(n1._id).lean()).status).toBe("no_match");

    const n2 = await Notify.create({ notifyFor: "Customer", notes: "x", resourceType: "Customer", resourceId: new mongoose.Types.ObjectId() });
    await ruleAlerting.processNotify(n2);
    const f2 = await Notify.findById(n2._id).lean();
    expect(f2.status).toBe("failed");
    expect(f2.error).toMatch(/No Customer found/);
  });
});
