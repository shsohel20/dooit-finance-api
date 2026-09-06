/**
 * Case transaction analysis — docs/74 §6.2, phase C2.
 *
 *   services/caseAnalysis      window resolution · AUD normalisation (C11) · direction ·
 *                              totals / per-currency · counterparties · institutions ·
 *                              jurisdictions · crypto · IP · structuring · POIs ·
 *                              rulesTriggered · deterministic report strings
 *   GET   /cases/:id/analysis  computation, snapshot cache, refresh, ad-hoc window
 *   PATCH /cases/:id/review-window
 *
 * Figures mirror the sandbox case CA-SEED-1787248087291-172 so the expectations
 * are recognisable against a real record.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Case, Alert, Transaction, Customer, Device, AuditLog, analysisSvc, caseCtrl;

const call = (handler, { params = {}, query = {}, body = {}, user } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ res, err: null }); return this; },
    };
    const next = (e) => resolve({ res, err: e || null });
    const timer = setTimeout(() => resolve({ res, err: new Error("handler did not respond") }), 10000);
    Promise.resolve(handler({ params, query, body, user, headers: {}, ip: "127.0.0.1" }, res, next)).finally(() => clearTimeout(timer));
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  require("../../models/User");
  require("../../models/Client");
  require("../../models/Branch");
  require("../../models/Counter");
  require("../../models/Notify");
  require("../../models/RuleEngine");
  require("../../models/RuleEngineVersion");
  require("../../models/CaseNote");
  Case = require("../../models/Case");
  Alert = require("../../models/Alert");
  Transaction = require("../../models/Transaction");
  Customer = require("../../models/Customer");
  Device = require("../../models/Device");
  AuditLog = require("../../models/AuditLog");
  analysisSvc = require("../../services/caseAnalysis");
  caseCtrl = require("../../controllers/caseController");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const user = { _id: new mongoose.Types.ObjectId(), name: "Ayesha Rahman", role: "admin" };
const CLIENT = new mongoose.Types.ObjectId();
const daysAgo = (n) => new Date(Date.now() - n * 86400e3);

let poi, alsoPoi, caseDoc, alert;

// Counterparty details reused across transactions so aggregation can group them.
const SIGMA = { name: "Sigma Logistics BV", account: "NL91ABNA0417164300", institution: "ABN AMRO Bank", institutionCountry: "NL", bic: "ABNANL2A" };

beforeEach(async () => {
  await Promise.all([
    Case.deleteMany({}), Alert.deleteMany({}), Transaction.deleteMany({}),
    Customer.deleteMany({}), Device.deleteMany({}), AuditLog.deleteMany({}),
  ]);

  const relations = [{ client: CLIENT, type: "individual", registeredAt: daysAgo(60) }];
  poi = await Customer.create({
    country: "AU", kycStatus: "pending", amlStatus: "yellow", amlRiskLabels: ["adverseMedia"], relations,
    personalKyc: {
      personal_form: { customer_details: { given_name: "MOHAMMAD", surname: "HOSSAIN" }, employment_details: { occupation: "Student" } },
      funds_wealth: { source_of_funds: "Investment Income", account_purpose: "Money Transfer / Remittance", estimated_trading_volume: "$1,000 – $5,000 per month" },
    },
  });
  alsoPoi = await Customer.create({ country: "DE", relations });

  // Two cash deposits in (AUD), one converted outflow, one UNCONVERTED outflow.
  const txns = await Transaction.create([
    { uid: "TXN_D1", amount: 48175, currency: "AUD", type: "deposit", channel: "branch-counter", subtype: "cash", status: "completed",
      timestamp: daysAgo(9), riskFlags: ["cash-intensive"], investigation: { flagged: true },
      receiver: { customer: poi._id, name: "MOHAMMAD HOSSAIN" }, sender: { ...SIGMA },
      metadata: { ip: "203.0.113.45", ipCountry: "NL" } },
    { uid: "TXN_D2", amount: 56336, currency: "AUD", type: "deposit", channel: "branch-counter", subtype: "cash", status: "completed",
      timestamp: daysAgo(9), riskFlags: ["cash-intensive"],
      receiver: { customer: poi._id, name: "MOHAMMAD HOSSAIN" }, sender: { ...SIGMA },
      metadata: { ip: "203.0.113.45" } },
    { uid: "TXN_W1", amount: 265754, currency: "USD", convertedAmountAUD: 403946, type: "withdrawal", channel: "swift", status: "pending",
      timestamp: daysAgo(4), riskFlags: ["high-risk-jurisdiction", "rapid-movement"], relatedPartyFlag: true,
      sender: { customer: poi._id, name: "MOHAMMAD HOSSAIN" }, beneficiary: { ...SIGMA },
      crypto: { walletAddress: "bc1qseeddemowallet", txHash: "0xseed1", network: "Bitcoin", hops: 2, cluster: "exchange-hosted" },
      forensic: { chainalysisScore: 91 } },
    // No convertedAmountAUD → must never be counted as AUD (doc 74 C11).
    { uid: "TXN_W2", amount: 100000000, currency: "USD", type: "withdrawal", channel: "online", status: "pending",
      timestamp: daysAgo(2), sender: { customer: poi._id, name: "MOHAMMAD HOSSAIN" }, beneficiary: { ...SIGMA } },
    // Both sides are POIs on this case → internal, neither inflow nor outflow.
    { uid: "TXN_I1", amount: 5000, currency: "AUD", type: "transfer", channel: "online-banking", status: "completed",
      timestamp: daysAgo(3), sender: { customer: poi._id, name: "MOHAMMAD" }, receiver: { customer: alsoPoi._id, name: "Second POI" } },
  ]);

  await Device.create({ customer: poi._id, deviceId: "dev-1", purpose: "transaction", ipAddress: "203.0.113.45", country: "NL" });

  alert = await Alert.create({
    customer: poi._id, transaction: txns[0]._id, ruleId: "RULE-CSH-021",
    ruleName: "Cash deposit inconsistent with customer profile", ruleVersion: 2,
    caseType: "AML", riskScore: 55, riskLabel: "Medium", alertOrigin: "Rule Based", createdAt: daysAgo(2),
  });

  caseDoc = await Case.create({
    client: CLIENT, title: "Cash deposit inconsistent with customer profile", createdBy: user._id,
    status: "open", priority: "medium", caseType: "AML",
    customer: poi._id, linkedCustomers: [poi._id, alsoPoi._id],
    linkedAlerts: [alert._id], linkedTransactions: txns.map((t) => t._id),
  });
  // Every transaction above carries the tenant so the client-scoped query sees them.
  await Transaction.updateMany({}, { $set: { client: CLIENT } });
});

const analyse = (opts) => Case.findById(caseDoc._id).lean().then((c) => analysisSvc.analyseCase(c, opts));

// ── AUD normalisation + totals ──────────────────────────────────────────────

describe("totals", () => {
  test("AUD figures use convertedAmountAUD; an unconverted foreign amount is excluded and counted", async () => {
    const a = await analyse();
    expect(a.totals.transactionCount).toBe(5);
    expect(a.totals.depositsAUD).toBe(104511);          // 48,175 + 56,336
    expect(a.totals.withdrawalsAUD).toBe(403946);       // only the converted outflow
    expect(a.totals.unconvertedCount).toBe(1);          // the 100M USD leg (C11)
    expect(a.totals.netFlowAUD).toBe(104511 - 403946);
    expect(a.totals.depositCount).toBe(2);
    expect(a.totals.withdrawalCount).toBe(1);
  });

  test("raw per-currency amounts stay exact even when conversion is missing", async () => {
    const a = await analyse();
    expect(a.byCurrency.deposits).toEqual({ AUD: 104511 });
    expect(a.byCurrency.withdrawals).toEqual({ USD: 100265754 });   // 265,754 + 100,000,000
    expect(a.byCurrency.volume.AUD).toBe(109511);                   // deposits + the internal transfer
  });

  test("largest transaction is the largest KNOWN AUD value, not the biggest raw number", async () => {
    const a = await analyse();
    expect(a.largestTransaction.uid).toBe("TXN_W1");
    expect(a.largestTransaction.amountAUD).toBe(403946);
    expect(a.largestTransaction.direction).toBe("out");
  });

  test("pass-through ratio, peak day, active days and flag counts", async () => {
    const a = await analyse();
    expect(a.ratios.passThrough).toBe(Math.round((403946 / 104511) * 100) / 100);
    expect(a.totals.peakDailyVolumeAUD).toBe(403946);   // the converted outflow's day beats the two deposits' day
    expect(a.totals.activeDays).toBe(4);
    expect(a.totals.flaggedTxnCount).toBe(1);
    expect(a.totals.relatedPartyTxnCount).toBe(1);
    expect(a.counts.byChannel).toEqual({ "branch-counter": 2, swift: 1, online: 1, "online-banking": 1 });
    expect(a.riskFlags["cash-intensive"]).toBe(2);
  });

  test("pass-through is null when there is no inflow to divide by", async () => {
    await Transaction.deleteMany({ type: "deposit" });
    await Case.updateOne({ _id: caseDoc._id }, { $set: { linkedTransactions: [] } });
    const a = await analyse();
    expect(a.ratios.passThrough).toBeNull();
  });
});

// ── Direction ───────────────────────────────────────────────────────────────

describe("direction", () => {
  test("in / out / internal are classified from the POI's side of each transaction", async () => {
    const a = await analyse();
    const byUid = Object.fromEntries(a.transactions.map((t) => [t.uid, t.direction]));
    expect(byUid).toMatchObject({ TXN_D1: "in", TXN_D2: "in", TXN_W1: "out", TXN_W2: "out", TXN_I1: "internal" });
    // An internal move between two POIs is volume, never inflow or outflow.
    expect(a.counts.byDirection.internal).toBe(1);
  });

  test("transaction type wins over the party slots for deposits and withdrawals", async () => {
    // Real sandbox shape: the account holder is recorded as the SENDER of their
    // own cash deposit. Reading the slots alone would call this an outflow.
    const odd = await Transaction.create({
      uid: "TXN_ODD", client: CLIENT, amount: 12000, currency: "AUD", type: "deposit", status: "completed",
      timestamp: daysAgo(2), sender: { customer: poi._id, name: "M" }, receiver: { name: "Sigma Logistics BV" },
    });
    await Case.updateOne({ _id: caseDoc._id }, { $push: { linkedTransactions: odd._id } });

    const a = await analyse();
    expect(a.transactions.find((t) => t.uid === "TXN_ODD").direction).toBe("in");
    expect(a.totals.depositsAUD).toBe(104511 + 12000);
  });

  test("a transaction with no POI on any side is third_party", async () => {
    const stranger = await Transaction.create({
      uid: "TXN_X", client: CLIENT, amount: 100, currency: "AUD", type: "transfer", timestamp: daysAgo(1),
      sender: { name: "Someone" }, receiver: { name: "Someone else" },
    });
    await Case.updateOne({ _id: caseDoc._id }, { $push: { linkedTransactions: stranger._id } });

    const a = await analyse();
    expect(a.transactions.find((t) => t.uid === "TXN_X").direction).toBe("third_party");
    expect(a.totals.depositsAUD).toBe(104511);   // excluded from both sides
    expect(a.totals.withdrawalsAUD).toBe(403946);
  });
});

describe("tenant isolation", () => {
  test("a branch-scoped case sees its own branch plus branch-less activity", async () => {
    const BRANCH = new mongoose.Types.ObjectId();
    const OTHER_BRANCH = new mongoose.Types.ObjectId();
    await Case.updateOne({ _id: caseDoc._id }, { $set: { branch: BRANCH, linkedTransactions: [] } });
    await Transaction.updateMany({}, { $set: { branch: BRANCH } });

    // Another branch of the same client: out of scope for this case.
    await Transaction.create({
      uid: "TXN_OTHER_BRANCH", client: CLIENT, branch: OTHER_BRANCH,
      amount: 5000, currency: "AUD", type: "deposit", status: "completed", timestamp: daysAgo(1),
      receiver: { customer: poi._id, name: "M" },
    });
    // Recorded without a branch: belongs to every branch of the client.
    await Transaction.create({
      uid: "TXN_NO_BRANCH", client: CLIENT,
      amount: 7000, currency: "AUD", type: "deposit", status: "completed", timestamp: daysAgo(1),
      receiver: { customer: poi._id, name: "M" },
    });

    const a = await analyse();
    const uids = a.transactions.map((t) => t.uid);
    expect(uids).toContain("TXN_NO_BRANCH");
    expect(uids).not.toContain("TXN_OTHER_BRANCH");
  });

  test("each POI carries the relation that binds them to this case's tenant", async () => {
    const a = await analyse();
    const subject = a.pois.find((p) => p.role === "subject");
    expect(subject.tenancy).toMatchObject({
      client: String(CLIENT),
      type: "individual",
      relatedToCaseTenant: true,
      otherClientCount: 0,
    });
    expect(subject.tenancy.registeredAt).toBeTruthy();
    expect(a.tenancy).toMatchObject({
      poisSharedWithOtherClients: 0,
      poisNotRelatedToTenant: 0,
    });
  });

  test("a POI onboarded by another client too is counted as shared — the condition that leaks", async () => {
    const otherClient = new mongoose.Types.ObjectId();
    await Customer.updateOne(
      { _id: poi._id },
      { $push: { relations: { client: otherClient, type: "individual", registeredAt: daysAgo(30) } } }
    );

    const a = await analyse();
    const subject = a.pois.find((p) => p.role === "subject");
    expect(subject.tenancy.otherClientCount).toBe(1);
    expect(subject.tenancy.client).toBe(String(CLIENT));   // still bound to THIS case's client
    expect(a.tenancy.poisSharedWithOtherClients).toBe(1);
  });

  test("a POI's transactions under a DIFFERENT client are never counted", async () => {
    // A customer can be onboarded under several clients (Customer.relations[]).
    // Each client's case must only ever see its own transactions — the AI
    // reports service does not scope this way, which is docs/74 C15.
    await Transaction.create({
      uid: "TXN_OTHER_TENANT", client: new mongoose.Types.ObjectId(),
      amount: 999999, currency: "AUD", type: "deposit", status: "completed", timestamp: daysAgo(1),
      receiver: { customer: poi._id, name: "MOHAMMAD HOSSAIN" },
    });

    const a = await analyse();
    expect(a.transactions.map((t) => t.uid)).not.toContain("TXN_OTHER_TENANT");
    expect(a.totals.depositsAUD).toBe(104511);
  });
});

// ── Entities ────────────────────────────────────────────────────────────────

describe("counterparties, institutions and jurisdictions", () => {
  test("counterparties exclude POIs and aggregate by party identity", async () => {
    const a = await analyse();
    expect(a.counterparties).toHaveLength(1);
    expect(a.counterparties[0]).toMatchObject({
      name: "Sigma Logistics BV", account: "NL91ABNA0417164300", institution: "ABN AMRO Bank", transactionCount: 4,
    });
    // Neither POI shows up as its own counterparty.
    expect(a.counterparties.some((c) => c.customer)).toBe(false);
  });

  test("institutions and ISO-2 jurisdictions come off the counterparty side, with a risk band", async () => {
    const a = await analyse();
    expect(a.institutions[0]).toMatchObject({ name: "ABN AMRO Bank", country: "NL" });
    expect(a.jurisdictions[0]).toMatchObject({ code: "NL", name: "Netherlands", highRisk: false });
    expect(a.jurisdictions[0].riskCategory).toMatch(/Risk Country/);
  });

  test("a sanctioned jurisdiction is flagged high-risk", async () => {
    await Transaction.updateOne({ uid: "TXN_W1" }, { $set: { "beneficiary.institutionCountry": "IR" } });
    const a = await analyse();
    expect(a.jurisdictions.find((j) => j.code === "IR")).toMatchObject({ highRisk: true });
    // The same counterparty name routed through two countries stays two rows,
    // so the sanctioned leg cannot be absorbed into the low-risk one.
    expect(a.counterparties.filter((c) => c.name === "Sigma Logistics BV")).toHaveLength(2);
  });

  test("crypto legs and IP evidence are collected from transactions and devices", async () => {
    const a = await analyse();
    expect(a.cryptoAddresses).toHaveLength(1);
    expect(a.cryptoAddresses[0]).toMatchObject({ address: "bc1qseeddemowallet", network: "Bitcoin", hops: 2, chainalysisScore: 91, direction: "out" });
    const ip = a.ipAddresses.find((x) => x.ip === "203.0.113.45");
    expect(ip).toMatchObject({ transactionCount: 2, deviceCount: 1, country: "NL" });
  });

  test("POIs carry the subject role, screening flags and the CRA risk virtuals", async () => {
    const a = await analyse();
    const subject = a.pois.find((p) => p.role === "subject");
    expect(subject).toMatchObject({ name: "MOHAMMAD HOSSAIN", kycStatus: "pending", amlStatus: "yellow", occupation: "Student" });
    expect(subject.expectedVolumeText).toBe("$1,000 – $5,000 per month");
    expect(typeof subject.riskScore).toBe("number");     // computed virtual, not stored
    expect(a.pois.filter((p) => p.role === "linked")).toHaveLength(1);
  });

  test("rules behind the case are grouped by rule", async () => {
    const a = await analyse();
    expect(a.rulesTriggered).toEqual([
      expect.objectContaining({ ruleId: "RULE-CSH-021", ruleVersion: 2, alertCount: 1, alertUids: [alert.uid] }),
    ]);
  });
});

// ── Structuring ─────────────────────────────────────────────────────────────

describe("structuring", () => {
  test("counts sub-threshold deposits and the 24-hour clusters they form", async () => {
    const base = daysAgo(6);
    const extra = await Transaction.create([
      { uid: "TXN_S1", client: CLIENT, amount: 9500, currency: "AUD", type: "deposit", status: "completed", timestamp: base,
        receiver: { customer: poi._id, name: "M" } },
      { uid: "TXN_S2", client: CLIENT, amount: 8600, currency: "AUD", type: "deposit", status: "completed", timestamp: new Date(base.getTime() + 3600e3),
        receiver: { customer: poi._id, name: "M" } },
      // Well outside the window of the pair above → its own (single) group.
      { uid: "TXN_S3", client: CLIENT, amount: 9900, currency: "AUD", type: "deposit", status: "completed", timestamp: daysAgo(1),
        receiver: { customer: poi._id, name: "M" } },
    ]);
    await Case.updateOne({ _id: caseDoc._id }, { $push: { linkedTransactions: { $each: extra.map((t) => t._id) } } });

    const a = await analyse();
    expect(a.structuring.candidates).toBe(3);
    expect(a.structuring.clusters).toBe(1);              // only S1+S2 sit inside 24h
    expect(a.structuring.thresholdAUD).toBe(10000);
    expect(a.structuring.transactions).toEqual(expect.arrayContaining(["TXN_S1", "TXN_S2", "TXN_S3"]));
  });

  test("a deposit at or above the threshold is not a structuring candidate", async () => {
    const a = await analyse();
    expect(a.structuring.candidates).toBe(0);            // 48,175 and 56,336 are over the limit
  });
});

// ── Review window ───────────────────────────────────────────────────────────

describe("review window", () => {
  test("defaults to 30 days before the earliest alert / transaction", async () => {
    const a = await analyse();
    expect(a.window.source).toBe("default");
    const earliest = daysAgo(9).getTime();
    expect(Math.abs(a.window.start.getTime() - (earliest - 30 * 86400e3))).toBeLessThan(60e3);
  });

  test("an explicit window wins and narrows the transactions in scope", async () => {
    // Only the recent end of the period, and drop the explicit links so scope
    // is window-driven. 3.5 days keeps the -3d transfer clear of the boundary.
    await Case.updateOne({ _id: caseDoc._id }, { $set: { linkedTransactions: [] } });
    const a = await analyse({ from: daysAgo(3.5).toISOString() });
    expect(a.window.source).toBe("request");
    expect(a.transactions.map((t) => t.uid).sort()).toEqual(["TXN_I1", "TXN_W2"]);
  });

  test("a saved analyst window is used when the caller passes none", async () => {
    await Case.updateOne({ _id: caseDoc._id }, {
      $set: { linkedTransactions: [], reviewWindow: { start: daysAgo(5), end: new Date(), source: "analyst" } },
    });
    const a = await analyse();
    expect(a.window.source).toBe("analyst");
    expect(a.transactions.map((t) => t.uid).sort()).toEqual(["TXN_I1", "TXN_W1", "TXN_W2"]);
  });

  test("linked transactions stay in scope even when they fall outside the window", async () => {
    const a = await analyse({ from: daysAgo(1).toISOString() });
    expect(a.transactions).toHaveLength(5);              // all five are linked to the case
  });
});

// ── Deterministic report strings ────────────────────────────────────────────

describe("narrativeFacts", () => {
  test("deposit / withdrawal / additional-info strings restate the numbers, flagging the unconverted leg", async () => {
    const a = await analyse();
    expect(a.narrativeFacts.depositDetails).toContain("AUD 104,511.00 across 2 deposit transactions");
    expect(a.narrativeFacts.depositDetails).toContain("- AUD: 104,511.00");
    expect(a.narrativeFacts.depositDetails).toContain("branch-counter (2)");
    expect(a.narrativeFacts.depositDetails).toContain("1 transaction had no AUD conversion");
    expect(a.narrativeFacts.withdrawalDetails).toContain("AUD 403,946.00");
    expect(a.narrativeFacts.withdrawalDetails).toContain("Pass-through ratio");
    expect(a.narrativeFacts.withdrawalDetails).toContain("1 distinct wallet reference");
    expect(a.narrativeFacts.additionalInfo).toContain("1 alert linked to case");
    expect(a.narrativeFacts.additionalInfo).toContain("Case status: open");
  });

  test("empty periods read as sentences, not as zeros", async () => {
    await Transaction.deleteMany({});
    await Case.updateOne({ _id: caseDoc._id }, { $set: { linkedTransactions: [] } });
    const a = await analyse();
    expect(a.narrativeFacts.depositDetails).toBe("No inflows recorded in the review period.");
    expect(a.narrativeFacts.withdrawalDetails).toBe("No outflows recorded in the review period.");
  });
});

// ── Endpoint ────────────────────────────────────────────────────────────────

describe("GET /cases/:id/analysis", () => {
  test("computes, caches the snapshot, and serves the cache on the next call", async () => {
    const first = await call(caseCtrl.getCaseAnalysis, { params: { id: String(caseDoc._id) }, user });
    expect(first.err).toBeNull();
    expect(first.res.body.cached).toBe(false);
    expect(first.res.body.data.totals.depositsAUD).toBe(104511);

    const stored = await Case.findById(caseDoc._id).lean();
    expect(stored.analysis.snapshot.totals.depositsAUD).toBe(104511);

    const second = await call(caseCtrl.getCaseAnalysis, { params: { id: String(caseDoc._id) }, user });
    expect(second.res.body.cached).toBe(true);
  });

  test("refresh=true recomputes, and changing the case invalidates the cache", async () => {
    await call(caseCtrl.getCaseAnalysis, { params: { id: String(caseDoc._id) }, user });

    const forced = await call(caseCtrl.getCaseAnalysis, { params: { id: String(caseDoc._id) }, query: { refresh: "true" }, user });
    expect(forced.res.body.cached).toBe(false);

    // Any save on the case bumps updatedAt past computedAt.
    await Case.updateOne({ _id: caseDoc._id }, { $set: { priority: "high" } });
    const after = await call(caseCtrl.getCaseAnalysis, { params: { id: String(caseDoc._id) }, user });
    expect(after.res.body.cached).toBe(false);
  });

  test("an ad-hoc window is computed but never cached", async () => {
    const r = await call(caseCtrl.getCaseAnalysis, { params: { id: String(caseDoc._id) }, query: { from: daysAgo(3).toISOString() }, user });
    expect(r.res.body.data.window.source).toBe("request");
    const stored = await Case.findById(caseDoc._id).lean();
    expect(stored.analysis.computedAt).toBeNull();
  });

  test("404 for an unknown case and 403 outside the tenant", async () => {
    const missing = await call(caseCtrl.getCaseAnalysis, { params: { id: String(new mongoose.Types.ObjectId()) }, user });
    expect(missing.err.statusCode).toBe(404);

    const otherTenant = { ...user, client: { _id: new mongoose.Types.ObjectId() } };
    const denied = await call(caseCtrl.getCaseAnalysis, { params: { id: String(caseDoc._id) }, user: otherTenant });
    expect(denied.err.statusCode).toBe(403);
  });
});

/* ── Investigation Hub persistence (docs/74 C18) ─────────────────────────── */

describe("cases/:id/investigation", () => {
  let CaseInvestigation;
  beforeAll(() => {
    CaseInvestigation = require("../../models/CaseInvestigation");
  });
  beforeEach(async () => {
    await CaseInvestigation.deleteMany({});
  });

  const load = () => call(caseCtrl.getCaseInvestigation, { params: { id: String(caseDoc._id) }, user });
  const save = (body) =>
    call(caseCtrl.saveCaseInvestigation, { params: { id: String(caseDoc._id) }, body, user });

  test("a case that has never been worked on returns null, not an invented shape", async () => {
    const { res, err } = await load();
    expect(err).toBeNull();
    expect(res.body.data).toBeNull();
  });

  test("the first save creates the record, audits it, and reads back", async () => {
    const first = await save({
      activeStep: 2,
      stepsDone: [true, true, false],
      selections: { 4: ["structuring", "rapid movement"], provided: "yes" },
      customTypologies: ["Cuckoo smurfing"],
      narrativeTemplate: "gfs",
      smr: { part: "C" },
    });
    expect(first.err).toBeNull();
    expect(first.res.statusCode).toBe(201);
    expect(first.res.body.created).toBe(true);

    const { res } = await load();
    expect(res.body.data).toMatchObject({
      activeStep: 2,
      customTypologies: ["Cuckoo smurfing"],
      narrativeTemplate: "gfs",
    });
    expect(res.body.data.selections["4"]).toEqual(["structuring", "rapid movement"]);
    expect(res.body.data.smr.part).toBe("C");
    // Read the stored ref rather than the populated one: `lastSavedBy` is
    // populated for display, and this fixture's user has no Users document.
    const stored = await CaseInvestigation.findOne({ case: caseDoc._id }).lean();
    expect(String(stored.lastSavedBy)).toBe(String(user._id));

    const audits = (await AuditLog.find({ case: caseDoc._id }).lean()).map((a) => a.action);
    expect(audits).toContain("investigation_started");
  });

  test("a later save merges rather than replacing — a partial write cannot blank the rest", async () => {
    await save({ activeStep: 3, narrative: { summary: "Analyst's narrative." }, customReasons: ["Duress"] });

    // A save that only knows about the SMR part must leave the narrative alone.
    const second = await save({ smr: { part: "F" } });
    expect(second.res.statusCode).toBe(200);
    expect(second.res.body.created).toBe(false);

    const { res } = await load();
    expect(res.body.data.narrative.summary).toBe("Analyst's narrative.");
    expect(res.body.data.customReasons).toEqual(["Duress"]);
    expect(res.body.data.smr.part).toBe("F");
    expect(res.body.data.activeStep).toBe(3);
    // Still one record — autosave must never fork an analyst's progress.
    expect(await CaseInvestigation.countDocuments()).toBe(1);
  });

  test("only the analyst's own work is writable", async () => {
    const otherCase = new mongoose.Types.ObjectId();
    await save({ activeStep: 1, case: otherCase, client: otherCase, createdBy: otherCase, lastSavedBy: otherCase });

    const stored = await CaseInvestigation.findOne({ case: caseDoc._id }).lean();
    expect(String(stored.case)).toBe(String(caseDoc._id));        // not repointed
    expect(String(stored.client)).toBe(String(CLIENT));
    expect(String(stored.lastSavedBy)).toBe(String(user._id));    // attribution is ours
  });

  test("audits only the first save, so autosave cannot bury the case's trail", async () => {
    await save({ activeStep: 1 });
    await save({ activeStep: 2 });
    await save({ activeStep: 3 });

    const started = (await AuditLog.find({ case: caseDoc._id }).lean())
      .filter((a) => a.action === "investigation_started");
    expect(started).toHaveLength(1);
  });

  test("404 for an unknown case and 403 outside the tenant", async () => {
    const missing = await call(caseCtrl.getCaseInvestigation, { params: { id: String(new mongoose.Types.ObjectId()) }, user });
    expect(missing.err.statusCode).toBe(404);

    const otherTenant = { ...user, client: { _id: new mongoose.Types.ObjectId() } };
    const denied = await call(caseCtrl.saveCaseInvestigation, { params: { id: String(caseDoc._id) }, body: { activeStep: 1 }, user: otherTenant });
    expect(denied.err.statusCode).toBe(403);
  });
});

describe("PATCH /cases/:id/review-window", () => {
  test("persists the analyst window, recomputes, and audits", async () => {
    const r = await call(caseCtrl.updateReviewWindow, {
      params: { id: String(caseDoc._id) }, body: { start: daysAgo(5).toISOString() }, user,
    });
    expect(r.err).toBeNull();
    expect(r.res.body.data.window.source).toBe("analyst");

    const stored = await Case.findById(caseDoc._id).lean();
    expect(stored.reviewWindow.source).toBe("analyst");
    expect(stored.analysis.snapshot.window.source).toBe("analyst");

    const audits = (await AuditLog.find({ case: caseDoc._id }).lean()).map((a) => a.action);
    expect(audits).toContain("review_window_updated");
  });

  test("an empty body resets to the derived default", async () => {
    await call(caseCtrl.updateReviewWindow, { params: { id: String(caseDoc._id) }, body: { start: daysAgo(5).toISOString() }, user });
    const r = await call(caseCtrl.updateReviewWindow, { params: { id: String(caseDoc._id) }, body: {}, user });
    expect(r.res.body.data.window.source).toBe("default");
    const stored = await Case.findById(caseDoc._id).lean();
    expect(stored.reviewWindow.start).toBeNull();
  });
});
