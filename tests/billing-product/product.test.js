const { connect, disconnect, clearAll, makeUser } = require("./setup");

const request = require("supertest");
const mongoose = require("mongoose");

let app;
let dooit;
let client;

beforeAll(async () => {
  await connect();
  app = require("./app");
});

afterAll(disconnect);

beforeEach(async () => {
  await clearAll();
  dooit = await makeUser({ userType: "dooit", email: "admin@dooit.ai" });
  client = await makeUser({
    userType: "client",
    clientBelongs: new mongoose.Types.ObjectId(),
    email: "sarah@coinflip.test",
  });
});

const PRODUCT = {
  name: "Identity Document Verification",
  code: "id_doc_verification",
  category: "Verification",
  unit: "check",
  defaultUnitPrice: 0.79,
};

const create = (body = PRODUCT, auth = dooit.auth) =>
  request(app).post("/api/v1/product").set("Authorization", auth).send(body);

// ─────────────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app).get("/api/v1/product");
    expect(res.status).toBe(401);
  });

  it("lets a client READ the catalogue", async () => {
    await create();
    const res = await request(app)
      .get("/api/v1/product")
      .set("Authorization", client.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("blocks a client from CREATING a product", async () => {
    const res = await create(PRODUCT, client.auth);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("blocks a client from DELETING a product", async () => {
    const { body } = await create();
    const res = await request(app)
      .delete(`/api/v1/product/${body.data._id}`)
      .set("Authorization", client.auth);
    expect(res.status).toBe(403);
  });
});

describe("create", () => {
  it("creates a product and returns price as a plain number", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    // NOT {"$numberDecimal":"0.79"} — the toJSON transform must have run
    expect(res.body.data.defaultUnitPrice).toBe(0.79);
    expect(typeof res.body.data.defaultUnitPrice).toBe("number");
    expect(res.body.data.uid).toMatch(/^PRD-\d{7}$/);
    expect(res.body.data.status).toBe("active");
  });

  it("preserves 4dp prices exactly", async () => {
    const res = await create({
      ...PRODUCT,
      name: "Device Intelligence",
      code: "device_intelligence",
      category: "Risk",
      unit: "event",
      defaultUnitPrice: 0.0065,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.defaultUnitPrice).toBe(0.0065);
  });

  it("returns 409 on duplicate code", async () => {
    await create();
    const res = await create();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("rejects an invalid category", async () => {
    const res = await create({ ...PRODUCT, category: "NotACategory" });
    expect(res.status).toBe(400);
  });

  it("rejects a negative price", async () => {
    const res = await create({ ...PRODUCT, defaultUnitPrice: -1 });
    expect(res.status).toBe(400);
  });

  it("ignores non-allow-listed fields (no mass assignment)", async () => {
    const res = await create({
      ...PRODUCT,
      createdBy: new mongoose.Types.ObjectId(), // must be overridden by the JWT
      isDeleted: true, // must be ignored
      uid: "PRD-9999999", // must be ignored
    });
    expect(res.status).toBe(201);
    expect(res.body.data.isDeleted).toBe(false);
    expect(res.body.data.createdBy).toBe(String(dooit.user._id));
    expect(res.body.data.uid).toBe("PRD-0000001");
  });
});

describe("read", () => {
  beforeEach(async () => {
    await create();
    await create({
      ...PRODUCT,
      name: "AML Screening",
      code: "aml_screening",
      category: "Screening",
      defaultUnitPrice: 0.4,
    });
  });

  it("filters by category", async () => {
    const res = await request(app)
      .get("/api/v1/product?category=Screening")
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].code).toBe("aml_screening");
  });

  it("searches by name and code", async () => {
    const res = await request(app)
      .get("/api/v1/product?search=aml")
      .set("Authorization", dooit.auth);
    expect(res.body.data).toHaveLength(1);
  });

  it("does not crash on regex metacharacters in search", async () => {
    const res = await request(app)
      .get("/api/v1/product?search=" + encodeURIComponent("a(b["))
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("paginates", async () => {
    const res = await request(app)
      .get("/api/v1/product?limit=1&page=2")
      .set("Authorization", dooit.auth);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.totalPages).toBe(2);
    expect(res.body.data).toHaveLength(1);
  });

  it("returns every category in the summary, including empty ones", async () => {
    const res = await request(app)
      .get("/api/v1/product/categories")
      .set("Authorization", client.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(8);
    const verification = res.body.data.find((c) => c.category === "Verification");
    expect(verification.count).toBe(1);
    const platform = res.body.data.find((c) => c.category === "Platform");
    expect(platform.count).toBe(0);
  });

  it("serves enum metadata for form building", async () => {
    const res = await request(app)
      .get("/api/v1/product/meta")
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toContain("Verification");
    expect(res.body.data.units).toContain("check");
  });

  it("404s on an unknown id", async () => {
    const res = await request(app)
      .get(`/api/v1/product/${new mongoose.Types.ObjectId()}`)
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(404);
  });
});

describe("update", () => {
  it("updates the price", async () => {
    const { body } = await create();
    const res = await request(app)
      .put(`/api/v1/product/${body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({ defaultUnitPrice: 0.85, name: "ID Doc Verification v2" });
    expect(res.status).toBe(200);
    expect(res.body.data.defaultUnitPrice).toBe(0.85);
    expect(res.body.data.updatedBy).toBe(String(dooit.user._id));
  });

  it("refuses to change code, loudly", async () => {
    const { body } = await create();
    const res = await request(app)
      .put(`/api/v1/product/${body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({ code: "something_else" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/immutable/i);
  });

  it("accepts an unchanged code without complaining", async () => {
    const { body } = await create();
    const res = await request(app)
      .put(`/api/v1/product/${body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({ code: "id_doc_verification", description: "updated" });
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe("updated");
  });
});

describe("status & delete", () => {
  it("deactivates a product", async () => {
    const { body } = await create();
    const res = await request(app)
      .patch(`/api/v1/product/${body.data._id}/status`)
      .set("Authorization", dooit.auth)
      .send({ status: "inactive" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("inactive");
    expect(res.body.meta.affectedPublishedPlans).toBe(0);
  });

  it("rejects a bad status value", async () => {
    const { body } = await create();
    const res = await request(app)
      .patch(`/api/v1/product/${body.data._id}/status`)
      .set("Authorization", dooit.auth)
      .send({ status: "banana" });
    expect(res.status).toBe(400);
  });

  it("soft-deletes and hides from the list", async () => {
    const { body } = await create();
    const del = await request(app)
      .delete(`/api/v1/product/${body.data._id}`)
      .set("Authorization", dooit.auth);
    expect(del.status).toBe(200);

    const list = await request(app)
      .get("/api/v1/product")
      .set("Authorization", dooit.auth);
    expect(list.body.data).toHaveLength(0);
  });

  it("refuses to delete a product a live plan still sells", async () => {
    const { body } = await create();
    const BillingPlan = mongoose.model("BillingPlan");
    await BillingPlan.create({
      name: "Growth",
      code: "plan_growth",
      version: 1,
      createdBy: dooit.user._id,
      status: "published",
      products: [
        {
          productId: body.data._id,
          code: body.data.code,
          name: body.data.name,
          unit: body.data.unit,
          enabled: true,
        },
      ],
    });

    const res = await request(app)
      .delete(`/api/v1/product/${body.data._id}`)
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still include this product/i);
  });
});

describe("bulk import", () => {
  const CATALOGUE = [
    { name: "Customer Accounts", code: "customer_account", category: "Platform", unit: "account", defaultUnitPrice: 55.0 },
    { name: "Identity Document Verification", code: "id_doc_verification", category: "Verification", unit: "check", defaultUnitPrice: 0.79 },
    { name: "AML Screening", code: "aml_screening", category: "Screening", unit: "check", defaultUnitPrice: 0.4 },
    { name: "Applicant Risk Scoring", code: "risk_scoring_individual", category: "Risk", unit: "check", defaultUnitPrice: 0.0198 },
  ];

  it("creates on first run and updates on the second", async () => {
    const first = await request(app)
      .post("/api/v1/product/bulk-import")
      .set("Authorization", dooit.auth)
      .send({ products: CATALOGUE });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ created: 4, updated: 0, failed: [] });

    const second = await request(app)
      .post("/api/v1/product/bulk-import")
      .set("Authorization", dooit.auth)
      .send({ products: CATALOGUE });
    expect(second.body.data).toMatchObject({ created: 0, updated: 4 });
  });

  it("reports per-row failures without aborting the batch", async () => {
    const res = await request(app)
      .post("/api/v1/product/bulk-import")
      .set("Authorization", dooit.auth)
      .send({ products: [CATALOGUE[0], { name: "No code" }, CATALOGUE[1]] });
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0].index).toBe(1);
    expect(res.body.success).toBe(false);
  });

  it("is blocked for client users", async () => {
    const res = await request(app)
      .post("/api/v1/product/bulk-import")
      .set("Authorization", client.auth)
      .send({ products: CATALOGUE });
    expect(res.status).toBe(403);
  });

  it("rejects a non-array body", async () => {
    const res = await request(app)
      .post("/api/v1/product/bulk-import")
      .set("Authorization", dooit.auth)
      .send({ nope: true });
    expect(res.status).toBe(400);
  });
});
