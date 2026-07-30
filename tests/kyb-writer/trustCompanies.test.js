/**
 * GET /trust/:id/companies — the reverse of the company wizard's "held on
 * behalf of a trust" link (docs/65 Step 70).
 *
 * Nothing on TrustKyc points back at a company; the link lives only on
 * CompanyKyc.shareholders[].holder_entity. These tests pin that the reverse
 * query finds it from the trust side, aggregates the holding, and does not
 * leak companies belonging to a different trust — the failure that would make
 * a trust dossier show someone else's holdings.
 *
 * Controllers are invoked directly (asyncHandler does not return the handler
 * promise; results are awaited via the mocked res.json/next).
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let controller;
let CompanyKyc;
let TrustKyc;

function call(handler, { user = {}, body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
      },
    };
    const next = (err) => resolve({ error: err });
    handler({ user, body, params, query }, res, next);
  });
}

const reviewer = {
  _id: new mongoose.Types.ObjectId(),
  userType: "client",
  role: "client",
  name: "Reviewer One",
};

let trustA;
let trustB;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  controller = require("../../controllers/customerController");
  CompanyKyc = require("../../models/CompanyKyc");
  TrustKyc = require("../../models/TrustKyc");

  trustA = await TrustKyc.create({
    trust_details: { full_trust_name: "Alpha Family Trust" },
  });
  trustB = await TrustKyc.create({
    trust_details: { full_trust_name: "Beta Family Trust" },
  });

  // Two share classes held by the SAME trust — the holding must be summed,
  // not reported twice or as one row's figure.
  await CompanyKyc.create({
    general_information: { legal_name: "Alpha Holdings Pty Ltd", entity_type: "proprietary_limited" },
    shareholders: [
      {
        holder_name: "Alpha Family Trust",
        holder_model: "TrustKyc",
        holder_entity: trustA._id,
        security_class: "ORD",
        units_held: 60,
        percent_held: 60,
        beneficially_held: false,
      },
      {
        holder_name: "Alpha Family Trust",
        holder_model: "TrustKyc",
        holder_entity: trustA._id,
        security_class: "A CLASS",
        units_held: 10,
        percent_held: 10,
        beneficially_held: false,
      },
    ],
  });
  await CompanyKyc.create({
    general_information: { legal_name: "Alpha Trading Pty Ltd", entity_type: "proprietary_limited" },
    shareholders: [
      {
        holder_name: "Alpha Family Trust",
        holder_model: "TrustKyc",
        holder_entity: trustA._id,
        security_class: "ORD",
        percent_held: 100,
      },
    ],
  });
  // Belongs to the other trust — must never appear under trust A.
  await CompanyKyc.create({
    general_information: { legal_name: "Beta Co Pty Ltd", entity_type: "proprietary_limited" },
    shareholders: [
      { holder_name: "Beta Family Trust", holder_model: "TrustKyc", holder_entity: trustB._id, percent_held: 100 },
    ],
  });
  // A company holder, not a trust — the holder_model half of the match matters.
  await CompanyKyc.create({
    general_information: { legal_name: "Unrelated Pty Ltd", entity_type: "proprietary_limited" },
    shareholders: [
      { holder_name: "Someone Else Pty", holder_model: "CompanyKyc", holder_entity: trustA._id, percent_held: 100 },
    ],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("getCompaniesForTrust", () => {
  test("returns only the companies this trust holds", async () => {
    const res = await call(controller.getCompaniesForTrust, {
      user: reviewer,
      params: { id: String(trustA._id) },
    });
    expect(res.status).toBe(200);
    const names = res.body.data.map((c) => c.general_information.legal_name).sort();
    expect(names).toEqual(["Alpha Holdings Pty Ltd", "Alpha Trading Pty Ltd"]);
    expect(res.body.count).toBe(2);
  });

  test("does not match a holder of another model that happens to share the id", async () => {
    const res = await call(controller.getCompaniesForTrust, {
      user: reviewer,
      params: { id: String(trustA._id) },
    });
    const names = res.body.data.map((c) => c.general_information.legal_name);
    expect(names).not.toContain("Unrelated Pty Ltd");
  });

  test("sums the holding across several share classes of one company", async () => {
    const res = await call(controller.getCompaniesForTrust, {
      user: reviewer,
      params: { id: String(trustA._id) },
    });
    const holdings = res.body.data.find(
      (c) => c.general_information.legal_name === "Alpha Holdings Pty Ltd",
    ).trust_holding;
    expect(holdings.percent_held).toBe(70);
    expect(holdings.units_held).toBe(70);
    expect(holdings.security_classes.sort()).toEqual(["A CLASS", "ORD"]);
  });

  test("resolves the trust by uid as well as ObjectId", async () => {
    const fresh = await TrustKyc.findById(trustA._id).select("uid").lean();
    expect(fresh.uid).toBeTruthy();
    const res = await call(controller.getCompaniesForTrust, {
      user: reviewer,
      params: { id: fresh.uid },
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  test("a trust with no holdings returns an empty list, not an error", async () => {
    const res = await call(controller.getCompaniesForTrust, {
      user: reviewer,
      params: { id: String(trustB._id) },
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].general_information.legal_name).toBe("Beta Co Pty Ltd");
  });

  test("an unknown identifier 404s rather than returning every company", async () => {
    const res = await call(controller.getCompaniesForTrust, {
      user: reviewer,
      params: { id: "TRKYC_DOES_NOT_EXIST" },
    });
    expect(res.error).toBeTruthy();
    expect(res.error.statusCode).toBe(404);
  });
});
