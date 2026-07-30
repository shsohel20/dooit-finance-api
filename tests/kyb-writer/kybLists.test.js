/**
 * Company & Trust list endpoints (docs/65 Step 68) — filtering, sorting and
 * pagination against a real Mongo, through the same controllers the routes
 * use. kybListQuery.test.js pins the query BUILDING; this pins the resulting
 * behaviour, including that the controllers still work when invoked without
 * the route middleware (the `?? buildKybListQuery(...)` fallback).
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
    handler({ user, body, params, query }, res, (err) => resolve({ error: err }));
  });
}

const reviewer = { _id: new mongoose.Types.ObjectId(), userType: "client", role: "client" };

const listCompanies = (query) => call(controller.getCompanyKycs, { user: reviewer, query });
const listTrusts = (query) => call(controller.getTrustKycs, { user: reviewer, query });
const names = (res) => res.body.data.map((d) => d.general_information.legal_name);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  controller = require("../../controllers/customerController");
  CompanyKyc = require("../../models/CompanyKyc");
  TrustKyc = require("../../models/TrustKyc");

  // Distinct createdAt so "newest first" is deterministic.
  const at = (n) => new Date(Date.UTC(2026, 0, n));
  const companies = [
    ["Alpha Holdings Pty Ltd", "approved", "proprietary_limited", "active", "Australia", "111111111", 1],
    ["Bravo Trading Pty Ltd", "in_review", "proprietary_limited", "active", "Australia", "222222222", 2],
    ["Charlie Foreign Ltd", "in_review", "foreign_company", "deregistered", "Singapore", "333333333", 3],
    ["Delta A+B (Holdings)", "declined", "public_company", "active", "Australia", "444444444", 4],
  ];
  for (const [legal_name, review_status, entity_type, status, country, reg, day] of companies) {
    await CompanyKyc.create({
      general_information: {
        legal_name,
        entity_type,
        status,
        country_of_incorporation: country,
        registration_number: reg,
      },
      review_status,
      createdAt: at(day),
    });
  }

  const trusts = [
    ["Smith Family Trust", "approved", "unregulated_trust", "Australia", 1],
    ["Jones Super Fund", "in_review", "self_managed_super_fund", "Australia", 2],
    ["Offshore Holdings Trust", "draft", "unregulated_trust", "Singapore", 3],
  ];
  for (const [full_trust_name, review_status, selected_type, country, day] of trusts) {
    await TrustKyc.create({
      trust_details: {
        full_trust_name,
        country_of_establishment: country,
        trust_type: { selected_type },
      },
      review_status,
      createdAt: at(day),
    });
  }
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe("company list", () => {
  test("defaults to newest-first, with a real total", async () => {
    const res = await listCompanies({});
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(names(res)[0]).toBe("Delta A+B (Holdings)");
  });

  test("filters by review status", async () => {
    const res = await listCompanies({ review_status: "in_review" });
    expect(res.body.total).toBe(2);
    expect(names(res).sort()).toEqual(["Bravo Trading Pty Ltd", "Charlie Foreign Ltd"]);
  });

  test("filters compose (entity type + country)", async () => {
    const res = await listCompanies({ entity_type: "proprietary_limited", country: "Australia" });
    expect(names(res).sort()).toEqual(["Alpha Holdings Pty Ltd", "Bravo Trading Pty Ltd"]);
  });

  test("filters by registry status independently of review status", async () => {
    const res = await listCompanies({ status: "deregistered" });
    expect(names(res)).toEqual(["Charlie Foreign Ltd"]);
  });

  test("search matches the legal name", async () => {
    const res = await listCompanies({ search: "bravo" });
    expect(names(res)).toEqual(["Bravo Trading Pty Ltd"]);
  });

  test("search matches a registration number", async () => {
    const res = await listCompanies({ search: "333333333" });
    expect(names(res)).toEqual(["Charlie Foreign Ltd"]);
  });

  test("search treats regex metacharacters literally", async () => {
    // "A+B" must not behave as a quantifier — this is why escapeRegExp exists.
    const res = await listCompanies({ search: "A+B (Holdings)" });
    expect(names(res)).toEqual(["Delta A+B (Holdings)"]);
  });

  test("sorts by legal name in both directions", async () => {
    const asc = await listCompanies({ sort: "general_information.legal_name" });
    expect(names(asc)[0]).toBe("Alpha Holdings Pty Ltd");
    const desc = await listCompanies({ sort: "-general_information.legal_name" });
    expect(names(desc)[0]).toBe("Delta A+B (Holdings)");
  });

  test("an unwhitelisted sort falls back to newest-first instead of reaching the planner", async () => {
    const res = await listCompanies({ sort: "general_information.annual_income" });
    expect(names(res)[0]).toBe("Delta A+B (Holdings)");
  });

  test("paginates, and total describes the whole filtered set, not the page", async () => {
    const p1 = await listCompanies({ limit: 2, page: 1, sort: "general_information.legal_name" });
    const p2 = await listCompanies({ limit: 2, page: 2, sort: "general_information.legal_name" });
    expect(p1.body).toMatchObject({ total: 4, pages: 2, page: 1, count: 2 });
    expect(names(p1)).toEqual(["Alpha Holdings Pty Ltd", "Bravo Trading Pty Ltd"]);
    expect(names(p2)).toEqual(["Charlie Foreign Ltd", "Delta A+B (Holdings)"]);
  });

  test("pagination respects the active filter", async () => {
    const res = await listCompanies({ review_status: "in_review", limit: 1, page: 2 });
    expect(res.body).toMatchObject({ total: 2, pages: 2, count: 1 });
  });

  test("an unknown query param cannot become a filter", async () => {
    // Generic advancedResults would have turned this into model.find({...}).
    const res = await listCompanies({ "general_information.legal_name": "Alpha Holdings Pty Ltd", nonsense: "x" });
    expect(res.body.total).toBe(4);
  });
});

describe("trust list", () => {
  const trustNames = (res) => res.body.data.map((d) => d.trust_details.full_trust_name);

  test("defaults to newest-first with a real total", async () => {
    const res = await listTrusts({});
    expect(res.body.total).toBe(3);
    expect(trustNames(res)[0]).toBe("Offshore Holdings Trust");
  });

  test("filters by trust type and by country", async () => {
    expect(trustNames(await listTrusts({ trust_type: "self_managed_super_fund" }))).toEqual(["Jones Super Fund"]);
    expect(trustNames(await listTrusts({ country: "Singapore" }))).toEqual(["Offshore Holdings Trust"]);
  });

  test("filters by review status", async () => {
    expect(trustNames(await listTrusts({ review_status: "approved" }))).toEqual(["Smith Family Trust"]);
  });

  test("searches the trust name", async () => {
    expect(trustNames(await listTrusts({ search: "family" }))).toEqual(["Smith Family Trust"]);
  });

  test("sorts by trust name", async () => {
    const res = await listTrusts({ sort: "trust_details.full_trust_name" });
    expect(trustNames(res)[0]).toBe("Jones Super Fund");
  });

  test("paginates", async () => {
    const res = await listTrusts({ limit: 2, page: 2, sort: "trust_details.full_trust_name" });
    expect(res.body).toMatchObject({ total: 3, pages: 2, page: 2, count: 1 });
  });

  test("a company-only sort field does not leak into the trust list", async () => {
    const res = await listTrusts({ sort: "general_information.legal_name" });
    expect(trustNames(res)[0]).toBe("Offshore Holdings Trust"); // fell back to -createdAt
  });
});
