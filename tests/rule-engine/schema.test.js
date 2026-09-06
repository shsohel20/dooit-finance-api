/**
 * Rule-engine schema contract (docs/72 §6, 21 Aug 2026).
 *
 * Pins the shared risk vocabulary (models/schemas/riskShared.js), the
 * RuleEngine guard rails + version history, the Alert/Case/Transaction/
 * Customer/Notify additions, and the evaluator's signal / customer-subject
 * resolution — so the next schema change cannot silently drift.
 *
 * Self-contained model pattern (see tests/company-kyc-model): own in-memory
 * Mongo, models required after connect, no HTTP layer.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let riskShared, RuleEngine, RuleEngineVersion, Alert, Case, Transaction, Customer, Notify, ruleEvaluation;

const baseRule = (over = {}) => ({
  ruleId: "T-1",
  ruleName: "test rule",
  ruleCondition: "amount > 10",
  caseType: "AML",
  riskScore: 50,
  riskLabel: "Medium",
  conditions: [{ field: "amount", operator: "gt", value: 10 }],
  ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  riskShared = require("../../models/schemas/riskShared");
  RuleEngine = require("../../models/RuleEngine");
  RuleEngineVersion = require("../../models/RuleEngineVersion");
  Alert = require("../../models/Alert");
  Case = require("../../models/Case");
  Transaction = require("../../models/Transaction");
  Customer = require("../../models/Customer");
  Notify = require("../../models/Notify");
  ruleEvaluation = require("../../services/ruleEvaluation");
  // Let every model finish building its indexes (the RuleEngineVersion unique
  // index is what makes record() idempotent) and let plugin init settle,
  // so nothing races the tests or the teardown.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  // best-effort post-save hooks (version snapshots) may still be in flight
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// ── riskShared ──────────────────────────────────────────────────────────────

describe("riskShared normalizers", () => {
  test("riskLabel: case-fixes known labels, maps unknown/null to Info", () => {
    const { normalizeRiskLabel } = riskShared;
    expect(normalizeRiskLabel("high")).toBe("High");
    expect(normalizeRiskLabel("CRITICAL")).toBe("Critical");
    expect(normalizeRiskLabel("Unknown")).toBe("Info");
    expect(normalizeRiskLabel(null)).toBe("Info");
  });

  test("caseType: case-insensitive match, unknown → AML", () => {
    const { normalizeCaseType } = riskShared;
    expect(normalizeCaseType("tf")).toBe("TF");
    expect(normalizeCaseType("Regular")).toBe("AML");
    expect(normalizeCaseType(undefined)).toBe("AML");
  });

  test("priority: urgent → critical, unknown → medium", () => {
    const { normalizePriority } = riskShared;
    expect(normalizePriority("Urgent")).toBe("critical");
    expect(normalizePriority("banana")).toBe("medium");
  });

  test("signalKey slugs analyst labels", () => {
    expect(riskShared.signalKey("Beneficiary on watchlist")).toBe("beneficiary_on_watchlist");
    expect(riskShared.signalKey("  Device fingerprint -- banned! ")).toBe("device_fingerprint_banned");
  });
});

// ── RuleEngine ──────────────────────────────────────────────────────────────

describe("RuleEngine guard rails", () => {
  test("defaults: engine predicate, actions [create_alert], groupBy customer, dedupeBy txn", () => {
    const r = new RuleEngine(baseRule());
    expect(r.engine).toBe("predicate");
    expect(r.actions.map((a) => a.type)).toEqual(["create_alert"]);
    expect(r.aggregation.groupBy).toBe("customer");
    expect(r.dedupeBy).toBe("rule_customer_txn");
    expect(r.appliesTo).toBe("transaction");
  });

  test("rejects a condition field containing operator text", () => {
    const r = new RuleEngine(baseRule({ conditions: [{ field: "New account (", operator: "eq", value: 1 }] }));
    const err = r.validateSync();
    expect(err && err.errors["conditions.0.field"]).toBeTruthy();
  });

  test("rejects appliesTo 'account' and unknown caseType", () => {
    expect(new RuleEngine(baseRule({ appliesTo: "account" })).validateSync()).toBeTruthy();
    expect(new RuleEngine(baseRule({ caseType: "Other" })).validateSync()).toBeTruthy();
  });
});

describe("RuleEngine version history", () => {
  test("create → v1 snapshot; findByIdAndUpdate on logic → v2 snapshot with changedPaths", async () => {
    const rule = await RuleEngine.create(baseRule({ ruleId: "T-VER" }));
    await new Promise((r) => setTimeout(r, 20)); // post-save hook is async
    const v1 = await RuleEngineVersion.findOne({ rule: rule._id, version: 1 }).lean();
    expect(v1).toBeTruthy();
    expect(v1.snapshot.conditions[0].field).toBe("amount");

    const updated = await RuleEngine.findByIdAndUpdate(
      rule._id,
      { conditions: [{ field: "amount", operator: "gt", value: 99 }] },
      { new: true, runValidators: true }
    );
    expect(updated.version).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    const v2 = await RuleEngineVersion.findOne({ rule: rule._id, version: 2 }).lean();
    expect(v2).toBeTruthy();
    expect(v2.changedPaths).toEqual(["conditions"]);
    expect(v2.snapshot.conditions[0].value).toBe(99);
  });

  test("non-logic update does not bump version or write history", async () => {
    const rule = await RuleEngine.create(baseRule({ ruleId: "T-NOBUMP" }));
    await RuleEngine.findByIdAndUpdate(rule._id, { ruleName: "renamed" }, { new: true });
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await RuleEngine.findById(rule._id).lean();
    expect(fresh.version).toBe(1);
    expect(await RuleEngineVersion.countDocuments({ rule: rule._id })).toBe(1);
  });

  test("record() is idempotent per (rule, version)", async () => {
    const rule = await RuleEngine.create(baseRule({ ruleId: "T-IDEMP" }));
    await new Promise((r) => setTimeout(r, 20));
    const again = await RuleEngineVersion.record(rule);
    expect(again).toBeNull();
    expect(await RuleEngineVersion.countDocuments({ rule: rule._id })).toBe(1);
  });
});

// ── Alert / Case ────────────────────────────────────────────────────────────

describe("Alert additions", () => {
  test("caseType is normalised on write; priority accepts critical; notify ref exists", () => {
    const a = new Alert({ caseType: "Regular", priority: "critical", notify: new mongoose.Types.ObjectId() });
    expect(a.caseType).toBe("AML");
    expect(a.validateSync()).toBeUndefined();
    expect(a.notify).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  test("shared SLA shape + isOverdue virtual", () => {
    const past = new Date(Date.now() - 1000);
    expect(new Alert({ slaDeadline: past, status: "new" }).isOverdue).toBe(true);
    expect(new Alert({ slaDeadline: past, status: "dismissed" }).isOverdue).toBe(false);
    expect(new Alert({ slaStatus: "late" }).validateSync()).toBeTruthy();
  });
});

describe("Case shared fields", () => {
  test("nullable risk fields and SLA come from riskShared", () => {
    const c = new Case({ title: "t", type: "other" });
    expect(c.riskScore).toBeNull();
    expect(c.riskLabel).toBeNull();
    expect(c.slaStatus).toBe("on_time");
    expect(new Case({ riskScore: 101 }).validateSync().errors.riskScore).toBeTruthy();
  });
});

// ── Transaction / Customer signals ──────────────────────────────────────────

describe("Transaction additions", () => {
  test("riskScore is clamped 0–100", () => {
    expect(new Transaction({ riskScore: 150 }).validateSync().errors.riskScore).toBeTruthy();
  });

  test("signals: key is slugged, source defaults to system, evaluation state defaults", () => {
    const t = new Transaction({ signals: [{ key: "Beneficiary On Watchlist", value: true }] });
    expect(t.signals[0].key).toBe("beneficiary_on_watchlist");
    expect(t.signals[0].source).toBe("system");
    expect(t.evaluation.ruleCount).toBe(0);
    expect(t.evaluation.firedRuleIds).toEqual([]);
  });

  test("rejects an unknown signal source", () => {
    const t = new Transaction({ signals: [{ key: "x", value: 1, source: "gossip" }] });
    expect(t.validateSync().errors["signals.0.source"]).toBeTruthy();
  });
});

describe("Customer additions", () => {
  test("has signals[] and evaluation with defaults", () => {
    const c = new Customer({ signals: [{ key: "Device fingerprint banned", value: true, source: "vendor" }] });
    expect(c.signals[0].key).toBe("device_fingerprint_banned");
    expect(c.evaluation.lastEvaluatedAt).toBeNull();
  });
});

// ── Notify ──────────────────────────────────────────────────────────────────

describe("Notify processing state", () => {
  test("defaults to pending with empty alerts; rejects unknown status", () => {
    const n = new Notify({ notifyFor: "Transaction", notes: "x" });
    expect(n.status).toBe("pending");
    expect(n.alerts).toEqual([]);
    expect(n.processedAt).toBeNull();
    expect(new Notify({ notifyFor: "Transaction", notes: "x", status: "done" }).validateSync()).toBeTruthy();
  });
});

// ── Evaluator resolution ────────────────────────────────────────────────────

describe("ruleEvaluation: signals, derived facts, customer subject", () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86400e3);
  const customer = {
    _id: "c1",
    isPep: true,
    signals: [{ key: "device_fingerprint_banned", value: true }],
    personalKyc: { personal_form: { customer_details: { date_of_birth: "1990-01-01" } } },
    relations: [{ registeredAt: tenDaysAgo }],
  };
  const txn = {
    amount: 5000,
    signals: [{ key: "beneficiary_on_watchlist", value: true }, { key: "stale", value: 1, expiresAt: new Date(0) }],
    sender: { customer },
  };

  test("analyst label and signals.<key> both resolve; expired signals are ignored", () => {
    expect(ruleEvaluation.resolveField(txn, "Beneficiary on watchlist")).toEqual({ found: true, value: true });
    expect(ruleEvaluation.resolveField(txn, "signals.beneficiary_on_watchlist").value).toBe(true);
    expect(ruleEvaluation.resolveField(txn, "stale").found).toBe(false);
  });

  test("transaction rule reaches a party customer's signal and derived facts", () => {
    expect(ruleEvaluation.resolveField(txn, "Device fingerprint banned").value).toEqual([true]);
    expect(ruleEvaluation.resolveField(txn, "Account open days").value).toEqual([10]);
    expect(ruleEvaluation.resolveField(txn, "Sender age").value[0]).toBeGreaterThan(30);
  });

  test("customer subject resolves bare, aliased and customer.-prefixed paths", () => {
    const opts = { subject: "customer" };
    expect(ruleEvaluation.resolveField(customer, "isPep", opts).value).toBe(true);
    expect(ruleEvaluation.resolveField(customer, "pep", opts).value).toBe(true);
    expect(ruleEvaluation.resolveField(customer, "customer.isPep", opts).value).toBe(true);
    expect(ruleEvaluation.resolveField(customer, "Device fingerprint banned", opts).value).toBe(true);
    expect(ruleEvaluation.resolveField(customer, "account_open_days", opts).value).toBe(10);
  });

  test("evaluateTree with subject:'customer' matches a customer rule", () => {
    const tree = { logic: "AND", children: [{ field: "pep", operator: "eq", value: true }, { field: "Account open days", operator: "lt", value: 30 }] };
    expect(ruleEvaluation.evaluateTree(tree, customer, { subject: "customer" }).matched).toBe(true);
    // Same tree against the transaction context still works through the party customer
    expect(ruleEvaluation.evaluateTree(tree, txn).matched).toBe(true);
  });
});
