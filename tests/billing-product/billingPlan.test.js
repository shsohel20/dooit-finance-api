const { connect, disconnect, clearAll, makeUser } = require("./setup");

const request = require("supertest");
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");

let app;
let dooit;
let client;
let otherClient;
let productId;

beforeAll(async () => {
  await connect();
  // Mount both routers — plan creation resolves products against the catalogue.
  const errorHandler = require("../../middleware/error");
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1/product", require("../../routes/product"));
  app.use("/api/v1/billing-plan", require("../../routes/billing-plan"));
  app.use(errorHandler);
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
  otherClient = await makeUser({
    userType: "client",
    clientBelongs: new mongoose.Types.ObjectId(),
    email: "other@elsewhere.test",
  });

  const p = await request(app)
    .post("/api/v1/product")
    .set("Authorization", dooit.auth)
    .send({
      name: "Identity Document Verification",
      code: "id_doc_verification",
      category: "Verification",
      unit: "check",
      defaultUnitPrice: 0.79,
    });
  productId = p.body.data._id;
});

const DRAFT = () => ({
  name: "Growth",
  code: "plan_growth",
  tagline: "Scaling compliance teams",
  pricingModel: "hybrid",
  billingCycle: "monthly",
  basePrice: 1900,
  includedUsage: "5,000", // free text from the builder — must be parsed
  overagePrice: 0.68,
  visibility: "public",
  tiers: [
    { from: "0", to: "1,000", unitPrice: 0.79, discountPercent: "0%" },
    { from: "1,001", to: "10,000", unitPrice: 0.71, discountPercent: "10%" },
    { from: "10,001", to: "∞", unitPrice: 0.64, discountPercent: "19%" },
  ],
  products: [{ productId, enabled: true, includedQuantity: 5000, unitPrice: 0.79 }],
});

const createDraft = (over = {}, auth = dooit.auth) =>
  request(app)
    .post("/api/v1/billing-plan")
    .set("Authorization", auth)
    .send({ ...DRAFT(), ...over });

const publish = (id, auth = dooit.auth) =>
  request(app).post(`/api/v1/billing-plan/${id}/publish`).set("Authorization", auth);

// ─────────────────────────────────────────────────────────────────────────────

describe("create & normalise", () => {
  it("creates a draft and parses free-text tier bands", async () => {
    const res = await createDraft();
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d.status).toBe("draft");
    expect(d.version).toBe(1);
    expect(d.uid).toMatch(/^PLN-\d{7}$/);
    expect(d.includedUsage).toBe(5000); // "5,000" -> 5000
    expect(d.tiers[2].to).toBeNull(); // "∞" -> null
    expect(d.tiers[1].from).toBe(1001); // "1,001" -> 1001
    expect(d.tiers[1].discountPercent).toBe(10); // "10%" -> 10
  });

  it("snapshots product code/name/unit from the catalogue, not the request", async () => {
    const res = await createDraft({
      products: [
        {
          productId,
          code: "spoofed_code",
          name: "Spoofed Name",
          unit: "account",
          enabled: true,
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.products[0].code).toBe("id_doc_verification");
    expect(res.body.data.products[0].name).toBe("Identity Document Verification");
    expect(res.body.data.products[0].unit).toBe("check");
  });

  it("rejects an unknown productId", async () => {
    const res = await createDraft({
      products: [{ productId: new mongoose.Types.ObjectId(), enabled: true }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown or deleted product/i);
  });

  it("rejects a non-contiguous tier ladder", async () => {
    const res = await createDraft({
      tiers: [
        { from: 0, to: 1000, unitPrice: 0.79 },
        { from: 5000, to: null, unitPrice: 0.64 },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("409s on duplicate code+version", async () => {
    await createDraft();
    const res = await createDraft();
    expect(res.status).toBe(409);
  });

  it("blocks a client from creating", async () => {
    const res = await createDraft({}, client.auth);
    expect(res.status).toBe(403);
  });
});

describe("publish", () => {
  it("publishes a valid draft", async () => {
    const { body } = await createDraft();
    const res = await publish(body.data._id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("published");
    expect(res.body.data.publishedAt).toBeTruthy();
    expect(res.body.meta.archivedPreviousVersions).toBe(0);
  });

  it("refuses a draft with no enabled product", async () => {
    const { body } = await createDraft({ products: [] });
    const res = await publish(body.data._id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one enabled product/i);
  });

  it("refuses a hybrid plan with no base price", async () => {
    const { body } = await createDraft({ basePrice: 0 });
    const res = await publish(body.data._id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/basePrice must be greater than zero/i);
  });

  it("allows a custom-priced plan with no base price", async () => {
    const { body } = await createDraft({ basePrice: 0, isCustomPriced: true });
    const res = await publish(body.data._id);
    expect(res.status).toBe(200);
    expect(res.body.data.selfServe).toBe(false); // forced by the model
  });

  it("refuses a private plan with no eligible client", async () => {
    const { body } = await createDraft({ visibility: "private" });
    const res = await publish(body.data._id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one eligible client/i);
  });

  it("refuses to publish twice", async () => {
    const { body } = await createDraft();
    await publish(body.data._id);
    const res = await publish(body.data._id);
    expect(res.status).toBe(409);
  });
});

describe("immutability & versioning", () => {
  it("refuses to edit a published plan", async () => {
    const { body } = await createDraft();
    await publish(body.data._id);
    const res = await request(app)
      .put(`/api/v1/billing-plan/${body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({ basePrice: 2500 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/immutable/i);
  });

  it("edits a draft freely", async () => {
    const { body } = await createDraft();
    const res = await request(app)
      .put(`/api/v1/billing-plan/${body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({ basePrice: 2100, tagline: "Updated" });
    expect(res.status).toBe(200);
    expect(res.body.data.basePrice).toBe(2100);
  });

  it("new-version clones to a draft and publishing archives the old one", async () => {
    const first = await createDraft();
    await publish(first.body.data._id);

    const v2 = await request(app)
      .post(`/api/v1/billing-plan/${first.body.data._id}/new-version`)
      .set("Authorization", dooit.auth);
    expect(v2.status).toBe(201);
    expect(v2.body.data.version).toBe(2);
    expect(v2.body.data.status).toBe("draft");
    expect(v2.body.data.publishedAt).toBeNull();
    // the clone keeps the commercials
    expect(v2.body.data.products).toHaveLength(1);

    const pub = await publish(v2.body.data._id);
    expect(pub.status).toBe(200);
    expect(pub.body.meta.archivedPreviousVersions).toBe(1);

    const old = await request(app)
      .get(`/api/v1/billing-plan/${first.body.data._id}`)
      .set("Authorization", dooit.auth);
    expect(old.body.data.status).toBe("archived");
  });

  it("refuses a second open draft for the same code", async () => {
    const first = await createDraft();
    await publish(first.body.data._id);
    await request(app)
      .post(`/api/v1/billing-plan/${first.body.data._id}/new-version`)
      .set("Authorization", dooit.auth);
    const again = await request(app)
      .post(`/api/v1/billing-plan/${first.body.data._id}/new-version`)
      .set("Authorization", dooit.auth);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already has an open draft/i);
  });

  it("deletes a draft but not a published plan", async () => {
    const a = await createDraft();
    const del = await request(app)
      .delete(`/api/v1/billing-plan/${a.body.data._id}`)
      .set("Authorization", dooit.auth);
    expect(del.status).toBe(200);

    const b = await createDraft({ code: "plan_scale" });
    await publish(b.body.data._id);
    const del2 = await request(app)
      .delete(`/api/v1/billing-plan/${b.body.data._id}`)
      .set("Authorization", dooit.auth);
    expect(del2.status).toBe(409);
  });
});

describe("client visibility", () => {
  const list = (auth) =>
    request(app).get("/api/v1/billing-plan").set("Authorization", auth);

  it("a client sees published public plans only — not drafts", async () => {
    const pub = await createDraft();
    await publish(pub.body.data._id);
    await createDraft({ code: "plan_secret_draft" }); // stays draft

    const dooitList = await list(dooit.auth);
    expect(dooitList.body.data).toHaveLength(2);

    const clientList = await list(client.auth);
    expect(clientList.body.data).toHaveLength(1);
    expect(clientList.body.data[0].code).toBe("plan_growth");
  });

  it("a client cannot see a private plan they were not granted", async () => {
    const priv = await createDraft({ code: "plan_bespoke", visibility: "private" });
    await request(app)
      .post(`/api/v1/billing-plan/${priv.body.data._id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: client.user._id });
    await publish(priv.body.data._id);

    const granted = await list(client.auth);
    expect(granted.body.data.map((p) => p.code)).toContain("plan_bespoke");

    const notGranted = await list(otherClient.auth);
    expect(notGranted.body.data.map((p) => p.code)).not.toContain("plan_bespoke");
  });

  it("404s when a client guesses a private planId", async () => {
    const priv = await createDraft({ code: "plan_bespoke", visibility: "private" });
    await request(app)
      .post(`/api/v1/billing-plan/${priv.body.data._id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: client.user._id });
    await publish(priv.body.data._id);

    const res = await request(app)
      .get(`/api/v1/billing-plan/${priv.body.data._id}`)
      .set("Authorization", otherClient.auth);
    expect(res.status).toBe(404);
  });

  it("search does not widen a client's visibility", async () => {
    const priv = await createDraft({ code: "plan_bespoke", visibility: "private" });
    await request(app)
      .post(`/api/v1/billing-plan/${priv.body.data._id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: client.user._id });
    await publish(priv.body.data._id);

    // A naive implementation overwrites $or with the search clause and leaks it.
    const res = await request(app)
      .get("/api/v1/billing-plan?search=bespoke")
      .set("Authorization", otherClient.auth);
    expect(res.body.data).toHaveLength(0);
  });

  it("a revoked grant removes visibility", async () => {
    const priv = await createDraft({ code: "plan_bespoke", visibility: "private" });
    await request(app)
      .post(`/api/v1/billing-plan/${priv.body.data._id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: client.user._id });
    await publish(priv.body.data._id);

    await request(app)
      .delete(`/api/v1/billing-plan/${priv.body.data._id}/eligibility/${client.user._id}`)
      .set("Authorization", dooit.auth);

    const res = await list(client.auth);
    expect(res.body.data.map((p) => p.code)).not.toContain("plan_bespoke");
  });
});

describe("eligibility", () => {
  it("rejects granting to a non-client user", async () => {
    const { body } = await createDraft({ visibility: "private" });
    const res = await request(app)
      .post(`/api/v1/billing-plan/${body.data._id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: dooit.user._id }); // a dooit user is not a buyer
    expect(res.status).toBe(403);
  });

  it("re-granting a revoked user reactivates rather than colliding", async () => {
    const { body } = await createDraft({ visibility: "private" });
    const id = body.data._id;
    await request(app)
      .post(`/api/v1/billing-plan/${id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: client.user._id });
    await request(app)
      .delete(`/api/v1/billing-plan/${id}/eligibility/${client.user._id}`)
      .set("Authorization", dooit.auth);

    const again = await request(app)
      .post(`/api/v1/billing-plan/${id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: client.user._id });
    expect(again.status).toBe(201);
    expect(again.body.data.status).toBe("active");

    const listed = await request(app)
      .get(`/api/v1/billing-plan/${id}/eligibility`)
      .set("Authorization", dooit.auth);
    expect(listed.body.data).toHaveLength(1); // not two rows
  });

  it("a client cannot read the eligibility list", async () => {
    const { body } = await createDraft({ visibility: "private" });
    const res = await request(app)
      .get(`/api/v1/billing-plan/${body.data._id}/eligibility`)
      .set("Authorization", client.auth);
    expect(res.status).toBe(403);
  });
});

describe("grantable clients", () => {
  it("lists active client users, deduped, excluding dooit", async () => {
    const res = await request(app)
      .get("/api/v1/billing-plan/clients")
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(200);
    const emails = res.body.data.map((u) => u.email);
    expect(emails).toContain("sarah@coinflip.test");
    expect(emails).toContain("other@elsewhere.test");
    expect(emails).not.toContain("admin@dooit.ai"); // dooit is not a buyer
    expect(new Set(emails).size).toBe(emails.length); // deduped
  });

  it("filters by search", async () => {
    const res = await request(app)
      .get("/api/v1/billing-plan/clients?search=coinflip")
      .set("Authorization", dooit.auth);
    expect(res.body.data).toHaveLength(1);
  });

  it("is not reachable by a client", async () => {
    const res = await request(app)
      .get("/api/v1/billing-plan/clients")
      .set("Authorization", client.auth);
    expect(res.status).toBe(403);
  });

  it("is not swallowed by the /:id route", async () => {
    // '/clients' must be declared before '/:id' or it parses as a plan id
    const res = await request(app)
      .get("/api/v1/billing-plan/clients")
      .set("Authorization", dooit.auth);
    expect(res.body.data).toBeDefined();
    expect(res.body.error).toBeUndefined();
  });
});

describe("entitlements survive versioning and product deactivation", () => {
  it("new-version clones entitlements and an edit updates them", async () => {
    const v1 = await createDraft();
    await publish(v1.body.data._id);
    expect(v1.body.data.products).toHaveLength(1);

    await request(app)
      .post(`/api/v1/billing-plan/${v1.body.data._id}/archive`)
      .set("Authorization", dooit.auth);

    const v2 = await request(app)
      .post(`/api/v1/billing-plan/${v1.body.data._id}/new-version`)
      .set("Authorization", dooit.auth);
    expect(v2.body.data.products).toHaveLength(1); // carried through the clone

    // add a second product, as the builder would
    const second = await request(app)
      .post("/api/v1/product")
      .set("Authorization", dooit.auth)
      .send({
        name: "AML Screening",
        code: "aml_screening",
        category: "Screening",
        unit: "check",
        defaultUnitPrice: 0.4,
      });

    const edited = await request(app)
      .put(`/api/v1/billing-plan/${v2.body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({
        products: [
          { productId, enabled: true },
          { productId: second.body.data._id, enabled: true },
        ],
      });
    expect(edited.body.data.products).toHaveLength(2);

    // the details page reads getPlan — it must show the NEW entitlements
    const details = await request(app)
      .get(`/api/v1/billing-plan/${v2.body.data._id}`)
      .set("Authorization", dooit.auth);
    expect(details.body.data.products.map((p) => p.code).sort()).toEqual([
      "aml_screening",
      "id_doc_verification",
    ]);
  });

  it("a DEACTIVATED product keeps its entitlement and is still returned", async () => {
    const draft = await createDraft();
    expect(draft.body.data.products).toHaveLength(1);

    await request(app)
      .patch(`/api/v1/product/${productId}/status`)
      .set("Authorization", dooit.auth)
      .send({ status: "inactive" });

    // The builder now loads status=all, so a deactivated product is still in the
    // catalogue it builds its payload from. This is the query it makes.
    const catalogue = await request(app)
      .get("/api/v1/product?status=all&limit=200")
      .set("Authorization", dooit.auth);
    expect(catalogue.body.data.map((p) => p.code)).toContain("id_doc_verification");

    // …so re-saving does not silently drop the entitlement.
    const resaved = await request(app)
      .put(`/api/v1/billing-plan/${draft.body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({ products: [{ productId, enabled: true }] });
    expect(resaved.body.data.products).toHaveLength(1);

    // Guard the old behaviour explicitly: an active-only catalogue would be empty
    const activeOnly = await request(app)
      .get("/api/v1/product?status=active&limit=200")
      .set("Authorization", dooit.auth);
    expect(activeOnly.body.data.map((p) => p.code)).not.toContain("id_doc_verification");
  });
});
