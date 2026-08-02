const { connect, disconnect, clearAll, makeUser } = require("./setup");

const request = require("supertest");
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");

let app, dooit, client, other, invoiceId, period;

beforeAll(async () => {
  await connect();
  require("../../models/Subscription");
  require("../../models/UsageRecord");
  require("../../models/Invoice");
  require("../../models/Payment");
  const errorHandler = require("../../middleware/error");
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1/product", require("../../routes/product"));
  app.use("/api/v1/billing-plan", require("../../routes/billing-plan"));
  app.use("/api/v1/subscription", require("../../routes/subscription"));
  app.use("/api/v1/invoice", require("../../routes/invoice"));
  app.use("/api/v1/payment", require("../../routes/payment"));
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
  other = await makeUser({ userType: "client", email: "other@t.test" });

  const prod = await request(app)
    .post("/api/v1/product")
    .set("Authorization", dooit.auth)
    .send({
      name: "ID Verification", code: "id_doc_verification",
      category: "Verification", unit: "check", defaultUnitPrice: 0.79,
    });

  const plan = await request(app)
    .post("/api/v1/billing-plan")
    .set("Authorization", dooit.auth)
    .send({
      name: "Growth", code: "plan_growth", basePrice: 1000,
      includedUsage: 5000, overagePrice: 0.68, visibility: "public",
      products: [{ productId: prod.body.data._id, enabled: true }],
    });
  await request(app)
    .post(`/api/v1/billing-plan/${plan.body.data._id}/publish`)
    .set("Authorization", dooit.auth);

  const sub = await request(app)
    .post("/api/v1/subscription")
    .set("Authorization", client.auth)
    .send({ plan: plan.body.data._id });

  const now = new Date();
  period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const closed = await request(app)
    .post("/api/v1/invoice/close")
    .set("Authorization", dooit.auth)
    .send({ subscription: sub.body.data._id, periodKey: period });

  const issued = await request(app)
    .post(`/api/v1/invoice/${closed.body.data._id}/issue`)
    .set("Authorization", dooit.auth);
  invoiceId = issued.body.data._id;
});

const pay = (body = {}, auth = dooit.auth) =>
  request(app)
    .post("/api/v1/payment")
    .set("Authorization", auth)
    .send({ invoice: invoiceId, method: "bank_transfer", ...body });

const getInvoice = () =>
  request(app).get(`/api/v1/invoice/${invoiceId}`).set("Authorization", dooit.auth);

// ─────────────────────────────────────────────────────────────────────────────

describe("recording a payment", () => {
  it("settles the invoice and defaults to the full balance", async () => {
    const res = await pay();
    expect(res.status).toBe(201);
    expect(res.body.data.uid).toMatch(/^PAY-\d{7}$/);
    expect(res.body.data.amount).toBe(1000);
    expect(res.body.data.type).toBe("payment");

    const inv = await getInvoice();
    expect(inv.body.data.status).toBe("paid");
    expect(inv.body.data.amountPaid).toBe(1000);
    expect(inv.body.data.amountDue).toBe(0);
  });

  it("supports partial payment, leaving the invoice open", async () => {
    const res = await pay({ amount: 400 });
    expect(res.status).toBe(201);

    const inv = await getInvoice();
    expect(inv.body.data.status).toBe("open");
    expect(inv.body.data.amountPaid).toBe(400);
    expect(inv.body.data.amountDue).toBe(600);

    await pay({ amount: 600 });
    const after = await getInvoice();
    expect(after.body.data.status).toBe("paid");
    expect(after.body.data.amountDue).toBe(0);
  });

  it("refuses to overpay", async () => {
    const res = await pay({ amount: 1500 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/exceeds the 1000\.00 outstanding/i);
  });

  it("refuses a draft or void invoice", async () => {
    const closed = await request(app)
      .get(`/api/v1/invoice?status=draft`)
      .set("Authorization", dooit.auth);
    expect(closed.body.data).toHaveLength(0); // ours was issued

    await request(app)
      .post(`/api/v1/invoice/${invoiceId}/void`)
      .set("Authorization", dooit.auth);
    const res = await pay();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/void invoice cannot be paid/i);
  });

  it("a replayed gateway transaction is a no-op, not a double charge", async () => {
    const first = await pay({ amount: 500, transactionId: "txn_abc" });
    expect(first.status).toBe(201);

    const replay = await pay({ amount: 500, transactionId: "txn_abc" });
    expect(replay.status).toBe(200);
    expect(replay.body.meta.duplicate).toBe(true);
    expect(replay.body.data._id).toBe(first.body.data._id);

    const inv = await getInvoice();
    expect(inv.body.data.amountPaid).toBe(500); // not 1000
  });

  it("a client cannot record a payment", async () => {
    const res = await pay({}, client.auth);
    expect(res.status).toBe(403);
  });
});

describe("failure and retry", () => {
  it("a failed payment leaves the invoice owing", async () => {
    const res = await pay({
      status: "failed",
      failureCode: "insufficient_funds",
      failureReason: "Insufficient balance",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("failed");
    expect(res.body.data.failedAt).toBeTruthy();

    const inv = await getInvoice();
    expect(inv.body.data.status).toBe("open");
    expect(inv.body.data.amountDue).toBe(1000);
  });

  it("a retry is a NEW record — the failure history survives", async () => {
    const failed = await pay({ status: "failed", failureReason: "Card declined" });

    const retry = await request(app)
      .post(`/api/v1/payment/${failed.body.data._id}/retry`)
      .set("Authorization", dooit.auth)
      .send({ status: "paid", transactionId: "txn_retry_1" });

    expect(retry.status).toBe(201);
    expect(retry.body.data.retryCount).toBe(1);
    expect(String(retry.body.data.retryOf)).toBe(String(failed.body.data._id));

    // BOTH records persist
    const list = await request(app)
      .get(`/api/v1/payment?invoice=${invoiceId}`)
      .set("Authorization", dooit.auth);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.map((p) => p.status).sort()).toEqual(["failed", "paid"]);

    const inv = await getInvoice();
    expect(inv.body.data.status).toBe("paid");
  });

  it("chains retryCount across repeated failures", async () => {
    const a = await pay({ status: "failed", failureReason: "1st" });
    const b = await request(app)
      .post(`/api/v1/payment/${a.body.data._id}/retry`)
      .set("Authorization", dooit.auth)
      .send({ status: "failed", failureReason: "2nd" });
    expect(b.body.data.retryCount).toBe(1);

    const c = await request(app)
      .post(`/api/v1/payment/${b.body.data._id}/retry`)
      .set("Authorization", dooit.auth)
      .send({ status: "paid" });
    expect(c.body.data.retryCount).toBe(2);
    expect(c.body.meta.attempt).toBe(3);
  });

  it("only a failed payment can be retried", async () => {
    const ok = await pay();
    const res = await request(app)
      .post(`/api/v1/payment/${ok.body.data._id}/retry`)
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(409);
  });
});

describe("refunds", () => {
  it("a full refund reopens the invoice", async () => {
    const paid = await pay();
    let inv = await getInvoice();
    expect(inv.body.data.status).toBe("paid");

    const refund = await request(app)
      .post(`/api/v1/payment/${paid.body.data._id}/refund`)
      .set("Authorization", dooit.auth)
      .send({ reason: "Duplicate charge" });

    expect(refund.status).toBe(201);
    expect(refund.body.data.type).toBe("refund");
    expect(refund.body.data.amount).toBe(1000); // POSITIVE — type carries direction
    expect(String(refund.body.data.refundOf)).toBe(String(paid.body.data._id));
    expect(refund.body.meta.partial).toBe(false);

    inv = await getInvoice();
    expect(inv.body.data.status).toBe("open");
    expect(inv.body.data.amountPaid).toBe(0);
    expect(inv.body.data.amountDue).toBe(1000);
  });

  it("supports partial refunds and caps the total at what was collected", async () => {
    const paid = await pay();

    const first = await request(app)
      .post(`/api/v1/payment/${paid.body.data._id}/refund`)
      .set("Authorization", dooit.auth)
      .send({ amount: 300 });
    expect(first.body.meta.partial).toBe(true);
    expect(first.body.meta.refundedToDate).toBe(300);

    let inv = await getInvoice();
    expect(inv.body.data.amountPaid).toBe(700);
    expect(inv.body.data.amountDue).toBe(300);

    // the original stays 'paid' while anything remains unrefunded
    const orig = await request(app)
      .get(`/api/v1/payment/${paid.body.data._id}`)
      .set("Authorization", dooit.auth);
    expect(orig.body.data.status).toBe("paid");

    // over-refunding the remainder is refused
    const tooMuch = await request(app)
      .post(`/api/v1/payment/${paid.body.data._id}/refund`)
      .set("Authorization", dooit.auth)
      .send({ amount: 800 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatch(/only 700\.00 of this payment remains/i);

    // the rest is fine, and closes the original out
    const rest = await request(app)
      .post(`/api/v1/payment/${paid.body.data._id}/refund`)
      .set("Authorization", dooit.auth)
      .send({ amount: 700 });
    expect(rest.body.meta.partial).toBe(false);

    const closed = await request(app)
      .get(`/api/v1/payment/${paid.body.data._id}`)
      .set("Authorization", dooit.auth);
    expect(closed.body.data.status).toBe("refunded");

    inv = await getInvoice();
    expect(inv.body.data.amountDue).toBe(1000);
  });

  it("a refund cannot itself be refunded", async () => {
    const paid = await pay();
    const refund = await request(app)
      .post(`/api/v1/payment/${paid.body.data._id}/refund`)
      .set("Authorization", dooit.auth);

    const res = await request(app)
      .post(`/api/v1/payment/${refund.body.data._id}/refund`)
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot itself be refunded/i);
  });

  it("a failed payment cannot be refunded", async () => {
    const failed = await pay({ status: "failed" });
    const res = await request(app)
      .post(`/api/v1/payment/${failed.body.data._id}/refund`)
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(409);
  });
});

describe("reconciliation is derived, not incremented", () => {
  it("survives an out-of-order pay / refund / pay sequence", async () => {
    const a = await pay({ amount: 600 });
    await pay({ amount: 400 });
    let inv = await getInvoice();
    expect(inv.body.data.amountDue).toBe(0);

    await request(app)
      .post(`/api/v1/payment/${a.body.data._id}/refund`)
      .set("Authorization", dooit.auth)
      .send({ amount: 600 });

    inv = await getInvoice();
    // 1000 collected - 600 refunded = 400 net
    expect(inv.body.data.amountPaid).toBe(400);
    expect(inv.body.data.amountDue).toBe(600);
    expect(inv.body.data.status).toBe("open");

    await pay({ amount: 600 });
    inv = await getInvoice();
    expect(inv.body.data.amountDue).toBe(0);
    expect(inv.body.data.status).toBe("paid");
  });

  it("summarises an invoice's payment history", async () => {
    const a = await pay({ amount: 700 });
    await pay({ status: "failed", amount: 300, failureReason: "declined" });
    await request(app)
      .post(`/api/v1/payment/${a.body.data._id}/refund`)
      .set("Authorization", dooit.auth)
      .send({ amount: 200 });

    const res = await request(app)
      .get(`/api/v1/payment/for-invoice/${invoiceId}`)
      .set("Authorization", client.auth);

    expect(res.status).toBe(200);
    expect(res.body.meta.collected).toBe(700);
    expect(res.body.meta.refunded).toBe(200);
    expect(res.body.meta.net).toBe(500);
    expect(res.body.meta.failures).toBe(1);
    expect(res.body.meta.amountDue).toBe(500);
  });
});

describe("scoping", () => {
  it("a client sees only its own payments", async () => {
    await pay();

    const mine = await request(app)
      .get("/api/v1/payment")
      .set("Authorization", client.auth);
    expect(mine.body.data).toHaveLength(1);

    const theirs = await request(app)
      .get("/api/v1/payment")
      .set("Authorization", other.auth);
    expect(theirs.body.data).toHaveLength(0);
  });

  it("404s when a client fetches another client's payment", async () => {
    const p = await pay();
    const res = await request(app)
      .get(`/api/v1/payment/${p.body.data._id}`)
      .set("Authorization", other.auth);
    expect(res.status).toBe(404);
  });
});

describe("model-level immutability", () => {
  it("a settled payment cannot have its amount changed", async () => {
    const Payment = mongoose.model("Payment");
    const p = await pay();
    const doc = await Payment.findById(p.body.data._id);
    doc.amount = require("../../utils/money").toDecimal(1);
    await expect(doc.save()).rejects.toThrow(/immutable/i);
  });

  it("rejects a refund with no original", async () => {
    const Payment = mongoose.model("Payment");
    const bad = new Payment({
      user: client.user._id,
      invoice: invoiceId,
      type: "refund",
      amount: 10,
      method: "card",
    });
    await expect(bad.validate()).rejects.toThrow(/must reference the original/i);
  });
});
