/**
 * KYB writer (docs/65 log, current step): POST /customer/company.
 *
 * Scope note: this writer deliberately does NOT attempt Customer.relations
 * tenancy linkage — that's out of scope by explicit instruction (tenant
 * scoping is Customer.relations design work, not a standalone endpoint
 * concern). These tests only pin: auth gate, validation, whitelist, and that
 * the full Phase-1 register payload persists (incl. the director-mirror hook
 * and ubos virtual firing correctly on a writer-created doc).
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
    const next = (err) => resolve({ error: err });
    handler({ user, body, params }, res, next);
  });
}

// A representative add-form payload (shape of onSubmit() in the add-form UI)
const formPayload = (name, reg) => ({
  general_information: {
    legal_name: name,
    registration_number: reg,
    country_of_incorporation: "Australia",
    industry: "Digital currency exchange (VASP)",
    registered_addresses: [{ street: "1 Main St, Box Hill", postcode: "3128", country: "Australia" }],
    entity_type: "proprietary_limited",
    registration_date: "2018-06-15",
    status: "active",
    class_subclass: "Limited By Shares · Proprietary",
  },
  identifiers: [{ id_type: "acn", value: reg, jurisdiction: "Australia" }],
  appointments: [
    { role: "director", given_name: "Ben", surname: "Brockliss", screening_status: undefined },
  ],
  directors_beneficial_owner: {
    beneficial_owners: [{ full_name: "John Carter", ownership_percent: 60, control_type: "ownership" }],
  },
  share_capital: [{ security_class: "Ordinary", amount_issued: 20, total_paid: 20, total_unpaid: 0, voting: true }],
  // beneficially_held:false now requires a resolved beneficial_arrangement
  // (docs/65 Step 43 — Trust/Nominee/Minor).
  shareholders: [
    {
      holder_name: "CF Offshore Holdings LLC",
      units_held: 20,
      percent_held: 100,
      beneficially_held: false,
      fully_paid: true,
      beneficial_arrangement: {
        arrangement_type: "nominee",
        beneficiary_type: "individual",
        beneficiary: { full_name: "CF Offshore Holdings Ultimate Principal" },
      },
    },
  ],
  related_entities: [{ relation: "parent", name: "CF Offshore Holdings LLC", percent_interest: 100, jurisdiction: "Delaware, US" }],
});

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

test("creates a company (201) with the full Phase-1 register payload", async () => {
  const r = await call(controller.createCompanyKyc, {
    user: { userType: "client", role: "client" },
    body: formPayload("Layer 8 Networks Pty Ltd", "626832559"),
  });
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(201);
  expect(r.body.success).toBe(true);

  const doc = await CompanyKyc.findById(r.body.data._id).lean();
  expect(doc.general_information.legal_name).toBe("Layer 8 Networks Pty Ltd");
  expect(doc.general_information.class_subclass).toBe("Limited By Shares · Proprietary");
  expect(doc.identifiers[0].value).toBe("626832559");
  expect(doc.share_capital[0].total_paid).toBe(20);
  expect(doc.shareholders[0].fully_paid).toBe(true);
  expect(doc.related_entities[0].relation).toBe("parent");

  // director-mirror hook fired even though the form never sends `directors`
  expect(doc.directors_beneficial_owner.directors.map((d) => d.given_name)).toEqual(["Ben"]);
});

test("ubos virtual resolves from the writer-created beneficial owner", async () => {
  const r = await call(controller.createCompanyKyc, {
    user: { userType: "client", role: "client" },
    body: formPayload("UBO Test Pty Ltd", "111222333"),
  });
  const full = await CompanyKyc.findById(r.body.data._id);
  expect(full.ubos).toHaveLength(1);
  expect(full.ubos[0].full_name).toBe("John Carter");
});

test("no Customer.relations linkage is attempted — doc.customer stays unset", async () => {
  const r = await call(controller.createCompanyKyc, {
    user: { userType: "client", role: "client" },
    body: formPayload("No Tenancy Pty Ltd", "444555666"),
  });
  const doc = await CompanyKyc.findById(r.body.data._id).lean();
  expect(doc.customer).toBeUndefined();
});

test("missing legal name -> 400", async () => {
  const r = await call(controller.createCompanyKyc, {
    user: { userType: "client", role: "client" },
    body: { general_information: { registration_number: "777" } },
  });
  expect(r.error?.statusCode).toBe(400);
});

test("server-owned fields in the body are ignored (whitelist)", async () => {
  const r = await call(controller.createCompanyKyc, {
    user: { userType: "client", role: "client" },
    body: {
      ...formPayload("Whitelist Pty Ltd", "654654"),
      uid: "COMKYC_FORGED",
      sequence: 99999,
      customer: new mongoose.Types.ObjectId(),
      osintStatus: true,
      name_history: [{ name: "Forged Former Name" }],
    },
  });
  expect(r.status).toBe(201);
  const doc = await CompanyKyc.findById(r.body.data._id).lean();
  expect(doc.uid).not.toBe("COMKYC_FORGED");
  expect(doc.customer).toBeUndefined();
  expect(doc.osintStatus).toBe(false);
  expect(doc.name_history[0].name).toBe("Whitelist Pty Ltd");
});

describe("updateCompanyKyc (PUT /customer/company/:id)", () => {
  test("persists a change and still runs the model's pre-save hooks", async () => {
    const created = await call(controller.createCompanyKyc, {
      user: { userType: "client", role: "client" },
      body: formPayload("Edit Target Pty Ltd", "888999000"),
    });
    const id = created.body.data._id;

    const updated = await call(controller.updateCompanyKyc, {
      user: { userType: "client", role: "client" },
      params: { id },
      body: {
        general_information: {
          ...formPayload("Edit Target Pty Ltd", "888999000").general_information,
          annual_income: "$1M-$5M",
        },
        appointments: [
          { role: "director", given_name: "Alex", surname: "Nguyen" },
        ],
      },
    });
    expect(updated.error).toBeUndefined();
    expect(updated.status).toBe(200);
    expect(updated.body.success).toBe(true);

    const doc = await CompanyKyc.findById(id).lean();
    expect(doc.general_information.annual_income).toBe("$1M-$5M");
    // director-mirror hook still fires on update, same as on create
    expect(doc.directors_beneficial_owner.directors.map((d) => d.given_name)).toEqual(["Alex"]);
  });

  test("unknown id -> 404", async () => {
    const r = await call(controller.updateCompanyKyc, {
      user: { userType: "client", role: "client" },
      params: { id: new mongoose.Types.ObjectId().toString() },
      body: { general_information: { legal_name: "Nobody Pty Ltd" } },
    });
    expect(r.error?.statusCode).toBe(404);
  });

  test("server-owned fields in the body are still ignored on update", async () => {
    const created = await call(controller.createCompanyKyc, {
      user: { userType: "client", role: "client" },
      body: formPayload("Update Whitelist Pty Ltd", "222333444"),
    });
    const id = created.body.data._id;

    await call(controller.updateCompanyKyc, {
      user: { userType: "client", role: "client" },
      params: { id },
      body: {
        uid: "COMKYC_FORGED_ON_UPDATE",
        customer: new mongoose.Types.ObjectId(),
        osintStatus: true,
      },
    });
    const doc = await CompanyKyc.findById(id).lean();
    expect(doc.uid).not.toBe("COMKYC_FORGED_ON_UPDATE");
    expect(doc.customer).toBeUndefined();
    expect(doc.osintStatus).toBe(false);
  });
});
