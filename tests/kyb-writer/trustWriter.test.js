/**
 * Standalone TrustKyc writers (docs/65 Step 57): POST /customer/trust and
 * PUT /customer/trust/:id.
 *
 * Until Step 57 a TrustKyc only existed as a companion record created by the
 * Company writer, so "connect an existing trust" had nothing to connect to.
 * These pin: required-name validation, the shared pickTrustPayload whitelist
 * (server-owned review fields can't be forged here either), 404 on unknown
 * id, and that an update doesn't mint a duplicate.
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

const staff = { _id: new mongoose.Types.ObjectId(), userType: "client", role: "client" };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  controller = require("../../controllers/customerController");
  TrustKyc = require("../../models/TrustKyc");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("POST /customer/trust", () => {
  test("creates a trust (201) and returns it with a uid", async () => {
    const r = await call(controller.createTrustKyc, {
      user: staff,
      body: {
        trust_details: {
          full_trust_name: "Standalone Family Trust",
          country_of_establishment: "Australia",
          trust_identification: { abn: "11222333444", date_of_deed: "2024-11-07" },
        },
        settlor: { full_name: "Yang Li", is_company: false },
        beneficiaries: [{ named_beneficiaries: "Kid One", beneficiary_type: "individual", beneficial_interest_percent: 40 }],
        appointors: ["Pat Appointor"],
        aml_kyc: { source_of_funds: "Business income" },
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);

    const doc = await TrustKyc.findById(r.body.data._id).lean();
    expect(doc.trust_details.full_trust_name).toBe("Standalone Family Trust");
    expect(doc.trust_details.trust_identification.abn).toBe("11222333444");
    expect(doc.settlor.full_name).toBe("Yang Li");
    expect(doc.beneficiaries[0].beneficial_interest_percent).toBe(40);
    expect(doc.appointors).toEqual(["Pat Appointor"]);
    expect(doc.aml_kyc.source_of_funds).toBe("Business income");
    expect(doc.uid).toMatch(/^TRKYC_/);
  });

  test("missing trust name -> 400", async () => {
    const r = await call(controller.createTrustKyc, { user: staff, body: { trust_details: { country_of_establishment: "Australia" } } });
    expect(r.error?.statusCode).toBe(400);
  });

  test("blank trust name -> 400", async () => {
    const r = await call(controller.createTrustKyc, { user: staff, body: { trust_details: { full_trust_name: "   " } } });
    expect(r.error?.statusCode).toBe(400);
  });

  test("server-owned fields in the body are ignored (shared whitelist)", async () => {
    const r = await call(controller.createTrustKyc, {
      user: staff,
      body: {
        trust_details: { full_trust_name: "Whitelist Trust" },
        uid: "TRKYC_FORGED",
        sequence: 99999,
        customer: new mongoose.Types.ObjectId(),
        osintStatus: true,
        review_status: "approved",
        review_history: [{ status: "approved", note: "self-approved" }],
        next_review_date: "2099-01-01",
      },
    });
    expect(r.status).toBe(201);
    const doc = await TrustKyc.findById(r.body.data._id).lean();
    expect(doc.uid).not.toBe("TRKYC_FORGED");
    expect(doc.customer).toBeUndefined();
    expect(doc.osintStatus).toBe(false);
    expect(doc.review_status).toBeUndefined();
    expect(doc.review_history).toHaveLength(0);
    expect(doc.next_review_date).toBeUndefined();
  });
});

describe("PUT /customer/trust/:id", () => {
  test("updates in place — no duplicate minted", async () => {
    const created = await call(controller.createTrustKyc, {
      user: staff,
      body: { trust_details: { full_trust_name: "Edit Target Trust" } },
    });
    const id = created.body.data._id;
    const before = await TrustKyc.countDocuments();

    const updated = await call(controller.updateTrustKyc, {
      user: staff,
      params: { id },
      body: {
        trust_details: { full_trust_name: "Edit Target Trust (Updated)", governing_law: "VIC" },
        controllers: { controlling_persons: [{ full_name: "Pat", role: "appointor", pep_status: "cleared" }] },
      },
    });
    expect(updated.error).toBeUndefined();
    expect(updated.status).toBe(200);

    expect(await TrustKyc.countDocuments()).toBe(before);
    const doc = await TrustKyc.findById(id).lean();
    expect(doc.trust_details.full_trust_name).toBe("Edit Target Trust (Updated)");
    expect(doc.trust_details.governing_law).toBe("VIC");
    expect(doc.controllers.controlling_persons[0].pep_status).toBe("cleared");
  });

  test("unknown id -> 404", async () => {
    const r = await call(controller.updateTrustKyc, {
      user: staff,
      params: { id: new mongoose.Types.ObjectId().toString() },
      body: { trust_details: { full_trust_name: "Nobody Trust" } },
    });
    expect(r.error?.statusCode).toBe(404);
  });

  test("blanking the trust name on update -> 400", async () => {
    const created = await call(controller.createTrustKyc, {
      user: staff,
      body: { trust_details: { full_trust_name: "Keep My Name Trust" } },
    });
    const r = await call(controller.updateTrustKyc, {
      user: staff,
      params: { id: created.body.data._id },
      body: { trust_details: { full_trust_name: "" } },
    });
    expect(r.error?.statusCode).toBe(400);
  });

  test("server-owned review fields are still ignored on update", async () => {
    const created = await call(controller.createTrustKyc, {
      user: staff,
      body: { trust_details: { full_trust_name: "Update Whitelist Trust" } },
    });
    const id = created.body.data._id;
    await call(controller.updateTrustKyc, {
      user: staff,
      params: { id },
      body: { uid: "TRKYC_FORGED_ON_UPDATE", review_status: "approved", osintStatus: true },
    });
    const doc = await TrustKyc.findById(id).lean();
    expect(doc.uid).not.toBe("TRKYC_FORGED_ON_UPDATE");
    expect(doc.review_status).toBeUndefined();
    expect(doc.osintStatus).toBe(false);
  });
});

describe("a trust saved standalone can then be linked from a company", () => {
  test("passing its id back through the company writer updates it, not a copy", async () => {
    const created = await call(controller.createTrustKyc, {
      user: staff,
      body: { trust_details: { full_trust_name: "Connectable Trust" } },
    });
    const trustId = created.body.data._id;
    const before = await TrustKyc.countDocuments();

    const company = await call(controller.createCompanyKyc, {
      user: staff,
      body: {
        general_information: { legal_name: "Connects To Existing Trust Pty" },
        shareholders: [
          {
            holder_name: "ATF Connectable Trust",
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            trust: { id: String(trustId), trust_details: { full_trust_name: "Connectable Trust", governing_law: "NSW" } },
          },
        ],
      },
    });
    expect(company.status).toBe(201);
    // Linked to the same record, and no second trust created.
    expect(String(company.body.data.shareholders[0].holder_entity)).toBe(String(trustId));
    expect(await TrustKyc.countDocuments()).toBe(before);
    const doc = await TrustKyc.findById(trustId).lean();
    expect(doc.trust_details.governing_law).toBe("NSW");
  });
});
