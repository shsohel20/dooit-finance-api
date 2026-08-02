const { connect, disconnect, clearAll, makeUser } = require("./setup");

const request = require("supertest");
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");

const {
  periodKeysFor,
  composeIdempotencyKey,
} = require("../../services/billing/usageService");

let app;
let dooit;
let client;
let otherClient;
let productId;
let subId;

beforeAll(async () => {
  await connect();
  require("../../models/Subscription");
  require("../../models/UsageRecord");
  // The reference picker resolves against these two.
  require("../../models/Case");
  const errorHandler = require("../../middleware/error");
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1/product", require("../../routes/product"));
  app.use("/api/v1/billing-plan", require("../../routes/billing-plan"));
  app.use("/api/v1/subscription", require("../../routes/subscription"));
  app.use("/api/v1/usage", require("../../routes/usage"));
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

  // Two products: one entitled by the plan, one not.
  const mk = (code, name, price, category = "Verification") =>
    request(app)
      .post("/api/v1/product")
      .set("Authorization", dooit.auth)
      .send({ name, code, category, unit: "check", defaultUnitPrice: price });

  const p1 = await mk("id_doc_verification", "Identity Document Verification", 0.79);
  await mk("device_intelligence", "Device Intelligence", 0.0065, "Risk");
  productId = p1.body.data._id;

  const plan = await request(app)
    .post("/api/v1/billing-plan")
    .set("Authorization", dooit.auth)
    .send({
      name: "Growth",
      code: "plan_growth",
      basePrice: 1900,
      includedUsage: 5000,
      overagePrice: 0.68,
      visibility: "public",
      // Plan overrides the list price: 0.71 instead of 0.79
      products: [{ productId, enabled: true, includedQuantity: 5000, unitPrice: 0.71 }],
    });
  await request(app)
    .post(`/api/v1/billing-plan/${plan.body.data._id}/publish`)
    .set("Authorization", dooit.auth);

  const sub = await request(app)
    .post("/api/v1/subscription")
    .set("Authorization", client.auth)
    .send({ plan: plan.body.data._id });
  subId = sub.body.data._id;
});

const record = (over = {}, auth = dooit.auth) =>
  request(app)
    .post("/api/v1/usage")
    .set("Authorization", auth)
    .send({
      subscription: subId,
      productCode: "id_doc_verification",
      quantity: 1,
      externalId: "app_9f2c17ab",
      source: { system: "dooit", refType: "Customer" },
      ...over,
    });

// ─────────────────────────────────────────────────────────────────────────────

describe("period keys (§15.3 — account timezone, not UTC)", () => {
  it("derives keys in Australia/Sydney, not UTC", () => {
    // 2026-07-31T23:30Z is 2026-08-01 09:30 in Sydney — a different MONTH.
    const utcLate = new Date("2026-07-31T23:30:00Z");
    expect(periodKeysFor(utcLate)).toEqual({
      periodKey: "2026-08",
      dayKey: "2026-08-01",
    });
    // Deriving from UTC would have said 2026-07 — the bug this guards.
    expect(utcLate.toISOString().slice(0, 7)).toBe("2026-07");
  });

  it("handles the DST boundary", () => {
    // AEST (+10) in July, AEDT (+11) in January — a fixed offset would be wrong
    // for one of these.
    expect(periodKeysFor(new Date("2026-01-31T13:30:00Z")).dayKey).toBe("2026-02-01");
    expect(periodKeysFor(new Date("2026-07-31T13:30:00Z")).dayKey).toBe("2026-07-31");
  });
});

describe("idempotency keys (§15.2 — composed, not borrowed)", () => {
  it("includes the product so one webhook can bill several products", () => {
    const a = composeIdempotencyKey({
      system: "dooit",
      externalId: "app_1",
      productCode: "id_doc_verification",
    });
    const b = composeIdempotencyKey({
      system: "dooit",
      externalId: "app_1",
      productCode: "aml_screening",
    });
    expect(a).not.toBe(b);
    expect(a).toBe("dooit:app_1:id_doc_verification:1");
  });

  it("distinguishes repeated occurrences via ordinal", () => {
    const first = composeIdempotencyKey({ externalId: "x", productCode: "p", ordinal: 1 });
    const second = composeIdempotencyKey({ externalId: "x", productCode: "p", ordinal: 2 });
    expect(first).not.toBe(second);
  });

  it("refuses to compose without an externalId", () => {
    expect(() => composeIdempotencyKey({ productCode: "p" })).toThrow(/externalId/);
  });
});

describe("record usage", () => {
  it("prices from the subscription snapshot, not the product list price", async () => {
    const res = await record();
    expect(res.status).toBe(201);
    // list price is 0.79; the plan overrode it to 0.71 and the snapshot froze that
    expect(res.body.data.unitPrice).toBe(0.71);
    expect(res.body.data.priceSource).toBe("snapshot_override");
    expect(res.body.data.amount).toBe(0.71);
    expect(res.body.data.status).toBe("recorded");
  });

  it("falls back to the product list price when the plan sets none", async () => {
    // device_intelligence is not in the plan → not entitled, list price used
    const res = await record({
      productCode: "device_intelligence",
      externalId: "app_dev_1",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.unitPrice).toBe(0.0065); // 4dp preserved
    expect(res.body.data.priceSource).toBe("product_list");
  });

  it("records but EXCLUDES a product the plan does not entitle", async () => {
    const res = await record({
      productCode: "device_intelligence",
      externalId: "app_dev_2",
    });
    expect(res.body.data.status).toBe("excluded");
    expect(res.body.data.exclusionReason).toMatch(/not entitled/i);
  });

  it("computes amount from quantity", async () => {
    const res = await record({ quantity: 430, externalId: "batch_1" });
    expect(res.body.data.amount).toBeCloseTo(430 * 0.71, 2);
  });

  it("a replayed event is a no-op returning the existing record", async () => {
    const first = await record();
    expect(first.status).toBe(201);

    const replay = await record();
    expect(replay.status).toBe(200);
    expect(replay.body.meta.duplicate).toBe(true);
    expect(replay.body.data._id).toBe(first.body.data._id);

    const list = await request(app)
      .get("/api/v1/usage")
      .set("Authorization", dooit.auth);
    expect(list.body.pagination.total).toBe(1); // not two
  });

  it("the SAME webhook bills two different products (the §15.2 bug)", async () => {
    const a = await record({ externalId: "app_same", productCode: "id_doc_verification" });
    const b = await record({ externalId: "app_same", productCode: "device_intelligence" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201); // would have been swallowed as a duplicate
    expect(a.body.data.idempotencyKey).not.toBe(b.body.data.idempotencyKey);
  });

  it("rejects an unknown product and a missing subscription", async () => {
    const badProduct = await record({ productCode: "nope", externalId: "x1" });
    expect(badProduct.status).toBe(400);

    const badSub = await record({
      subscription: new mongoose.Types.ObjectId(),
      externalId: "x2",
    });
    expect(badSub.status).toBe(404);
  });

  it("a client cannot record usage", async () => {
    const res = await record({}, client.auth);
    expect(res.status).toBe(403);
  });

  it("flags an event belonging to an already-closed period as late", async () => {
    const res = await record({
      usageDate: "2020-01-15T00:00:00Z",
      externalId: "old_1",
    });
    expect(res.status).toBe(201); // recorded, NOT rejected (§15.4)
    expect(res.body.data.isLate).toBe(true);
    expect(res.body.data.periodKey).toBe("2020-01");
  });
});

describe("bulk ingestion", () => {
  it("records a batch, counting duplicates as success", async () => {
    const events = [
      { subscription: subId, productCode: "id_doc_verification", externalId: "b1" },
      { subscription: subId, productCode: "id_doc_verification", externalId: "b2" },
      { subscription: subId, productCode: "device_intelligence", externalId: "b1" },
    ];
    const first = await request(app)
      .post("/api/v1/usage/bulk")
      .set("Authorization", dooit.auth)
      .send({ events });
    expect(first.body.data.recorded).toBe(3);
    expect(first.body.data.excluded).toBe(1); // device_intelligence not entitled

    const replay = await request(app)
      .post("/api/v1/usage/bulk")
      .set("Authorization", dooit.auth)
      .send({ events });
    expect(replay.body.data.duplicates).toBe(3);
    expect(replay.body.data.recorded).toBe(0);
  });

  it("reports per-row failures without aborting the batch", async () => {
    const res = await request(app)
      .post("/api/v1/usage/bulk")
      .set("Authorization", dooit.auth)
      .send({
        events: [
          { subscription: subId, productCode: "id_doc_verification", externalId: "ok1" },
          { subscription: subId, productCode: "does_not_exist", externalId: "bad" },
          { subscription: subId, productCode: "id_doc_verification", externalId: "ok2" },
        ],
      });
    expect(res.body.data.recorded).toBe(2);
    expect(res.body.data.failed).toHaveLength(1);
    expect(res.body.data.failed[0].index).toBe(1);
    expect(res.body.success).toBe(false);
  });
});

describe("reads & scoping", () => {
  it("a client sees only its own usage", async () => {
    await record({ externalId: "mine" });

    const mine = await request(app)
      .get("/api/v1/usage")
      .set("Authorization", client.auth);
    expect(mine.body.data).toHaveLength(1);

    const others = await request(app)
      .get("/api/v1/usage")
      .set("Authorization", otherClient.auth);
    expect(others.body.data).toHaveLength(0);
  });

  it("summary totals by product, by day, and distinct applicants", async () => {
    // Same applicant across two products must count ONCE (§15.1)
    await record({ externalId: "a1", applicantKey: "cust_1" });
    await record({
      externalId: "a1",
      productCode: "device_intelligence",
      applicantKey: "cust_1",
    });
    await record({ externalId: "a2", applicantKey: "cust_2" });

    const res = await request(app)
      .get("/api/v1/usage/summary")
      .set("Authorization", client.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.totals.distinctApplicants).toBe(2); // not 3
    // device_intelligence is outside the plan, so it is reported separately
    expect(res.body.data.byProduct.map((p) => p.productCode)).toEqual([
      "id_doc_verification",
    ]);
    expect(res.body.data.byProduct[0].quantity).toBe(2);
    expect(res.body.data.byDay).toHaveLength(1);
  });

  it("reports unentitled usage separately, and keeps it out of the allowance", async () => {
    await record({ externalId: "e1", applicantKey: "cust_1" });
    await record({
      externalId: "x1",
      productCode: "device_intelligence",
      applicantKey: "cust_9", // an applicant seen ONLY outside the plan
    });

    const res = await request(app)
      .get("/api/v1/usage/summary")
      .set("Authorization", client.auth);

    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.excludedByProduct.map((p) => p.productCode)).toEqual([
      "device_intelligence",
    ]);
    expect(d.totals.excludedEvents).toBe(1);
    expect(d.totals.excludedProducts).toBe(1);

    // cust_9 is charged per event, so letting them also consume an included
    // applicant slot would bill the same usage twice.
    expect(d.totals.distinctApplicants).toBe(1);
  });

  it("keeps unentitled usage in its own bucket after it has been billed", async () => {
    // Splitting on `status` would move it into the billable bucket the moment
    // the period closed; the split is on `exclusionReason`, which is permanent.
    await record({
      externalId: "x2",
      productCode: "device_intelligence",
      applicantKey: "cust_5",
    });

    const UsageRecord = require("../../models/UsageRecord");
    await UsageRecord.updateMany(
      { productCode: "device_intelligence" },
      { $set: { status: "billed" } }
    );

    const res = await request(app)
      .get("/api/v1/usage/summary")
      .set("Authorization", client.auth);

    expect(res.body.data.excludedByProduct).toHaveLength(1);
    expect(res.body.data.byProduct.map((p) => p.productCode)).not.toContain(
      "device_intelligence"
    );
  });
});

describe("corrections are appended, never applied in place", () => {
  it("reverses with a negative record and marks the original", async () => {
    const original = await record({ quantity: 10, externalId: "corr_1" });
    const res = await request(app)
      .post(`/api/v1/usage/${original.body.data._id}/reverse`)
      .set("Authorization", dooit.auth)
      .send({ reason: "Duplicate ID checks" });

    expect(res.status).toBe(201);
    expect(res.body.data.quantity).toBe(-10);
    expect(res.body.data.amount).toBeCloseTo(-7.1, 2);
    expect(String(res.body.data.reversalOf)).toBe(String(original.body.data._id));

    const after = await request(app)
      .get("/api/v1/usage?status=reversed")
      .set("Authorization", dooit.auth);
    expect(after.body.data).toHaveLength(1);

    // net billable quantity is zero
    const summary = await request(app)
      .get("/api/v1/usage/summary")
      .set("Authorization", client.auth);
    expect(summary.body.data.totals.quantity).toBe(-10); // original now 'reversed'
  });

  it("refuses to reverse twice, or to reverse a reversal", async () => {
    const original = await record({ externalId: "corr_2" });
    const first = await request(app)
      .post(`/api/v1/usage/${original.body.data._id}/reverse`)
      .set("Authorization", dooit.auth);
    expect(first.status).toBe(201);

    const again = await request(app)
      .post(`/api/v1/usage/${original.body.data._id}/reverse`)
      .set("Authorization", dooit.auth);
    expect(again.status).toBe(409);

    const ofReversal = await request(app)
      .post(`/api/v1/usage/${first.body.data._id}/reverse`)
      .set("Authorization", dooit.auth);
    expect(ofReversal.status).toBe(409);
  });

  it("a client cannot reverse", async () => {
    const original = await record({ externalId: "corr_3" });
    const res = await request(app)
      .post(`/api/v1/usage/${original.body.data._id}/reverse`)
      .set("Authorization", client.auth);
    expect(res.status).toBe(403);
  });
});

describe("model-level immutability", () => {
  it("rejects editing quantity or price after insert", async () => {
    const UsageRecord = mongoose.model("UsageRecord");
    const created = await record({ externalId: "imm_1" });

    const doc = await UsageRecord.findById(created.body.data._id);
    doc.quantity = 999;
    await expect(doc.save()).rejects.toThrow(/immutable/i);
  });

  it("allows the billing sweep to stamp status/invoice", async () => {
    const UsageRecord = mongoose.model("UsageRecord");
    const created = await record({ externalId: "imm_2" });

    const doc = await UsageRecord.findById(created.body.data._id);
    doc.status = "billed";
    doc.invoice = new mongoose.Types.ObjectId();
    doc.billedAt = new Date();
    await expect(doc.save()).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("usage broken down per account", () => {
  /** Put `otherClient` on the same plan so there are two accounts metering. */
  const secondAccount = async () => {
    const plans = await request(app)
      .get("/api/v1/billing-plan")
      .set("Authorization", dooit.auth);
    const planId = plans.body.data.find((p) => p.code === "plan_growth")._id;

    const sub = await request(app)
      .post("/api/v1/subscription")
      .set("Authorization", otherClient.auth)
      .send({ plan: planId });
    return sub.body.data._id;
  };

  const summary = (auth = dooit.auth, qs = "") =>
    request(app).get(`/api/v1/usage/summary${qs}`).set("Authorization", auth);

  it("groups usage by account for dooit", async () => {
    const otherSub = await secondAccount();

    // sarah: 3 events across 2 applicants. other: 1 event, 1 applicant.
    await record({ externalId: "s1", applicantKey: "cust_a" });
    await record({ externalId: "s2", applicantKey: "cust_a" }); // same applicant
    await record({ externalId: "s3", applicantKey: "cust_b" });
    await record({ subscription: otherSub, externalId: "o1", applicantKey: "cust_z" });

    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.body.data.accounts).toBe(2);

    const rows = res.body.data.byAccount;
    const sarah = rows.find((r) => String(r.user) === String(client.user._id));
    const other = rows.find((r) => String(r.user) === String(otherClient.user._id));

    expect(sarah.events).toBe(3);
    // The allowance is counted in DISTINCT applicants, so two events for one
    // applicant count once — this is the number a plan limit is measured against.
    expect(sarah.distinctApplicants).toBe(2);
    expect(other.events).toBe(1);
    expect(other.distinctApplicants).toBe(1);

    expect(sarah.userName).toBeTruthy();
    expect(sarah.subscriptions).toBe(1);
  });

  it("sorts accounts by spend, heaviest first", async () => {
    const otherSub = await secondAccount();

    await record({ subscription: otherSub, externalId: "o1", applicantKey: "z1" });
    for (let i = 0; i < 5; i += 1) {
      await record({ externalId: `s${i}`, applicantKey: `a${i}` });
    }

    const rows = (await summary()).body.data.byAccount;
    expect(rows).toHaveLength(2);
    expect(String(rows[0].user)).toBe(String(client.user._id)); // the bigger spender
    expect(rows[0].amount).toBeGreaterThan(rows[1].amount);
  });

  it("per-account amounts add up to the overall total", async () => {
    const otherSub = await secondAccount();
    await record({ externalId: "s1", applicantKey: "a1" });
    await record({ subscription: otherSub, externalId: "o1", applicantKey: "z1" });

    const data = (await summary()).body.data;
    const summed = data.byAccount.reduce((s, r) => s + r.amount, 0);
    expect(summed).toBeCloseTo(data.totals.amount, 2);
  });

  it("narrows the WHOLE summary to one account when dooit filters by user", async () => {
    const otherSub = await secondAccount();
    await record({ externalId: "s1", applicantKey: "a1" });
    await record({ subscription: otherSub, externalId: "o1", applicantKey: "z1" });

    const res = await summary(dooit.auth, `?user=${client.user._id}`);
    const data = res.body.data;

    expect(data.accounts).toBe(1);
    expect(String(data.byAccount[0].user)).toBe(String(client.user._id));
    // byProduct and the totals are scoped too, not just the account table.
    expect(data.totals.events).toBe(1);
    expect(data.scope.allAccounts).toBe(false);
    expect(data.scope.user).toBe(String(client.user._id));
  });

  it("does NOT expose the breakdown to a client", async () => {
    await secondAccount();
    await record({ externalId: "s1", applicantKey: "a1" });

    const res = await summary(client.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.byAccount).toEqual([]);
    expect(res.body.data.accounts).toBe(0);
  });

  it("ignores a `user` filter from a client — it cannot read another meter", async () => {
    const otherSub = await secondAccount();
    await record({ externalId: "s1", applicantKey: "a1" });
    await record({ subscription: otherSub, externalId: "o1", applicantKey: "z1" });

    // sarah asks for the other account's usage by hand.
    const res = await summary(client.auth, `?user=${otherClient.user._id}`);

    // She gets her OWN single event, not the other account's.
    expect(res.body.data.totals.events).toBe(1);
    expect(res.body.data.byProduct[0].productCode).toBe("id_doc_verification");
  });

  it("scopes the RECORDS list by user for dooit, and ignores it for a client", async () => {
    const otherSub = await secondAccount();
    await record({ externalId: "s1", applicantKey: "a1" });
    await record({ subscription: otherSub, externalId: "o1", applicantKey: "z1" });

    const asDooit = await request(app)
      .get(`/api/v1/usage?user=${otherClient.user._id}`)
      .set("Authorization", dooit.auth);
    expect(asDooit.body.data).toHaveLength(1);
    expect(String(asDooit.body.data[0].user._id)).toBe(String(otherClient.user._id));

    const asClient = await request(app)
      .get(`/api/v1/usage?user=${otherClient.user._id}`)
      .set("Authorization", client.auth);
    expect(asClient.body.data).toHaveLength(1);
    expect(String(asClient.body.data[0].user)).toBe(String(client.user._id));
  });

  it("reports every account as in scope when dooit does not filter", async () => {
    await record({ externalId: "s1", applicantKey: "a1" });
    const data = (await summary()).body.data;

    expect(data.scope.allAccounts).toBe(true);
    expect(data.scope.user).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("reference pickers for manual entry", () => {
  let Customer, clientCompanyId;

  const refs = (qs = "", auth = dooit.auth) =>
    request(app).get(`/api/v1/usage/references${qs}`).set("Authorization", auth);

  beforeEach(async () => {
    Customer = mongoose.model("Customer");

    // The subscription's company — usage can only be attributed to ITS customers.
    //
    // Set explicitly: `Users.client` is a VIRTUAL populated from Client.user, and
    // makeUser() creates no Client document, so a subscription made through the
    // API in this harness lands with client:null. That is a fixture limitation,
    // not the behaviour under test — production resolves it through the virtual.
    clientCompanyId = new mongoose.Types.ObjectId();
    await mongoose
      .model("Subscription")
      .updateOne({ _id: subId }, { $set: { client: clientCompanyId } });

    await Customer.collection.insertMany([
      {
        uid: "CUS-0000001",
        relations: [{ client: clientCompanyId, type: "individual" }],
      },
      {
        uid: "CUS-0000002",
        relations: [{ client: clientCompanyId, type: "company" }],
      },
      // Belongs to a DIFFERENT company — must never be offered.
      {
        uid: "CUS-9999999",
        relations: [{ client: new mongoose.Types.ObjectId(), type: "individual" }],
      },
    ]);
  });

  it("lists only customers of the subscribing account", async () => {
    const res = await refs(`?subscription=${subId}`);

    expect(res.status).toBe(200);
    const uids = res.body.data.map((r) => r.uid);
    expect(uids).toContain("CUS-0000001");
    expect(uids).toContain("CUS-0000002");
    expect(uids).not.toContain("CUS-9999999");
  });

  it("returns the uid and type, and no encrypted personal fields", async () => {
    const res = await refs(`?subscription=${subId}`);
    const row = res.body.data.find((r) => r.uid === "CUS-0000001");

    expect(row.type).toBe("individual");
    expect(row._id).toBeTruthy();
    // Names are encrypted and would mask to "***"; they must not be projected.
    expect(JSON.stringify(row)).not.toContain("personalKyc");
    expect(Object.keys(row).sort()).toEqual(["_id", "type", "uid"]);
  });

  it("searches by uid", async () => {
    const res = await refs(`?subscription=${subId}&search=0000002`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].uid).toBe("CUS-0000002");
  });

  it("treats a regex metacharacter in the search as a literal", async () => {
    // ".*" would match every customer if the term were compiled unescaped.
    const res = await refs(`?subscription=${subId}&search=.*`);
    expect(res.body.data).toHaveLength(0);
  });

  it("lists cases when asked for them", async () => {
    await mongoose.model("Case").collection.insertMany([
      { uid: "CAS-0000001", title: "Structuring review", status: "open", client: clientCompanyId },
      { uid: "CAS-0000002", title: "Elsewhere", status: "open", client: new mongoose.Types.ObjectId() },
    ]);

    const res = await refs(`?subscription=${subId}&refType=Case`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].uid).toBe("CAS-0000001");
    expect(res.body.data[0].title).toBe("Structuring review");
  });

  it("rejects a record type it cannot reference", async () => {
    const res = await refs(`?subscription=${subId}&refType=Users`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a referenceable record type/i);
  });

  it("requires a subscription — the scope comes from it", async () => {
    const res = await refs("");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subscription is required/i);
  });

  it("404s an unknown subscription", async () => {
    const res = await refs(`?subscription=${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(404);
  });

  it("returns nothing, with a reason, when the subscription has no company", async () => {
    await mongoose.model("Subscription").updateOne({ _id: subId }, { $set: { client: null } });

    const res = await refs(`?subscription=${subId}`);
    expect(res.status).toBe(200);
    // Emphatically NOT every customer on the platform.
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.reason).toMatch(/no client company/i);
  });

  it("is dooit-only — a client cannot enumerate records this way", async () => {
    const res = await refs(`?subscription=${subId}`, client.auth);
    expect(res.status).toBe(403);
  });
});

describe("a manual record keeps its provenance", () => {
  it("stores refType and refId so a disputed charge traces back", async () => {
    const customerId = new mongoose.Types.ObjectId();

    const res = await record({
      externalId: "manual:CUS-0000001:202608011530",
      applicantKey: String(customerId),
      source: { system: "manual", refType: "Customer", refId: String(customerId) },
    });

    expect(res.status).toBe(201);
    expect(res.body.data.source.system).toBe("manual");
    expect(res.body.data.source.refType).toBe("Customer");
    expect(String(res.body.data.source.refId)).toBe(String(customerId));
    // The applicant key is the customer, which is what the allowance counts.
    expect(res.body.data.applicantKey).toBe(String(customerId));
  });

  it("still records when nothing is linked", async () => {
    const res = await record({
      externalId: "manual:entry:202608011530",
      source: { system: "manual", refType: null, refId: null },
    });

    expect(res.status).toBe(201);
    expect(res.body.data.source.refType).toBeNull();
  });
});
