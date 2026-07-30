/**
 * TrustKyc field reconciliation (docs/65 Step 59) and the settlor_name
 * removal (Step 60).
 *
 * Some facts legitimately live in two places because live writers depend on
 * both paths (the generic identifiers vs. the per-variant restatement of
 * them). Keeping those equal used to be each writer's job, so a trust
 * created by an onboarding form was invisible to queries phrased against the
 * other path. These pin that the MODEL reconciles them, in both directions,
 * on every write path (create, save, and the company writer's upsert).
 *
 * `trust_details.settlor_name` was a third such pair until Step 60, when it
 * was removed outright by owner decision. Because Mongoose drops unknown
 * paths at construction — before any hook can see them — the onboarding
 * forms that still post it are protected by `liftLegacyTrustFields()`, a
 * payload-level shim rather than a schema field. The first describe block
 * pins that the field is really gone AND that those writers don't lose data.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let TrustKyc;
let controller;

function call(handler, { user = {}, body = {}, params = {} } = {}) {
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
    handler({ user, body, params }, res, (err) => resolve({ error: err }));
  });
}
const staff = { userType: "client", role: "client" };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  TrustKyc = require("../../models/TrustKyc");
  controller = require("../../controllers/customerController");
});
afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
afterEach(async () => {
  await TrustKyc.deleteMany({});
});

describe("settlor name: trust_details.settlor_name removed (Step 60)", () => {
  // Resolved lazily — `TrustKyc` is assigned in beforeAll, which runs after
  // the describe body is evaluated.
  const lift = (...args) => TrustKyc.liftLegacyTrustFields(...args);

  test("the retired path is not a schema field any more", async () => {
    const t = await TrustKyc.create({ trust_details: { full_trust_name: "Gone", settlor_name: "Dropped By Mongoose" } });
    expect(t.trust_details.settlor_name).toBeUndefined();
    // Nothing was silently persisted under the old path either.
    const raw = await mongoose.connection.db.collection("trustkycs").findOne({ _id: t._id });
    expect(raw.trust_details.settlor_name).toBeUndefined();
  });

  test("liftLegacyTrustFields moves a legacy payload onto settlor.full_name", async () => {
    const payload = lift({ trust_details: { full_trust_name: "Lifted", settlor_name: "Yang Li" } });
    expect(payload.settlor.full_name).toBe("Yang Li");
    expect(payload.trust_details.settlor_name).toBeUndefined();

    const t = await TrustKyc.create(payload);
    expect(t.settlor.full_name).toBe("Yang Li");
  });

  test("the lift never overwrites a settlor.full_name that is already set", () => {
    const payload = lift({
      trust_details: { full_trust_name: "Both", settlor_name: "Stale Name" },
      settlor: { full_name: "Correct Name" },
    });
    expect(payload.settlor.full_name).toBe("Correct Name");
    expect(payload.trust_details.settlor_name).toBeUndefined();
  });

  test("the lift is safe on payloads with no settlor information at all", () => {
    expect(() => lift(undefined)).not.toThrow();
    const payload = lift({ trust_details: { full_trust_name: "Bare" } });
    expect(payload.settlor).toBeUndefined();
  });

  test("a blank legacy name doesn't create an empty settlor block", () => {
    const payload = lift({ trust_details: { full_trust_name: "Blank", settlor_name: "   " } });
    expect(payload.settlor).toBeUndefined();
    expect(payload.trust_details.settlor_name).toBeUndefined();
  });

  test("no settlor anywhere leaves the canonical field empty rather than inventing one", async () => {
    const t = await TrustKyc.create({ trust_details: { full_trust_name: "No Settlor" } });
    expect(t.settlor?.full_name).toBeUndefined();
  });
});

describe("settlor country of residence derives from the address", () => {
  test("derived when absent", async () => {
    const t = await TrustKyc.create({
      trust_details: { full_trust_name: "Derive" },
      settlor: { full_name: "A", residential_address: { street: "1 St", country: "Australia" } },
    });
    expect(t.settlor.country_of_residence).toBe("Australia");
  });

  test("an explicitly-set value is not overwritten", async () => {
    const t = await TrustKyc.create({
      trust_details: { full_trust_name: "Explicit" },
      settlor: { full_name: "A", country_of_residence: "Singapore", residential_address: { country: "Australia" } },
    });
    expect(t.settlor.country_of_residence).toBe("Singapore");
  });
});

describe("trust identifiers: generic <-> the selected variant's restatement", () => {
  test("a generic ABN is mirrored into the SMSF slot, so the variant index finds it", async () => {
    const t = await TrustKyc.create({
      trust_details: {
        full_trust_name: "SMSF Generic",
        trust_identification: { abn: "11222333444" },
        trust_type: { selected_type: "self_managed_super_fund" },
      },
    });
    expect(t.trust_details.trust_type.self_managed_super_fund.abn).toBe("11222333444");
    // The pre-Step-59 query path now matches a wizard-written record.
    const found = await TrustKyc.findOne({ "trust_details.trust_type.self_managed_super_fund.abn": "11222333444" });
    expect(found).not.toBeNull();
  });

  test("a variant-only ABN is mirrored up into the generic block", async () => {
    const t = await TrustKyc.create({
      trust_details: {
        full_trust_name: "SMSF Variant",
        trust_type: { selected_type: "self_managed_super_fund", self_managed_super_fund: { abn: "55666777888" } },
      },
    });
    expect(t.trust_details.trust_identification.abn).toBe("55666777888");
    const found = await TrustKyc.findOne({ "trust_details.trust_identification.abn": "55666777888" });
    expect(found).not.toBeNull();
  });

  test("registration_number reconciles for an unregulated trust", async () => {
    const t = await TrustKyc.create({
      trust_details: {
        full_trust_name: "Unregulated",
        trust_type: { selected_type: "unregulated_trust", unregulated_trust: { registration_number: "REG-9" } },
      },
    });
    expect(t.trust_details.trust_identification.registration_number).toBe("REG-9");
  });

  test("variant-only facts with no generic counterpart are left alone", async () => {
    const t = await TrustKyc.create({
      trust_details: {
        full_trust_name: "MIS Registered",
        trust_identification: { abn: "11222333444" },
        trust_type: { selected_type: "managed_investment_scheme_registered", managed_investment_scheme_registered: { asrn: "ASRN-1" } },
      },
    });
    expect(t.trust_details.trust_type.managed_investment_scheme_registered.asrn).toBe("ASRN-1");
    // The ABN must NOT be smeared into a variant that has no abn slot.
    expect(t.trust_details.trust_type.managed_investment_scheme_registered.abn).toBeUndefined();
  });

  test("the generic value wins when the two disagree", async () => {
    const t = await TrustKyc.create({
      trust_details: {
        full_trust_name: "Conflict",
        trust_identification: { abn: "11111111111" },
        trust_type: { selected_type: "self_managed_super_fund", self_managed_super_fund: { abn: "99999999999" } },
      },
    });
    expect(t.trust_details.trust_type.self_managed_super_fund.abn).toBe("11111111111");
    expect(t.trust_details.trust_identification.abn).toBe("11111111111");
  });
});

describe("dates promoted out of trust_identification (Step 59 move)", () => {
  test("a legacy write under trust_identification is promoted to trust_details", async () => {
    const t = await TrustKyc.create({
      trust_details: {
        full_trust_name: "Legacy Dates",
        trust_identification: { date_established: "2020-03-01", date_of_deed: "2024-11-07" },
      },
    });
    expect(new Date(t.trust_details.date_established).getUTCFullYear()).toBe(2020);
    expect(new Date(t.trust_details.date_of_deed).getUTCFullYear()).toBe(2024);
  });

  test("a value already on the canonical path is not overwritten by the legacy one", async () => {
    const t = await TrustKyc.create({
      trust_details: {
        full_trust_name: "Both Dates",
        date_of_deed: "2026-01-01",
        trust_identification: { date_of_deed: "2000-01-01" },
      },
    });
    expect(new Date(t.trust_details.date_of_deed).getUTCFullYear()).toBe(2026);
  });
});

describe("appointors are promoted into the controlling-persons register", () => {
  test("each raw name becomes a controlling person with role appointor", async () => {
    const t = await TrustKyc.create({ trust_details: { full_trust_name: "Promote" }, appointors: ["Pat Appointor", "Sam Second"] });
    const names = t.controllers.controlling_persons.map((p) => p.full_name);
    expect(names).toEqual(["Pat Appointor", "Sam Second"]);
    expect(t.controllers.controlling_persons[0].role).toBe("appointor");
  });

  test("promotion is idempotent — repeated saves do not duplicate", async () => {
    const t = await TrustKyc.create({ trust_details: { full_trust_name: "Idempotent" }, appointors: ["Pat Appointor"] });
    await t.save();
    await t.save();
    expect(t.controllers.controlling_persons).toHaveLength(1);
  });

  test("a name already present with richer detail is not duplicated or downgraded", async () => {
    const t = await TrustKyc.create({
      trust_details: { full_trust_name: "Already There" },
      appointors: ["pat appointor"], // different case on purpose
      controllers: { controlling_persons: [{ full_name: "Pat Appointor", role: "appointor", pep_status: "cleared" }] },
    });
    expect(t.controllers.controlling_persons).toHaveLength(1);
    expect(t.controllers.controlling_persons[0].pep_status).toBe("cleared");
  });
});

describe("the company writer's upsert path", () => {
  test("updating a linked trust through resolveTrustLinks persists the canonical settlor", async () => {
    const trust = await TrustKyc.create({ trust_details: { full_trust_name: "Linked Trust" }, settlor: { full_name: "Original" } });

    const res = await call(controller.createCompanyKyc, {
      user: staff,
      body: {
        general_information: { legal_name: "Links To Trust Pty" },
        shareholders: [
          {
            holder_name: "ATF Linked Trust",
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            trust: { id: String(trust._id), trust_details: { full_trust_name: "Linked Trust" }, settlor: { full_name: "Updated Settlor" } },
          },
        ],
      },
    });
    expect(res.status).toBe(201);

    const reloaded = await TrustKyc.findById(trust._id);
    expect(reloaded.settlor.full_name).toBe("Updated Settlor");
  });

  test("a legacy settlor_name arriving through pickTrustPayload is lifted, not dropped", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: staff,
      body: {
        general_information: { legal_name: "Legacy Payload Pty" },
        shareholders: [
          {
            holder_name: "ATF Legacy Trust",
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            // As an older client would send it.
            trust: { trust_details: { full_trust_name: "Legacy Trust", settlor_name: "Yang Li" } },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const linked = await TrustKyc.findById(res.body.data.shareholders[0].holder_entity);
    expect(linked.settlor.full_name).toBe("Yang Li");
  });
});
