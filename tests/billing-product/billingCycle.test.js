const { connect, disconnect, clearAll, makeUser } = require("./setup");

const request = require("supertest");
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");

const {
  sweepBillingCycle,
  advanceSubscription,
} = require("../../services/billing/billingCycleJob");
const { periodEndFor } = require("../../services/billing/subscriptionService");

let app, dooit, client, idDoc, subId, Subscription, Invoice;

beforeAll(async () => {
  await connect();
  require("../../models/Subscription");
  require("../../models/UsageRecord");
  require("../../models/Invoice");
  Subscription = mongoose.model("Subscription");
  Invoice = mongoose.model("Invoice");

  const errorHandler = require("../../middleware/error");
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1/product", require("../../routes/product"));
  app.use("/api/v1/billing-plan", require("../../routes/billing-plan"));
  app.use("/api/v1/subscription", require("../../routes/subscription"));
  app.use("/api/v1/usage", require("../../routes/usage"));
  app.use("/api/v1/invoice", require("../../routes/invoice"));
  app.use(errorHandler);
});

afterAll(disconnect);

beforeEach(async () => {
  await clearAll();
  delete process.env.BILLING_AUTO_ISSUE;

  dooit = await makeUser({ userType: "dooit", email: "admin@dooit.ai" });
  client = await makeUser({
    userType: "client",
    clientBelongs: new mongoose.Types.ObjectId(),
    email: "sarah@coinflip.test",
  });

  idDoc = (
    await request(app).post("/api/v1/product").set("Authorization", dooit.auth).send({
      name: "Identity Document Verification",
      code: "id_doc_verification",
      category: "Verification",
      unit: "check",
      defaultUnitPrice: 0.79,
    })
  ).body.data;

  const plan = await request(app)
    .post("/api/v1/billing-plan")
    .set("Authorization", dooit.auth)
    .send({
      name: "Growth",
      code: "plan_growth",
      pricingModel: "hybrid",
      billingCycle: "monthly",
      basePrice: 1900,
      includedUsage: 5000,
      includedUnit: "applicant",
      overagePrice: 0.68,
      visibility: "public",
      products: [{ productId: idDoc._id, enabled: true, unitPrice: 0.71 }],
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

/**
 * Drag a subscription's period into the past so the sweep sees it as due.
 * Uses updateOne to bypass the model's period-ordering validation, which is
 * there to stop a caller creating an inverted period — not to stop time passing.
 */
const backdateToDue = async (monthsAgo = 1) => {
  const start = new Date();
  start.setMonth(start.getMonth() - monthsAgo);
  const end = periodEndFor("monthly", start);
  await Subscription.updateOne(
    { _id: subId },
    { $set: { currentPeriodStart: start, currentPeriodEnd: end, nextInvoiceAt: end } }
  );
  return { start, end };
};

// ─────────────────────────────────────────────────────────────────────────────

describe("the sweep only touches subscriptions that are actually due", () => {
  it("leaves a subscription whose period has not ended alone", async () => {
    const stats = await sweepBillingCycle();
    expect(stats.scanned).toBe(0);
    expect(stats.invoiced).toBe(0);
    expect(await Invoice.countDocuments()).toBe(0);
  });

  it("skips a paused subscription — a paused account is not consuming cover", async () => {
    await backdateToDue();
    await Subscription.updateOne({ _id: subId }, { $set: { status: "paused" } });

    const stats = await sweepBillingCycle();
    expect(stats.scanned).toBe(0);
    expect(await Invoice.countDocuments()).toBe(0);
  });

  it("skips a subscription with a null nextInvoiceAt", async () => {
    await backdateToDue();
    await Subscription.updateOne({ _id: subId }, { $set: { nextInvoiceAt: null } });

    const stats = await sweepBillingCycle();
    expect(stats.scanned).toBe(0);
  });
});

describe("renewal", () => {
  it("closes the ended period and rolls the subscription forward", async () => {
    const { start, end } = await backdateToDue();

    const stats = await sweepBillingCycle();
    expect(stats.scanned).toBe(1);
    expect(stats.invoiced).toBe(1);

    const invoice = await Invoice.findOne({ subscription: subId });
    expect(invoice).not.toBeNull();
    expect(invoice.status).toBe("draft");
    // The period BILLED is the one that ended, not the month the sweep ran in.
    expect(invoice.periodKey).toBe(
      `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`
    );

    const sub = await Subscription.findById(subId);
    expect(sub.status).toBe("active");
    // Rolled forward FROM the period that ended, so the billing date does not
    // drift later every cycle.
    expect(sub.currentPeriodStart.toISOString()).toBe(end.toISOString());
    expect(sub.nextInvoiceAt.toISOString()).toBe(sub.currentPeriodEnd.toISOString());
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(end.getTime());
  });

  it("bills the base fee onto the renewal invoice", async () => {
    await backdateToDue();
    await sweepBillingCycle();

    const invoice = await Invoice.findOne({ subscription: subId });
    expect(invoice.totalValue).toBe(1900);
  });

  it("produces DRAFTS by default — no invoice number is burned", async () => {
    await backdateToDue();
    await sweepBillingCycle();

    const invoice = await Invoice.findOne({ subscription: subId });
    expect(invoice.status).toBe("draft");
    expect(invoice.invoiceNumber).toBeUndefined();
    expect(invoice.issuedAt).toBeNull();
  });

  it("issues when BILLING_AUTO_ISSUE=true", async () => {
    process.env.BILLING_AUTO_ISSUE = "true";
    await backdateToDue();
    await sweepBillingCycle();

    const invoice = await Invoice.findOne({ subscription: subId });
    expect(invoice.status).toBe("open");
    expect(invoice.invoiceNumber).toMatch(/^INV-\d{4}-\d{4}$/);
    expect(invoice.dueAt).not.toBeNull();
  });

  it("catches up a subscription several periods behind, one period per sweep", async () => {
    await backdateToDue(3);

    await sweepBillingCycle();
    expect(await Invoice.countDocuments({ subscription: subId })).toBe(1);

    // Still behind, so the next sweep bills the next period rather than
    // silently skipping to the present.
    await sweepBillingCycle();
    expect(await Invoice.countDocuments({ subscription: subId })).toBe(2);

    const keys = (await Invoice.find({ subscription: subId })).map((i) => i.periodKey);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("cancelAtPeriodEnd finally takes effect", () => {
  it("bills the final period, then expires the subscription", async () => {
    await backdateToDue();
    await request(app)
      .post(`/api/v1/subscription/${subId}/cancel`)
      .set("Authorization", client.auth)
      .send({});

    const stats = await sweepBillingCycle();
    expect(stats.ended).toBe(1);
    expect(stats.invoiced).toBe(0);

    const sub = await Subscription.findById(subId);
    expect(sub.status).toBe("expired");
    expect(sub.endedAt).not.toBeNull();
    expect(sub.nextInvoiceAt).toBeNull();

    // Cancelling does not erase usage already incurred — the final period is
    // still invoiced.
    expect(await Invoice.countDocuments({ subscription: subId })).toBe(1);
  });

  it("does not renew an expired subscription on the next sweep", async () => {
    await backdateToDue();
    await request(app)
      .post(`/api/v1/subscription/${subId}/cancel`)
      .set("Authorization", client.auth)
      .send({});
    await sweepBillingCycle();

    const stats = await sweepBillingCycle();
    expect(stats.scanned).toBe(0);
    expect(await Invoice.countDocuments({ subscription: subId })).toBe(1);
  });
});

describe("idempotency — the sweep is safe to retry and to run twice at once", () => {
  it("a second sweep over the same due period issues no second invoice", async () => {
    await backdateToDue();
    await sweepBillingCycle();

    // Put it back to due without clearing the invoice, as a crashed run would.
    await backdateToDue();
    const stats = await sweepBillingCycle();

    expect(stats.alreadyClosed).toBe(1);
    expect(stats.invoiced).toBe(0);
    expect(await Invoice.countDocuments({ subscription: subId })).toBe(1);
  });

  it("concurrent sweeps produce exactly one invoice", async () => {
    await backdateToDue();

    await Promise.all([sweepBillingCycle(), sweepBillingCycle(), sweepBillingCycle()]);

    expect(await Invoice.countDocuments({ subscription: subId })).toBe(1);
  });

  it("does not re-close a period the manual endpoint already closed", async () => {
    const { start } = await backdateToDue();
    const periodKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;

    const manual = await request(app)
      .post("/api/v1/invoice/close")
      .set("Authorization", dooit.auth)
      .send({ subscription: subId, periodKey });
    expect(manual.status).toBe(201);

    const stats = await sweepBillingCycle();
    expect(stats.alreadyClosed).toBe(1);
    expect(await Invoice.countDocuments({ subscription: subId })).toBe(1);
  });
});

describe("overdue sweep", () => {
  it("flags an issued invoice past its due date", async () => {
    process.env.BILLING_AUTO_ISSUE = "true";
    await backdateToDue();
    await sweepBillingCycle();

    await Invoice.updateOne(
      { subscription: subId },
      { $set: { dueAt: new Date(Date.now() - 86400000) } }
    );

    const stats = await sweepBillingCycle();
    expect(stats.markedOverdue).toBe(1);
    expect((await Invoice.findOne({ subscription: subId })).status).toBe("overdue");
  });

  it("leaves a draft invoice alone — only issued invoices can fall overdue", async () => {
    await backdateToDue();
    await sweepBillingCycle();
    await Invoice.updateOne(
      { subscription: subId },
      { $set: { dueAt: new Date(Date.now() - 86400000) } }
    );

    const stats = await sweepBillingCycle();
    expect(stats.markedOverdue).toBe(0);
    expect((await Invoice.findOne({ subscription: subId })).status).toBe("draft");
  });
});

describe("one failure does not abort the run", () => {
  it("keeps sweeping after a subscription throws", async () => {
    await backdateToDue();

    const other = await Subscription.findById(subId).lean();
    // A subscription with no priceSnapshot cannot be rated; it must be counted
    // as failed and skipped, not take the whole sweep down.
    await Subscription.collection.insertOne({
      ...other,
      _id: new mongoose.Types.ObjectId(),
      uid: "SUB-9999999",
      user: new mongoose.Types.ObjectId(),
      priceSnapshot: null,
    });

    const stats = await sweepBillingCycle();
    expect(stats.failed).toBe(1);
    expect(stats.invoiced).toBe(1); // the healthy one still billed
  });
});

describe("periodEndFor honours an explicit month count", () => {
  it("resolves a 12-month minimum term to 12 months, not 1", () => {
    const from = new Date("2026-01-15T00:00:00.000Z");
    const end = periodEndFor("monthly", from, 12);
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(0);
  });

  it("still falls back to the billing cycle when no count is given", () => {
    const from = new Date("2026-01-15T00:00:00.000Z");
    expect(periodEndFor("quarterly", from).getMonth()).toBe(3);
    expect(periodEndFor("yearly", from).getFullYear()).toBe(2027);
  });

  it("clamps a 31 Jan start to the end of February", () => {
    const end = periodEndFor("monthly", new Date("2026-01-31T00:00:00.000Z"));
    expect(end.getMonth()).toBe(1);
    expect(end.getDate()).toBe(28);
  });
});
