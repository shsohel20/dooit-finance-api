/**
 * Case persons of interest who are not customers, and the POI picker.
 *
 *   GET    /cases/:id/poi-candidates   customers (?q=) + every party on linked alerts
 *   POST   /cases/:id/pois             manual entry · fromAlert { alertId, slot }
 *   PATCH  /cases/:id/pois/:poiId
 *   DELETE /cases/:id/pois/:poiId
 *
 * Same harness as caseLinking.test.js: in-memory Mongo, handlers called
 * directly with a stub req/res/next.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Case, Alert, Transaction, Customer, AuditLog, caseCtrl, validation;

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

// Run a validator middleware; resolves to the error it passed to next (or null).
const validate = (mw, body) => new Promise((resolve) => mw({ body }, {}, (e) => resolve(e || null)));

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
  AuditLog = require("../../models/AuditLog");
  caseCtrl = require("../../controllers/caseController");
  validation = require("../../middleware/caseValidation");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const CLIENT = new mongoose.Types.ObjectId();
const OTHER_CLIENT = new mongoose.Types.ObjectId();
const user = { _id: new mongoose.Types.ObjectId(), name: "Ayesha Rahman", role: "admin", client: { _id: CLIENT } };

let subject, linkedCp, txn, alert, caseDoc;

beforeEach(async () => {
  await Promise.all([Case.deleteMany({}), Alert.deleteMany({}), Transaction.deleteMany({}), Customer.deleteMany({}), AuditLog.deleteMany({})]);
  const relations = [{ client: CLIENT, type: "individual", registeredAt: new Date("2026-06-01") }];
  subject = await Customer.create({ country: "AU", relations });
  linkedCp = await Customer.create({ country: "NZ", relations });

  // Subject sends to an EXTERNAL receiver (no customer) via an intermediary
  // who IS one of our customers.
  txn = await Transaction.create({
    amount: 98000, currency: "AUD", type: "transfer", timestamp: new Date(),
    sender: { customer: subject._id, name: "Subject" },
    receiver: { name: "Oceanic Freight Ltd", account: "GB29NWBK60161331926819", institution: "NatWest", institutionCountry: "GB", bic: "NWBKGB2L" },
    intermediary: { customer: linkedCp._id, name: "Linked CP" },
  });
  alert = await Alert.create({
    customer: subject._id, transaction: txn._id, caseType: "AML",
    riskScore: 70, riskLabel: "High", alertOrigin: "Rule Based", ruleId: "R-9", ruleName: "Structuring",
  });
  caseDoc = await Case.create({
    title: "POI case", createdBy: user._id, client: CLIENT,
    customer: subject._id, linkedCustomers: [subject._id],
    linkedAlerts: [alert._id], linkedTransactions: [txn._id],
  });
});

describe("POST /cases/:id/pois — manual entry", () => {
  test("adds a non-customer POI with identifying detail, and audits it", async () => {
    const { res, err } = await call(caseCtrl.addPoi, {
      params: { id: String(caseDoc._id) },
      user,
      body: {
        kind: "individual", name: "  Mei Lin Chow ", role: "associated_party",
        relationship: "Sister of the subject", dateOfBirth: "1988-04-02", nationality: "MY",
        idDocument: { type: "passport", number: "A1234567", country: "MY" },
        email: "Mei@Example.com", notes: "Named in RFI response",
        // Provenance cannot be claimed from the body.
        source: "alert", sourceAlert: String(alert._id),
      },
    });
    expect(err).toBeNull();
    expect(res.statusCode).toBe(201);

    const [poi] = res.body.data.externalPois;
    expect(poi.name).toBe("Mei Lin Chow");
    expect(poi.email).toBe("mei@example.com");
    expect(poi.idDocument.number).toBe("A1234567");
    expect(poi.source).toBe("manual");
    expect(poi.sourceAlert).toBeNull();
    expect(String(poi.addedBy)).toBe(String(user._id));

    const logs = await AuditLog.find({ case: caseDoc._id, action: "poi_added" }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatch(/Mei Lin Chow.*manual entry/);
  });

  test("the validator rejects a missing name, bad role, future DOB and a bad email", async () => {
    const e = await validate(validation.validateAddPoi, {
      name: " ", role: "boss", dateOfBirth: "2999-01-01", email: "nope",
    });
    expect(e.statusCode).toBe(400);
    expect(e.message).toMatch(/name is required/);
    expect(e.message).toMatch(/role must be one of/);
    expect(e.message).toMatch(/dateOfBirth cannot be in the future/);
    expect(e.message).toMatch(/email must be a valid/);
    expect(await validate(validation.validateAddPoi, { name: "Ok" })).toBeNull();
  });

  test("an investigator not assigned to the case cannot add POIs", async () => {
    const { err } = await call(caseCtrl.addPoi, {
      params: { id: String(caseDoc._id) },
      user: { ...user, role: "investigator" },
      body: { name: "Someone" },
    });
    expect(err.statusCode).toBe(403);
  });
});

describe("POST /cases/:id/pois — from an alert party", () => {
  test("prefills from the transaction party and records provenance", async () => {
    const { res, err } = await call(caseCtrl.addPoi, {
      params: { id: String(caseDoc._id) },
      user,
      body: { fromAlert: { alertId: String(alert._id), slot: "receiver" }, kind: "entity", notes: "Shell co?" },
    });
    expect(err).toBeNull();
    const [poi] = res.body.data.externalPois;
    expect(poi).toMatchObject({
      name: "Oceanic Freight Ltd", kind: "entity", role: "counterparty",
      account: "GB29NWBK60161331926819", institution: "NatWest", bic: "NWBKGB2L",
      source: "alert", sourcePartySlot: "receiver", sourceAlertUid: alert.uid, notes: "Shell co?",
    });
    expect(String(poi.sourceTransaction)).toBe(String(txn._id));
  });

  test("the same party cannot be added twice", async () => {
    const body = { fromAlert: { alertId: String(alert._id), slot: "receiver" } };
    await call(caseCtrl.addPoi, { params: { id: String(caseDoc._id) }, user, body });
    const { err } = await call(caseCtrl.addPoi, { params: { id: String(caseDoc._id) }, user, body });
    expect(err.statusCode).toBe(409);
  });

  test("a party who is a customer must go through the customer link instead", async () => {
    const { err } = await call(caseCtrl.addPoi, {
      params: { id: String(caseDoc._id) }, user,
      body: { fromAlert: { alertId: String(alert._id), slot: "intermediary" } },
    });
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/customer POI/);
  });

  test("an alert not linked to this case is refused", async () => {
    const stray = await Alert.create({ customer: subject._id, transaction: txn._id, riskScore: 10, riskLabel: "Low" });
    const { err } = await call(caseCtrl.addPoi, {
      params: { id: String(caseDoc._id) }, user,
      body: { fromAlert: { alertId: String(stray._id), slot: "receiver" } },
    });
    expect(err.statusCode).toBe(400);
  });

  test("an empty slot is refused", async () => {
    const { err } = await call(caseCtrl.addPoi, {
      params: { id: String(caseDoc._id) }, user,
      body: { fromAlert: { alertId: String(alert._id), slot: "beneficiary" } },
    });
    expect(err.statusCode).toBe(400);
  });
});

describe("PATCH / DELETE /cases/:id/pois/:poiId", () => {
  let poiId;
  beforeEach(async () => {
    const { res } = await call(caseCtrl.addPoi, {
      params: { id: String(caseDoc._id) }, user,
      body: { fromAlert: { alertId: String(alert._id), slot: "receiver" } },
    });
    poiId = String(res.body.data.externalPois[0]._id);
  });

  test("edits fields but never provenance", async () => {
    const { res, err } = await call(caseCtrl.updatePoi, {
      params: { id: String(caseDoc._id), poiId }, user,
      body: {
        role: "subject", registrationNumber: "0999", address: "",
        source: "manual", sourcePartySlot: "sender", account: "SOMETHING-ELSE",
      },
    });
    expect(err).toBeNull();
    const [poi] = res.body.data.externalPois;
    expect(poi.role).toBe("subject");
    expect(poi.account).toBe("GB29NWBK60161331926819");
    expect(poi.registrationNumber).toBe("0999");
    expect(poi.address).toBeNull();
    expect(poi.source).toBe("alert");
    expect(poi.sourcePartySlot).toBe("receiver");
    expect(await AuditLog.countDocuments({ action: "poi_updated" })).toBe(1);
  });

  test("removes one, and 404s on an unknown id", async () => {
    const { res } = await call(caseCtrl.removePoi, { params: { id: String(caseDoc._id), poiId }, user });
    expect(res.body.data.externalPois).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: "poi_removed" })).toBe(1);

    const again = await call(caseCtrl.removePoi, { params: { id: String(caseDoc._id), poiId }, user });
    expect(again.err.statusCode).toBe(404);
  });
});

describe("GET /cases/:id/poi-candidates", () => {
  test("lists every party on the linked alerts, flagged when already a POI", async () => {
    const { res, err } = await call(caseCtrl.getPoiCandidates, { params: { id: String(caseDoc._id) }, user });
    expect(err).toBeNull();
    const [group] = res.body.data.alerts;
    expect(group.alertId).toBe(String(alert._id));
    expect(group.rule).toBe("R-9: Structuring");

    const bySlot = Object.fromEntries(group.parties.map((p) => [p.slot, p]));
    // The alert's own customer is listed once, as the subject — not again as sender.
    expect(bySlot.alert_subject.alreadyPoi).toBe(true);
    expect(bySlot.sender).toBeUndefined();
    // Registered intermediary: a customer, not yet on the case.
    expect(bySlot.intermediary.customer.id).toBe(String(linkedCp._id));
    expect(bySlot.intermediary.alreadyPoi).toBe(false);
    // External receiver: carries its identifiers.
    expect(bySlot.receiver).toMatchObject({ name: "Oceanic Freight Ltd", customer: null, alreadyPoi: false, bic: "NWBKGB2L" });

    // No q → no customer search.
    expect(res.body.data.customers).toEqual([]);
  });

  test("an external party already added reports its POI id", async () => {
    await call(caseCtrl.addPoi, {
      params: { id: String(caseDoc._id) }, user,
      body: { fromAlert: { alertId: String(alert._id), slot: "receiver" } },
    });
    const { res } = await call(caseCtrl.getPoiCandidates, { params: { id: String(caseDoc._id) }, user });
    const receiver = res.body.data.alerts[0].parties.find((p) => p.slot === "receiver");
    expect(receiver.alreadyPoi).toBe(true);
    expect(receiver.externalPoiId).toBeTruthy();
  });

  test("customer search is scoped to the case's tenant", async () => {
    // Search only covers active customers; the pre-save hook mints its own
    // uid, so pin a known one afterwards.
    const make = async (uid, client) => {
      const c = await Customer.create({ country: "AU", isActive: true, relations: [{ client, type: "individual" }] });
      await Customer.collection.updateOne({ _id: c._id }, { $set: { uid } });
      return c;
    };
    await make("CUS-FOREIGN-1", OTHER_CLIENT);
    const mine = await make("CUS-MINE-1", CLIENT);

    const { res } = await call(caseCtrl.getPoiCandidates, { params: { id: String(caseDoc._id) }, query: { q: "cus-" }, user });
    const uids = res.body.data.customers.map((c) => c.uid);
    expect(uids).toContain("CUS-MINE-1");
    expect(uids).not.toContain("CUS-FOREIGN-1");
    expect(res.body.data.customers.find((c) => c.uid === "CUS-MINE-1")).toMatchObject({ id: mine._id, alreadyPoi: false });
  });
});
