/**
 * Companies-list analytics (docs/65 Step 58): GET /customer/company/stats.
 *
 * The point of this endpoint is that it counts the WHOLE collection —
 * `getCompanyKycs` is paginated (default 25, cap 200), so a dashboard tallied
 * from the list response would silently report on page one only. The headline
 * test here seeds more companies than the list's default page size and asserts
 * the stats total still matches reality.
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

const staff = { userType: "client", role: "client" };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  controller = require("../../controllers/customerController");
  CompanyKyc = require("../../models/CompanyKyc");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(async () => {
  await CompanyKyc.deleteMany({});
});

const stats = async () => {
  const r = await call(controller.getCompanyKycStats, { user: staff });
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(200);
  return r.body.data;
};

test("empty collection -> all zeroes, dense 12-month trend", async () => {
  const d = await stats();
  expect(d.total).toBe(0);
  expect(d.attention.ubo_unresolved).toBe(0);
  // Dense series: 12 zero-filled points even with no data at all.
  expect(d.trend).toHaveLength(12);
  expect(d.trend.every((p) => p.count === 0)).toBe(true);
  expect(d.trend[11].month).toMatch(/^\d{4}-\d{2}$/);
});

test("counts the whole collection, not just the list endpoint's first page", async () => {
  // 30 > the list default page size of 25 — the exact gap this endpoint exists to close.
  await CompanyKyc.create(
    Array.from({ length: 30 }, (_, i) => ({
      general_information: { legal_name: `Bulk Co ${i}`, entity_type: "proprietary_limited", status: "active" },
    })),
  );

  const list = await call(controller.getCompanyKycs, { user: staff, query: {} });
  expect(list.body.data).toHaveLength(25); // paginated…
  expect((await stats()).total).toBe(30); // …but the dashboard still reports all 30
});

test("groups by review status, registry status, entity type and country", async () => {
  await CompanyKyc.create([
    { general_information: { legal_name: "A", entity_type: "proprietary_limited", status: "active", country_of_incorporation: "Australia" }, review_status: "in_review" },
    { general_information: { legal_name: "B", entity_type: "proprietary_limited", status: "active", country_of_incorporation: "Australia" }, review_status: "approved" },
    { general_information: { legal_name: "C", entity_type: "foreign_company", status: "deregistered", country_of_incorporation: "Singapore" }, review_status: "approved" },
  ]);

  const d = await stats();
  expect(d.total).toBe(3);
  expect(d.by_review_status).toEqual({ in_review: 1, approved: 2 });
  expect(d.by_registry_status).toEqual({ active: 2, deregistered: 1 });
  expect(d.by_entity_type).toEqual({ proprietary_limited: 2, foreign_company: 1 });
  // Sorted by count desc, blanks excluded.
  expect(d.by_country[0]).toEqual({ country: "Australia", count: 2 });
  expect(d.by_country).toHaveLength(2);
});

describe("ubo_unresolved mirrors the Review page's rule and the ubos virtual thresholds", () => {
  const withParent = (name, owners) => ({
    general_information: { legal_name: name },
    related_entities: [{ relation: "parent", name: "Offshore Holdings", jurisdiction: "Delaware, US" }],
    directors_beneficial_owner: { beneficial_owners: owners },
  });

  test("a parent with no qualifying beneficial owner counts as unresolved", async () => {
    await CompanyKyc.create([
      withParent("No owners at all", []),
      withParent("Owner below the 25% test", [{ full_name: "Small", ownership_percent: 10, control_type: "ownership" }]),
    ]);
    expect((await stats()).attention.ubo_unresolved).toBe(2);
  });

  test("any of the three qualifying signals resolves it", async () => {
    await CompanyKyc.create([
      withParent("By ownership", [{ full_name: "A", ownership_percent: 25, control_type: "ownership" }]),
      withParent("By voting", [{ full_name: "B", voting_percent: 30, control_type: "voting_rights" }]),
      withParent("By other means", [{ full_name: "C", ownership_percent: 1, control_type: "other_means" }]),
    ]);
    expect((await stats()).attention.ubo_unresolved).toBe(0);
  });

  test("no parent entity -> not counted, however few owners it has", async () => {
    await CompanyKyc.create({ general_information: { legal_name: "Standalone" }, directors_beneficial_owner: { beneficial_owners: [] } });
    expect((await stats()).attention.ubo_unresolved).toBe(0);
  });
});

test("document attention counts split expired / expiring-soon / rejected / none", async () => {
  const day = 24 * 60 * 60 * 1000;
  await CompanyKyc.create([
    { general_information: { legal_name: "Expired doc" }, documents: [{ name: "a", expiry_date: new Date(Date.now() - 5 * day) }] },
    { general_information: { legal_name: "Expiring soon" }, documents: [{ name: "b", expiry_date: new Date(Date.now() + 10 * day) }] },
    { general_information: { legal_name: "Far future" }, documents: [{ name: "c", expiry_date: new Date(Date.now() + 900 * day) }] },
    { general_information: { legal_name: "Rejected doc" }, documents: [{ name: "d", verification_status: "rejected" }] },
    { general_information: { legal_name: "No docs" }, documents: [] },
  ]);

  const a = (await stats()).attention;
  expect(a.docs_expired).toBe(1);
  expect(a.docs_expiring_soon).toBe(1); // the far-future one is excluded
  expect(a.docs_rejected).toBe(1);
  expect(a.no_documents).toBe(1);
});

test("screening_pending and with_trust_holders", async () => {
  await CompanyKyc.create([
    { general_information: { legal_name: "Pending screen" }, appointments: [{ role: "director", given_name: "P", screening_status: "pending" }] },
    { general_information: { legal_name: "Cleared screen" }, appointments: [{ role: "director", given_name: "C", screening_status: "cleared" }] },
    {
      general_information: { legal_name: "Trust holder" },
      shareholders: [{ holder_name: "ATF Trust", holder_model: "TrustKyc", holder_entity: new mongoose.Types.ObjectId() }],
    },
  ]);

  const d = await stats();
  expect(d.attention.screening_pending).toBe(1);
  expect(d.with_trust_holders).toBe(1);
});

describe("Company Dashboard panels (docs/65 Step 58)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("added_last_30_days counts only the recent window", async () => {
    await CompanyKyc.create([{ general_information: { legal_name: "Recent" } }, { general_information: { legal_name: "Recent 2" } }]);
    // Backdate one beyond the window (createdAt is set by timestamps, so
    // it has to be pushed back after insert).
    const old = await CompanyKyc.create({ general_information: { legal_name: "Old" } });
    await CompanyKyc.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 90 * DAY) } });

    const d = await stats();
    expect(d.total).toBe(3);
    expect(d.added_last_30_days).toBe(2);
  });

  test("median_days_to_approval uses the median, not the mean", async () => {
    // 2, 4, and 30 days: median 4, mean 12 — the outlier must not win.
    const specs = [2, 4, 30];
    for (const dayCount of specs) {
      const created = new Date(Date.now() - (dayCount + 1) * DAY);
      const doc = await CompanyKyc.create({
        general_information: { legal_name: `Approved after ${dayCount}d` },
        review_status: "approved",
        review_history: [{ status: "approved", changedAt: new Date(created.getTime() + dayCount * DAY) }],
      });
      await CompanyKyc.collection.updateOne({ _id: doc._id }, { $set: { createdAt: created } });
    }
    expect((await stats()).review_timing.median_days_to_approval).toBe(4);
  });

  test("median_days_to_approval is null when nothing has been approved", async () => {
    await CompanyKyc.create({ general_information: { legal_name: "Never approved" }, review_status: "in_review" });
    expect((await stats()).review_timing.median_days_to_approval).toBeNull();
  });

  test("oldest_in_review names the longest-waiting file and its age", async () => {
    const older = await CompanyKyc.create({ general_information: { legal_name: "Harbourline Trust" }, review_status: "in_review" });
    await CompanyKyc.collection.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 19 * DAY) } });
    await CompanyKyc.create({ general_information: { legal_name: "Newer file" }, review_status: "in_review" });
    // An approved file is not "in review" however old it is.
    const ancient = await CompanyKyc.create({ general_information: { legal_name: "Ancient approved" }, review_status: "approved" });
    await CompanyKyc.collection.updateOne({ _id: ancient._id }, { $set: { createdAt: new Date(Date.now() - 400 * DAY) } });

    const o = (await stats()).review_timing.oldest_in_review;
    expect(o.legal_name).toBe("Harbourline Trust");
    expect(o.days).toBe(19);
  });

  test("document_coverage: overall share plus per-type, de-duplicated per company", async () => {
    await CompanyKyc.create([
      {
        general_information: { legal_name: "Well documented" },
        // Two copies of the same type must count once for that company.
        documents: [{ name: "a", docType: "certificate_of_incorporation" }, { name: "a2", docType: "certificate_of_incorporation" }, { name: "b", docType: "constitution" }],
      },
      { general_information: { legal_name: "Partly documented" }, documents: [{ name: "c", docType: "certificate_of_incorporation" }] },
      { general_information: { legal_name: "Bare" }, documents: [] },
      { general_information: { legal_name: "Bare 2" } },
    ]);

    const dc = (await stats()).document_coverage;
    expect(dc.with_any_document).toBe(2);
    expect(dc.overall_pct).toBe(50); // 2 of 4
    const cert = dc.by_type.find((t) => t.doc_type === "certificate_of_incorporation");
    expect(cert.count).toBe(2); // not 3 — the duplicate on one company collapses
    expect(cert.pct).toBe(50);
    expect(dc.by_type.find((t) => t.doc_type === "constitution").count).toBe(1);
  });

  test("document_coverage ignores untyped documents rather than bucketing them blank", async () => {
    await CompanyKyc.create({ general_information: { legal_name: "Untyped" }, documents: [{ name: "x" }] });
    const dc = (await stats()).document_coverage;
    expect(dc.with_any_document).toBe(1);
    expect(dc.by_type).toHaveLength(0);
  });
});

test("trend buckets by month and stays dense across the 12-month window", async () => {
  await CompanyKyc.create([
    { general_information: { legal_name: "Now 1" } },
    { general_information: { legal_name: "Now 2" } },
  ]);
  const d = await stats();
  expect(d.trend).toHaveLength(12);
  // Both land in the current (last) bucket; earlier months stay zero-filled.
  expect(d.trend[11].count).toBe(2);
  expect(d.trend.slice(0, 11).every((p) => p.count === 0)).toBe(true);
});
