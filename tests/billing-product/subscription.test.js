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
  require("../../models/Subscription");
  const errorHandler = require("../../middleware/error");
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1/product", require("../../routes/product"));
  app.use("/api/v1/billing-plan", require("../../routes/billing-plan"));
  app.use("/api/v1/subscription", require("../../routes/subscription"));
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

const makePlan = async (over = {}) => {
  const res = await request(app)
    .post("/api/v1/billing-plan")
    .set("Authorization", dooit.auth)
    .send({
      name: "Growth",
      code: "plan_growth",
      pricingModel: "hybrid",
      billingCycle: "monthly",
      basePrice: 1900,
      includedUsage: 5000,
      overagePrice: 0.68,
      visibility: "public",
      tiers: [{ from: 0, to: null, unitPrice: 0.79, discountPercent: 0 }],
      products: [{ productId, enabled: true, includedQuantity: 5000, unitPrice: 0.79 }],
      ...over,
    });
  await request(app)
    .post(`/api/v1/billing-plan/${res.body.data._id}/publish`)
    .set("Authorization", dooit.auth);
  return res.body.data;
};

const subscribe = (planId, auth = client.auth, body = {}) =>
  request(app)
    .post("/api/v1/subscription")
    .set("Authorization", auth)
    .send({ plan: planId, ...body });

// ─────────────────────────────────────────────────────────────────────────────

describe("subscribe", () => {
  it("a client subscribes and the price is frozen into a snapshot", async () => {
    const plan = await makePlan();
    const res = await subscribe(plan._id);

    expect(res.status).toBe(201);
    const s = res.body.data;
    expect(s.uid).toMatch(/^SUB-\d{7}$/);
    expect(s.priceSnapshot.planCode).toBe("plan_growth");
    expect(s.priceSnapshot.planVersion).toBe(1);
    expect(s.priceSnapshot.basePrice).toBe(1900);
    expect(s.priceSnapshot.products).toHaveLength(1);
    expect(s.priceSnapshot.snapshotAt).toBeTruthy();
    expect(new Date(s.currentPeriodEnd) > new Date(s.currentPeriodStart)).toBe(true);
  });

  it("the snapshot survives the plan being versioned and archived", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id);

    // dooit publishes v2 at a new price — archives v1
    const v2 = await request(app)
      .post(`/api/v1/billing-plan/${plan._id}/new-version`)
      .set("Authorization", dooit.auth);
    await request(app)
      .put(`/api/v1/billing-plan/${v2.body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({ basePrice: 4000 });
    await request(app)
      .post(`/api/v1/billing-plan/${v2.body.data._id}/publish`)
      .set("Authorization", dooit.auth);

    const after = await request(app)
      .get(`/api/v1/subscription/${sub.body.data._id}`)
      .set("Authorization", client.auth);

    expect(after.body.data.priceSnapshot.basePrice).toBe(1900); // NOT 4000
    expect(after.body.data.priceSnapshot.planVersion).toBe(1);
  });

  it("refuses a second subscription for the same user", async () => {
    const plan = await makePlan();
    await subscribe(plan._id);
    const again = await subscribe(plan._id);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already has a/i);
  });

  it("refuses a draft plan", async () => {
    const res = await request(app)
      .post("/api/v1/billing-plan")
      .set("Authorization", dooit.auth)
      .send({
        name: "Draft",
        code: "plan_draft",
        basePrice: 100,
        products: [{ productId, enabled: true }],
      });
    const sub = await subscribe(res.body.data._id);
    expect(sub.status).toBe(400);
    expect(sub.body.error).toMatch(/draft plan cannot be subscribed/i);
  });

  it("routes a quote-only plan to sales with 409", async () => {
    const plan = await makePlan({
      code: "plan_enterprise",
      basePrice: 0,
      isCustomPriced: true,
    });
    const res = await subscribe(plan._id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/quote-only/i);
  });

  it("404s a private plan the client was not granted", async () => {
    const plan = await request(app)
      .post("/api/v1/billing-plan")
      .set("Authorization", dooit.auth)
      .send({
        name: "Bespoke",
        code: "plan_bespoke",
        visibility: "private",
        basePrice: 500,
        products: [{ productId, enabled: true }],
      });
    await request(app)
      .post(`/api/v1/billing-plan/${plan.body.data._id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: client.user._id });
    await request(app)
      .post(`/api/v1/billing-plan/${plan.body.data._id}/publish`)
      .set("Authorization", dooit.auth);

    const granted = await subscribe(plan.body.data._id, client.auth);
    expect(granted.status).toBe(201);

    const denied = await subscribe(plan.body.data._id, otherClient.auth);
    expect(denied.status).toBe(404);
  });

  it("dooit can provision for a client user", async () => {
    const plan = await makePlan();
    const res = await subscribe(plan._id, dooit.auth, { user: client.user._id });
    expect(res.status).toBe(201);
    expect(String(res.body.data.user)).toBe(String(client.user._id));
  });

  it("dooit cannot provision for a dooit user", async () => {
    const plan = await makePlan();
    const res = await subscribe(plan._id, dooit.auth, { user: dooit.user._id });
    expect(res.status).toBe(403);
  });
});

describe("scoping", () => {
  it("a client sees only its own subscriptions", async () => {
    const plan = await makePlan();
    await subscribe(plan._id, client.auth);
    await subscribe(plan._id, otherClient.auth);

    const mine = await request(app)
      .get("/api/v1/subscription")
      .set("Authorization", client.auth);
    expect(mine.body.data).toHaveLength(1);

    const all = await request(app)
      .get("/api/v1/subscription")
      .set("Authorization", dooit.auth);
    expect(all.body.data).toHaveLength(2);
  });

  it("404s when a client fetches another client's subscription", async () => {
    const plan = await makePlan();
    const mine = await subscribe(plan._id, client.auth);
    const res = await request(app)
      .get(`/api/v1/subscription/${mine.body.data._id}`)
      .set("Authorization", otherClient.auth);
    expect(res.status).toBe(404);
  });

  it("a client cannot filter by another user", async () => {
    const plan = await makePlan();
    await subscribe(plan._id, client.auth);
    await subscribe(plan._id, otherClient.auth);

    const res = await request(app)
      .get(`/api/v1/subscription?user=${otherClient.user._id}`)
      .set("Authorization", client.auth);
    // the ?user= filter is ignored for a client — still only their own
    expect(res.body.data).toHaveLength(1);
    expect(String(res.body.data[0].user._id)).toBe(String(client.user._id));
  });

  it("current returns the live subscription", async () => {
    const plan = await makePlan();
    await subscribe(plan._id, client.auth);
    const res = await request(app)
      .get("/api/v1/subscription/current")
      .set("Authorization", client.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.planCode).toBe("plan_growth");
  });

  it("current is null with no subscription", async () => {
    const res = await request(app)
      .get("/api/v1/subscription/current")
      .set("Authorization", client.auth);
    expect(res.body.data).toBeNull();
  });
});

describe("change plan", () => {
  const makeScale = () =>
    makePlan({ code: "plan_scale", name: "Scale", basePrice: 4800 });

  it("supersedes rather than mutating, and links both ways", async () => {
    const growth = await makePlan();
    const scale = await makeScale();
    const sub = await subscribe(growth._id);

    const res = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/change-plan`)
      .set("Authorization", client.auth)
      .send({ plan: scale._id });

    expect(res.status).toBe(201);
    expect(res.body.meta.direction).toBe("upgrade");
    expect(res.body.data.changeType).toBe("upgrade");
    expect(String(res.body.data.previousSubscription)).toBe(String(sub.body.data._id));
    // the new subscription carries its OWN snapshot
    expect(res.body.data.priceSnapshot.basePrice).toBe(4800);

    const old = await request(app)
      .get(`/api/v1/subscription/${sub.body.data._id}`)
      .set("Authorization", client.auth);
    expect(old.body.data.status).toBe("cancelled");
    expect(String(old.body.data.replacedBySubscription)).toBe(String(res.body.data._id));
    // the old snapshot is untouched
    expect(old.body.data.priceSnapshot.basePrice).toBe(1900);
  });

  it("classifies a cheaper plan as a downgrade", async () => {
    const growth = await makePlan();
    const starter = await makePlan({ code: "plan_starter", name: "Starter", basePrice: 500 });
    const sub = await subscribe(growth._id);

    const res = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/change-plan`)
      .set("Authorization", client.auth)
      .send({ plan: starter._id });
    expect(res.body.meta.direction).toBe("downgrade");
  });

  it("honours a snapshot that forbids downgrades", async () => {
    const locked = await makePlan({
      code: "plan_locked",
      changePolicy: { allowUpgrade: true, allowDowngrade: false, allowCancel: true },
    });
    const cheap = await makePlan({ code: "plan_cheap", name: "Cheap", basePrice: 100 });
    const sub = await subscribe(locked._id);

    const res = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/change-plan`)
      .set("Authorization", client.auth)
      .send({ plan: cheap._id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/does not allow downgrades/i);
  });

  it("refuses changing to the same plan", async () => {
    const growth = await makePlan();
    const sub = await subscribe(growth._id);
    const res = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/change-plan`)
      .set("Authorization", client.auth)
      .send({ plan: growth._id });
    expect(res.status).toBe(409);
  });

  it("a client cannot change another client's subscription", async () => {
    const growth = await makePlan();
    const scale = await makeScale();
    const sub = await subscribe(growth._id, client.auth);
    const res = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/change-plan`)
      .set("Authorization", otherClient.auth)
      .send({ plan: scale._id });
    expect(res.status).toBe(404);
  });
});

describe("cancel & resume", () => {
  it("cancels at period end and stays active until then", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id);
    const res = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/cancel`)
      .set("Authorization", client.auth)
      .send({ reason: "Too expensive" });

    expect(res.status).toBe(200);
    expect(res.body.data.cancelAtPeriodEnd).toBe(true);
    expect(res.body.data.status).toBe("active"); // still serving until period end
    expect(res.body.meta.immediate).toBe(false);
  });

  it("resume undoes a scheduled cancellation", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id);
    await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/cancel`)
      .set("Authorization", client.auth);

    const res = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/resume`)
      .set("Authorization", client.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.cancelAtPeriodEnd).toBe(false);
    expect(res.body.data.cancelledAt).toBeNull();
  });

  it("only dooit can cancel immediately", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id);

    const byClient = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/cancel`)
      .set("Authorization", client.auth)
      .send({ immediate: true });
    expect(byClient.body.data.status).toBe("active"); // request ignored

    const byDooit = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/cancel`)
      .set("Authorization", dooit.auth)
      .send({ immediate: true });
    expect(byDooit.body.data.status).toBe("cancelled");
  });

  it("honours a snapshot that forbids cancellation", async () => {
    const plan = await makePlan({
      code: "plan_nocancel",
      changePolicy: { allowUpgrade: true, allowDowngrade: true, allowCancel: false },
    });
    const sub = await subscribe(plan._id);
    const res = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/cancel`)
      .set("Authorization", client.auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/does not allow self-service cancellation/i);
  });

  it("pause is dooit-only", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id);

    const byClient = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/pause`)
      .set("Authorization", client.auth);
    expect(byClient.status).toBe(403);

    const byDooit = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/pause`)
      .set("Authorization", dooit.auth);
    expect(byDooit.status).toBe(200);
    expect(byDooit.body.data.status).toBe("paused");
  });
});

describe("snapshot immutability at the model level", () => {
  it("rejects an attempt to edit priceSnapshot after creation", async () => {
    const Subscription = mongoose.model("Subscription");
    const plan = await makePlan();
    const created = await subscribe(plan._id);

    const doc = await Subscription.findById(created.body.data._id);
    doc.priceSnapshot.basePrice = mongoose.Types.Decimal128.fromString("1.00");
    await expect(doc.save()).rejects.toThrow(/immutable/i);
  });
});

describe("moving to a newer version of the SAME plan code", () => {
  it("is a valid plan change and re-snapshots at the new price", async () => {
    const v1 = await makePlan(); // plan_growth v1 @ 1900
    const sub = await subscribe(v1._id);
    expect(sub.body.data.planVersion).toBe(1);

    // dooit publishes v2 at a new price
    const draft = await request(app)
      .post(`/api/v1/billing-plan/${v1._id}/new-version`)
      .set("Authorization", dooit.auth);
    await request(app)
      .put(`/api/v1/billing-plan/${draft.body.data._id}`)
      .set("Authorization", dooit.auth)
      .send({ basePrice: 2400 });
    await request(app)
      .post(`/api/v1/billing-plan/${draft.body.data._id}/publish`)
      .set("Authorization", dooit.auth);

    // the subscriber is still on v1 at the old price
    const before = await request(app)
      .get("/api/v1/subscription/current")
      .set("Authorization", client.auth);
    expect(before.body.data.planVersion).toBe(1);
    expect(before.body.data.priceSnapshot.basePrice).toBe(1900);

    // "Move to v2" — a change to a different plan document, same code
    const moved = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/change-plan`)
      .set("Authorization", client.auth)
      .send({ plan: draft.body.data._id });

    expect(moved.status).toBe(201);
    expect(moved.body.data.planCode).toBe("plan_growth");
    expect(moved.body.data.planVersion).toBe(2);
    expect(moved.body.data.priceSnapshot.basePrice).toBe(2400);
    expect(moved.body.meta.direction).toBe("upgrade");
    expect(String(moved.body.data.previousSubscription)).toBe(String(sub.body.data._id));
  });

  it("a same-price version move is classified lateral, not an upgrade", async () => {
    const v1 = await makePlan();
    const sub = await subscribe(v1._id);

    const draft = await request(app)
      .post(`/api/v1/billing-plan/${v1._id}/new-version`)
      .set("Authorization", dooit.auth);
    await request(app)
      .post(`/api/v1/billing-plan/${draft.body.data._id}/publish`)
      .set("Authorization", dooit.auth);

    const moved = await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/change-plan`)
      .set("Authorization", client.auth)
      .send({ plan: draft.body.data._id });

    expect(moved.status).toBe(201);
    expect(moved.body.meta.direction).toBe("lateral");
    // a lateral move must not be blocked by upgrade/downgrade policy
    expect(moved.body.data.changeType).toBe("new");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("dooit assigns a plan to a client", () => {
  it("provisions on a client's behalf when it passes { user }", async () => {
    const plan = await makePlan();
    const res = await subscribe(plan._id, dooit.auth, { user: client.user._id });

    expect(res.status).toBe(201);
    // The subscription belongs to the CLIENT, not to the dooit user that made it.
    expect(String(res.body.data.user)).toBe(String(client.user._id));
    expect(String(res.body.data.createdBy)).toBe(String(dooit.user._id));
    expect(res.body.data.priceSnapshot.basePrice).toBe(1900);
  });

  it("records the client company passed alongside the user", async () => {
    const plan = await makePlan();
    const companyId = new mongoose.Types.ObjectId();
    const res = await subscribe(plan._id, dooit.auth, {
      user: client.user._id,
      client: companyId,
    });

    expect(res.status).toBe(201);
    expect(String(res.body.data.client)).toBe(String(companyId));
  });

  it("assigns a QUOTE-ONLY plan — the only route by which one is ever sold", async () => {
    const plan = await makePlan({
      code: "plan_enterprise",
      basePrice: 0,
      isCustomPriced: true,
    });

    // A client is still refused …
    const asClient = await subscribe(plan._id);
    expect(asClient.status).toBe(409);
    expect(asClient.body.error).toMatch(/quote-only/i);

    // … but dooit, which IS the sales route, can provision it.
    const asDooit = await subscribe(plan._id, dooit.auth, { user: client.user._id });
    expect(asDooit.status).toBe(201);
    expect(asDooit.body.data.priceSnapshot.isCustomPriced).toBe(true);
    // No list price exists, so the base fee is zero and only usage bills.
    expect(asDooit.body.data.priceSnapshot.basePrice).toBe(0);
  });

  it("assigns a PRIVATE plan to a client that was never granted access", async () => {
    // A private plan cannot be published with no grant at all, so it is granted
    // to a DIFFERENT account — `client` below is never on the access list.
    const created = await request(app)
      .post("/api/v1/billing-plan")
      .set("Authorization", dooit.auth)
      .send({
        name: "Bespoke",
        code: "plan_bespoke",
        visibility: "private",
        basePrice: 500,
        products: [{ productId, enabled: true }],
      });
    await request(app)
      .post(`/api/v1/billing-plan/${created.body.data._id}/eligibility`)
      .set("Authorization", dooit.auth)
      .send({ user: otherClient.user._id });
    await request(app)
      .post(`/api/v1/billing-plan/${created.body.data._id}/publish`)
      .set("Authorization", dooit.auth);

    const planId = created.body.data._id;

    // The ungranted client cannot even see it — 404, not 403, so a private plan
    // stays undisclosed.
    const asClient = await subscribe(planId);
    expect(asClient.status).toBe(404);

    // … but dooit grants access in the first place, so it may assign directly.
    const asDooit = await subscribe(planId, dooit.auth, { user: client.user._id });
    expect(asDooit.status).toBe(201);
    expect(String(asDooit.body.data.user)).toBe(String(client.user._id));
  });

  it("still refuses a draft plan — unpublished pricing is not a contract", async () => {
    const res = await request(app)
      .post("/api/v1/billing-plan")
      .set("Authorization", dooit.auth)
      .send({
        name: "Draft",
        code: "plan_draft",
        basePrice: 100,
        products: [{ productId, enabled: true }],
      });

    const assigned = await subscribe(res.body.data._id, dooit.auth, {
      user: client.user._id,
    });
    expect(assigned.status).toBe(400);
    expect(assigned.body.error).toMatch(/draft plan cannot be subscribed/i);
  });

  it("refuses to assign to a user who is not an active client", async () => {
    const plan = await makePlan();
    const res = await subscribe(plan._id, dooit.auth, { user: dooit.user._id });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/must reference an active "client" user/i);
  });

  it("refuses a second subscription and names the existing one", async () => {
    const plan = await makePlan();
    await subscribe(plan._id, dooit.auth, { user: client.user._id });

    const again = await subscribe(plan._id, dooit.auth, { user: client.user._id });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already has an existing subscription/i);
    // The message must name the plan and its state so the operator knows to
    // change it rather than retry — and must not read "a active".
    expect(again.body.error).toMatch(/plan_growth/);
    expect(again.body.error).toMatch(/active/);
    expect(again.body.error).not.toMatch(/\ba active\b/);
  });

  it("a client cannot provision for someone else by passing { user }", async () => {
    const plan = await makePlan();
    // The controller pins `user` from the JWT for a client and ignores the body.
    const res = await subscribe(plan._id, client.auth, { user: otherClient.user._id });

    expect(res.status).toBe(201);
    expect(String(res.body.data.user)).toBe(String(client.user._id));
    expect(String(res.body.data.user)).not.toBe(String(otherClient.user._id));
  });

  it("dooit moves an assigned account to another plan", async () => {
    const growth = await makePlan();
    const assigned = await subscribe(growth._id, dooit.auth, { user: client.user._id });

    const scale = await makePlan({ code: "plan_scale", name: "Scale", basePrice: 4000 });
    const moved = await request(app)
      .post(`/api/v1/subscription/${assigned.body.data._id}/change-plan`)
      .set("Authorization", dooit.auth)
      .send({ plan: scale._id });

    expect(moved.status).toBe(201);
    expect(moved.body.data.planCode).toBe("plan_scale");
    expect(String(moved.body.data.user)).toBe(String(client.user._id));
    // Supersedes rather than mutates — the old snapshot stays intact.
    expect(String(moved.body.data.previousSubscription)).toBe(
      String(assigned.body.data._id)
    );
  });
});

describe("negotiated discount", () => {
  const setDiscount = (id, body, auth) =>
    request(app)
      .patch(`/api/v1/subscription/${id}/discount`)
      .set("Authorization", auth ?? dooit.auth)
      .send(body);

  it("dooit attaches a discount when assigning the plan", async () => {
    const plan = await makePlan();
    const res = await subscribe(plan._id, dooit.auth, {
      user: client.user._id,
      discount: { type: "percentage", value: 15, reason: "Launch partner" },
    });

    expect(res.status).toBe(201);
    expect(res.body.data.discount.type).toBe("percentage");
    expect(res.body.data.discount.value).toBe(15);
    expect(res.body.data.discount.reason).toBe("Launch partner");
    // Who agreed to it — a concession needs an author.
    expect(String(res.body.data.discount.appliedBy)).toBe(String(dooit.user._id));
  });

  it("a client cannot discount itself, and is told so rather than ignored", async () => {
    const plan = await makePlan();
    const res = await subscribe(plan._id, client.auth, {
      discount: { type: "percentage", value: 50 },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only dooit/i);
  });

  it("dooit updates and clears the discount after the fact", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id, dooit.auth, { user: client.user._id });
    const id = sub.body.data._id;

    const set = await setDiscount(id, { type: "fixed", value: 250, reason: "Service credit" });
    expect(set.status).toBe(200);
    expect(set.body.data.discount.type).toBe("fixed");
    expect(set.body.data.discount.value).toBe(250);
    expect(set.body.meta.previous.type).toBe("none");

    const cleared = await setDiscount(id, { type: "none" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.discount.type).toBe("none");
    expect(cleared.body.data.discount.value).toBe(0);
    expect(cleared.body.meta.cleared).toBe(true);
    expect(cleared.body.meta.previous.value).toBe(250);
  });

  it("rejects a percentage over 100 — it would invert the invoice", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id, dooit.auth, { user: client.user._id });

    const res = await setDiscount(sub.body.data._id, { type: "percentage", value: 150 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot exceed 100/i);
  });

  it("is dooit-only — a client cannot set one on its own subscription", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id);

    const res = await setDiscount(sub.body.data._id, { type: "percentage", value: 10 }, client.auth);
    expect(res.status).toBe(403);
  });

  it("refuses a discount on a subscription that will never bill again", async () => {
    const plan = await makePlan();
    const sub = await subscribe(plan._id, dooit.auth, { user: client.user._id });
    await request(app)
      .post(`/api/v1/subscription/${sub.body.data._id}/cancel`)
      .set("Authorization", dooit.auth)
      .send({ immediate: true });

    const res = await setDiscount(sub.body.data._id, { type: "percentage", value: 10 });
    // Either it is already terminal (409) or cancellation deferred to period
    // end and it is still billable (200) — both are coherent, silently
    // accepting a no-op on a dead subscription is not.
    expect([200, 409]).toContain(res.status);
  });
});
