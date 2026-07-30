/**
 * Phase-1 integrity pack (docs/65 Step 30).
 *
 * Pins the KYB hardening pass: schema enums/bounds (with empty-string
 * coercion so legacy writers that submit "" for untouched selects keep
 * working), email validation, uid collision guard, duplicate-registration
 * 409s on create AND update, literal (escaped) search, and the removal of
 * the dead client/branch populates that crashed uid/sequence lookups on
 * CompanyKyc and EVERY GET /trust/:id branch under Mongoose 8.
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

const asClient = { userType: "client", role: "client" };
const minimal = (name, reg) => ({
  general_information: { legal_name: name, registration_number: reg },
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  controller = require("../../controllers/customerController");
  CompanyKyc = require("../../models/CompanyKyc");
  TrustKyc = require("../../models/TrustKyc");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("schema validation (R1)", () => {
  test("off-enum entity_type is rejected with a ValidationError", async () => {
    const r = await call(controller.createCompanyKyc, {
      user: asClient,
      body: {
        general_information: { legal_name: "Bad Enum Pty Ltd", entity_type: "banana" },
      },
    });
    expect(r.error?.name).toBe("ValidationError");
  });

  test("ownership_percent above 100 is rejected", async () => {
    const r = await call(controller.createCompanyKyc, {
      user: asClient,
      body: {
        general_information: { legal_name: "Bad Percent Pty Ltd" },
        directors_beneficial_owner: {
          beneficial_owners: [{ full_name: "X", ownership_percent: 800 }],
        },
      },
    });
    expect(r.error?.name).toBe("ValidationError");
  });

  test("invalid contact_email is rejected; valid one is lowercased", async () => {
    const bad = await call(controller.createCompanyKyc, {
      user: asClient,
      body: {
        general_information: { legal_name: "Bad Email Pty Ltd", contact_email: "not-an-email" },
      },
    });
    expect(bad.error?.name).toBe("ValidationError");

    const ok = await call(controller.createCompanyKyc, {
      user: asClient,
      body: {
        general_information: { legal_name: "Good Email Pty Ltd", contact_email: "Ops@Example.COM" },
      },
    });
    expect(ok.status).toBe(201);
    // contact_email is now multi-entry (docs/65 Step 38); a scalar write
    // still casts to a one-element array.
    expect(ok.body.data.general_information.contact_email).toEqual(["ops@example.com"]);
  });

  test('empty-string selects ("") coerce to undefined instead of failing the enum', async () => {
    const r = await call(controller.createCompanyKyc, {
      user: asClient,
      body: {
        general_information: { legal_name: "Blank Select Pty Ltd", entity_type: "", status: "" },
        appointments: [{ role: "director", given_name: "A", surname: "B", screening_status: "" }],
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(201);
    const doc = await CompanyKyc.findById(r.body.data._id).lean();
    expect(doc.general_information.entity_type).toBeUndefined();
    expect(doc.appointments[0].screening_status).toBeUndefined();
  });

  test('the wizard\'s third status option "external_administration" is accepted', async () => {
    const r = await call(controller.createCompanyKyc, {
      user: asClient,
      body: {
        general_information: { legal_name: "Ext Admin Pty Ltd", status: "external_administration" },
      },
    });
    expect(r.status).toBe(201);
  });
});

describe("uid generation (R12)", () => {
  test("two rapid creates mint distinct uids that still match the lookup prefix", async () => {
    const [a, b] = await Promise.all([
      call(controller.createCompanyKyc, { user: asClient, body: minimal("Uid A Pty Ltd") }),
      call(controller.createCompanyKyc, { user: asClient, body: minimal("Uid B Pty Ltd") }),
    ]);
    expect(a.body.data.uid).toMatch(/^COMKYC_/);
    expect(b.body.data.uid).toMatch(/^COMKYC_/);
    expect(a.body.data.uid).not.toBe(b.body.data.uid);
  });
});

describe("duplicate registration number (409)", () => {
  test("creating the same registration_number twice conflicts, message carries the existing id", async () => {
    const first = await call(controller.createCompanyKyc, {
      user: asClient,
      body: minimal("Original Pty Ltd", "111000111"),
    });
    expect(first.status).toBe(201);

    const dup = await call(controller.createCompanyKyc, {
      user: asClient,
      body: minimal("Copycat Pty Ltd", "111000111"),
    });
    expect(dup.error?.statusCode).toBe(409);
    expect(dup.error?.message).toContain(String(first.body.data._id));
  });

  test("update: taking another record's registration_number conflicts; keeping your own does not", async () => {
    const a = await call(controller.createCompanyKyc, {
      user: asClient,
      body: minimal("Holder A Pty Ltd", "222000222"),
    });
    const bDoc = await call(controller.createCompanyKyc, {
      user: asClient,
      body: minimal("Holder B Pty Ltd", "333000333"),
    });

    const steal = await call(controller.updateCompanyKyc, {
      user: asClient,
      params: { id: bDoc.body.data._id },
      body: minimal("Holder B Pty Ltd", "222000222"),
    });
    expect(steal.error?.statusCode).toBe(409);

    const keepOwn = await call(controller.updateCompanyKyc, {
      user: asClient,
      params: { id: a.body.data._id },
      body: minimal("Holder A Renamed Pty Ltd", "222000222"),
    });
    expect(keepOwn.error).toBeUndefined();
    expect(keepOwn.status).toBe(200);
  });
});

describe("search escaping + lookup paths", () => {
  test("search with regex metacharacters matches literally instead of throwing", async () => {
    await call(controller.createCompanyKyc, {
      user: asClient,
      body: minimal("A+B (Holdings) Pty Ltd", "444000444"),
    });

    const r = await call(controller.getCompanyKycs, {
      user: asClient,
      query: { search: "A+B (Holdings)" },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(
      r.body.data.map((d) => d.general_information.legal_name),
    ).toContain("A+B (Holdings) Pty Ltd");
  });

  test("oversized ?limit= is capped instead of dumping the collection", async () => {
    const r = await call(controller.getCompanyKycs, {
      user: asClient,
      query: { limit: "999999" },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
  });

  test("CompanyKyc lookup by uid and by sequence no longer crashes (dead populates removed)", async () => {
    const created = await call(controller.createCompanyKyc, {
      user: asClient,
      body: minimal("Lookup Target Pty Ltd", "555000555"),
    });
    const { uid, sequence } = created.body.data;

    const byUid = await call(controller.getCompanyKyc, {
      user: asClient,
      params: { id: uid },
    });
    expect(byUid.error).toBeUndefined();
    expect(byUid.status).toBe(200);
    expect(byUid.body.data.uid).toBe(uid);

    const bySeq = await call(controller.getCompanyKyc, {
      user: asClient,
      params: { id: String(sequence) },
    });
    expect(bySeq.error).toBeUndefined();
    expect(bySeq.status).toBe(200);
  });

  test("GET /trust/:id no longer crashes on the plain ObjectId path", async () => {
    const trust = await TrustKyc.create({
      trust_details: { full_trust_name: "Integrity Family Trust" },
    });
    const r = await call(controller.getTrustKyc, {
      user: asClient,
      params: { id: String(trust._id) },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body.data.trust_details.full_trust_name).toBe("Integrity Family Trust");
  });
});
