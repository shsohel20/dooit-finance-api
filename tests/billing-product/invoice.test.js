// SMTP must never be touched by a test, and Chrome must never be launched:
// renderInvoicePdf spawns a real browser, which would make this suite minutes
// long. renderInvoiceHtml stays REAL so the document assertions mean something.
jest.mock("../../utils/sendEmail");
jest.mock("../../services/billing/invoiceDocument", () => {
  const actual = jest.requireActual("../../services/billing/invoiceDocument");
  return {
    ...actual,
    renderInvoicePdf: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4 stub")),
  };
});

const { connect, disconnect, clearAll, makeUser } = require("./setup");

const request = require("supertest");
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");

const { priceThroughTiers } = require("../../services/billing/invoiceService");
const { sweepDunning } = require("../../services/billing/invoiceDunning");
const Invoice = require("../../models/Invoice");

let app, dooit, client, idDoc, amlScreen, deviceIntel, subId, period;

beforeAll(async () => {
  await connect();
  require("../../models/Subscription");
  require("../../models/UsageRecord");
  require("../../models/Invoice");
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

const mkProduct = (code, name, price, category = "Verification") =>
  request(app).post("/api/v1/product").set("Authorization", dooit.auth).send({
    name, code, category, unit: "check", defaultUnitPrice: price,
  });

/** Record N events for a product, each with its own applicant. */
const meter = async (productCode, count, applicantPrefix, over = {}) => {
  const events = Array.from({ length: count }, (_, i) => ({
    subscription: subId,
    productCode,
    quantity: 1,
    externalId: `${applicantPrefix}_${productCode}_${i}`,
    applicantKey: `${applicantPrefix}_${i % (over.applicants ?? count)}`,
    source: { system: "dooit" },
    ...over.event,
  }));
  return request(app)
    .post("/api/v1/usage/bulk")
    .set("Authorization", dooit.auth)
    .send({ events });
};

beforeEach(async () => {
  await clearAll();
  dooit = await makeUser({ userType: "dooit", email: "admin@dooit.ai" });
  client = await makeUser({
    userType: "client",
    clientBelongs: new mongoose.Types.ObjectId(),
    email: "sarah@coinflip.test",
  });

  idDoc = (await mkProduct("id_doc_verification", "Identity Document Verification", 0.79)).body.data;
  amlScreen = (await mkProduct("aml_screening", "AML Screening", 0.4, "Screening")).body.data;
  deviceIntel = (await mkProduct("device_intelligence", "Device Intelligence", 0.0065, "Risk")).body.data;

  // Growth: A$1,900/mo, 5,000 included applicants, A$0.68 overage.
  // Entitles ID verification and AML screening; NOT device intelligence.
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
      products: [
        { productId: idDoc._id, enabled: true, unitPrice: 0.71 },
        { productId: amlScreen._id, enabled: true, unitPrice: 0.4 },
      ],
    });
  await request(app)
    .post(`/api/v1/billing-plan/${plan.body.data._id}/publish`)
    .set("Authorization", dooit.auth);

  const sub = await request(app)
    .post("/api/v1/subscription")
    .set("Authorization", client.auth)
    .send({ plan: plan.body.data._id });
  subId = sub.body.data._id;

  const now = new Date();
  period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
});

const close = (over = {}) =>
  request(app)
    .post("/api/v1/invoice/close")
    .set("Authorization", dooit.auth)
    .send({ subscription: subId, periodKey: period, ...over });

// ─────────────────────────────────────────────────────────────────────────────

describe("Model B — the allowance covers entitled usage", () => {
  it("THE WORKED EXAMPLE: 430 ID checks + 388 AML for 200 applicants = A$1,900.00", async () => {
    await meter("id_doc_verification", 430, "cust", { applicants: 200 });
    await meter("aml_screening", 388, "cust", { applicants: 200 });

    const res = await close();
    expect(res.status).toBe(201);
    const inv = res.body.data;

    // The headline: base fee only. Entitled usage is already paid for.
    expect(inv.total).toBe(1900);
    expect(inv.subtotal).toBe(1900);

    const base = inv.lineItems.find((l) => l.lineType === "base");
    expect(base.amount).toBe(1900);

    // Usage IS shown, at zero — the invoice says what was consumed.
    const usageLines = inv.lineItems.filter((l) => l.lineType === "usage");
    expect(usageLines).toHaveLength(2);
    usageLines.forEach((l) => {
      expect(l.isIncluded).toBe(true);
      expect(l.amount).toBe(0);
      expect(l.description).toMatch(/included/);
    });
    expect(usageLines.find((l) => l.productCode === "id_doc_verification").quantity).toBe(430);

    // Allowance accounting is recorded on the invoice
    expect(inv.allowance.used).toBe(200); // DISTINCT applicants, not 818 events
    expect(inv.allowance.included).toBe(5000);
    expect(inv.allowance.overage).toBe(0);

    // and the usage records are stamped
    expect(res.body.meta.usageRecordsBilled).toBe(818);
  });

  it("bills applicants BEYOND the allowance at the overage price", async () => {
    // 12 distinct applicants against an allowance of 10 → 2 over @ A$0.68
    const smallPlan = await request(app)
      .post("/api/v1/billing-plan")
      .set("Authorization", dooit.auth)
      .send({
        name: "Tiny", code: "plan_tiny", basePrice: 100, includedUsage: 10,
        overagePrice: 0.68, visibility: "public",
        products: [{ productId: idDoc._id, enabled: true, unitPrice: 0.71 }],
      });
    await request(app)
      .post(`/api/v1/billing-plan/${smallPlan.body.data._id}/publish`)
      .set("Authorization", dooit.auth);

    const other = await makeUser({ userType: "client", email: "small@t.test" });
    const sub2 = await request(app)
      .post("/api/v1/subscription")
      .set("Authorization", other.auth)
      .send({ plan: smallPlan.body.data._id });

    const events = Array.from({ length: 12 }, (_, i) => ({
      subscription: sub2.body.data._id,
      productCode: "id_doc_verification",
      externalId: `tiny_${i}`,
      applicantKey: `applicant_${i}`,
      source: { system: "dooit" },
    }));
    await request(app)
      .post("/api/v1/usage/bulk")
      .set("Authorization", dooit.auth)
      .send({ events });

    const res = await request(app)
      .post("/api/v1/invoice/close")
      .set("Authorization", dooit.auth)
      .send({ subscription: sub2.body.data._id, periodKey: period });

    const inv = res.body.data;
    expect(inv.allowance.used).toBe(12);
    expect(inv.allowance.overage).toBe(2);

    const over = inv.lineItems.find((l) => l.lineType === "overage");
    expect(over.quantity).toBe(2);
    expect(over.amount).toBeCloseTo(1.36, 2); // 2 x 0.68
    expect(inv.total).toBeCloseTo(101.36, 2); // 100 base + 1.36
  });

  it("CHARGES usage of a product the plan does not entitle, at list price", async () => {
    // device_intelligence is A$0.0065 and is NOT entitled by the plan.
    await meter("device_intelligence", 5, "dev", { applicants: 5 });

    const res = await close();
    const inv = res.body.data;

    const line = inv.lineItems.find((l) => l.productCode === "device_intelligence");
    expect(line).toBeDefined();
    expect(line.quantity).toBe(5);
    // Flagged so the document can say the charge fell outside the plan.
    expect(line.isExcluded).toBe(true);
    expect(line.isIncluded).toBe(false);
    expect(line.amount).toBeCloseTo(0.03, 2); // 5 x 0.0065, rounded at the line
    expect(inv.total).toBeCloseTo(1900.03, 2);
  });

  it("does not let unentitled usage consume the applicant allowance", async () => {
    // Those 5 applicants are already paying list price per event. Counting
    // them toward the included-applicant quota as well would bill them twice.
    await meter("device_intelligence", 5, "dev", { applicants: 5 });

    const inv = (await close()).body.data;
    expect(inv.allowance.used).toBe(0);
  });

  it("claims unentitled records, so a second close cannot re-bill them", async () => {
    await meter("device_intelligence", 5, "dev", { applicants: 5 });
    const first = await close();
    expect(first.status).toBe(201);

    const UsageRecord = require("../../models/UsageRecord");
    const stillUnbilled = await UsageRecord.countDocuments({
      productCode: "device_intelligence",
      invoice: null,
    });
    expect(stillUnbilled).toBe(0);

    // The exclusion reason survives billing — it is what durably marks the
    // record as having been outside the agreement.
    const billed = await UsageRecord.findOne({ productCode: "device_intelligence" });
    expect(billed.status).toBe("billed");
    expect(billed.exclusionReason).toMatch(/not entitled/i);
  });
});

describe("tier ladder pricing", () => {
  it("prices each band separately and rounds once", () => {
    const tiers = [
      { from: 0, to: 1000, unitPrice: 0.79 },
      { from: 1001, to: 10000, unitPrice: 0.71 },
    ];
    // 5,200 units: 1,000 @ 0.79 + 4,200 @ 0.71
    const { amount, bands } = priceThroughTiers(5200, tiers, 0.64);
    expect(bands).toHaveLength(2);
    expect(amount).toBeCloseTo(1000 * 0.79 + 4200 * 0.71, 6);
  });

  it("falls back to the flat price past the last band", () => {
    const tiers = [{ from: 0, to: 100, unitPrice: 1 }];
    const { amount } = priceThroughTiers(150, tiers, 0.5);
    expect(amount).toBeCloseTo(100 * 1 + 50 * 0.5, 6);
  });

  it("uses the flat price when there are no tiers", () => {
    const { amount } = priceThroughTiers(10, [], 0.68);
    expect(amount).toBeCloseTo(6.8, 6);
  });
});

describe("totals invariant", () => {
  it("rejects an invoice whose total does not foot", async () => {
    const Invoice = mongoose.model("Invoice");
    const bad = new Invoice({
      user: client.user._id,
      subscription: subId,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 86400000),
      periodKey: period,
      lineItems: [{ lineType: "base", description: "x", amount: 100 }],
      subtotal: 100,
      discount: 0,
      tax: 0,
      total: 999, // wrong
      amountPaid: 0,
      amountDue: 999,
    });
    await expect(bad.validate()).rejects.toThrow(/total 999/);
  });

  it("rejects a subtotal that disagrees with its own lines", async () => {
    const Invoice = mongoose.model("Invoice");
    const bad = new Invoice({
      user: client.user._id,
      subscription: subId,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 86400000),
      periodKey: period,
      lineItems: [{ lineType: "base", description: "x", amount: 100 }],
      subtotal: 250, // lines only add to 100
      discount: 0, tax: 0, total: 250, amountPaid: 0, amountDue: 250,
    });
    await expect(bad.validate()).rejects.toThrow(/does not equal the sum of its lines/);
  });

  it("computes tax on the subtotal", async () => {
    await meter("id_doc_verification", 3, "gst", { applicants: 3 });
    const res = await close({ taxRatePercent: 10 });
    const inv = res.body.data;
    expect(inv.tax).toBeCloseTo(190, 2); // 10% of 1900
    expect(inv.total).toBeCloseTo(2090, 2);
  });
});

describe("lifecycle", () => {
  it("close -> issue allocates a number and a due date", async () => {
    const closed = await close();
    expect(closed.body.data.status).toBe("draft");
    expect(closed.body.data.invoiceNumber).toBeUndefined();

    const issued = await request(app)
      .post(`/api/v1/invoice/${closed.body.data._id}/issue`)
      .set("Authorization", dooit.auth)
      .send({ dueDays: 14 });

    expect(issued.status).toBe(200);
    expect(issued.body.data.status).toBe("open");
    expect(issued.body.data.invoiceNumber).toMatch(/^INV-\d{4}-\d{4}$/);
    expect(issued.body.data.dueAt).toBeTruthy();
  });

  it("refuses to close the same period twice", async () => {
    await close();
    const again = await close();
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already invoiced/i);
  });

  it("voiding RELEASES its usage so the period can be re-invoiced", async () => {
    await meter("id_doc_verification", 4, "rel", { applicants: 4 });
    const closed = await close();
    expect(closed.body.meta.usageRecordsBilled).toBe(4);

    const voided = await request(app)
      .post(`/api/v1/invoice/${closed.body.data._id}/void`)
      .set("Authorization", dooit.auth)
      .send({ reason: "Wrong period" });

    expect(voided.status).toBe(200);
    expect(voided.body.meta.usageReleased).toBe(4);

    // the same period can now be closed again — usage was not lost
    const reclosed = await close();
    expect(reclosed.status).toBe(201);
    expect(reclosed.body.meta.usageRecordsBilled).toBe(4);
  });

  it("an issued invoice is immutable", async () => {
    const Invoice = mongoose.model("Invoice");
    const closed = await close();
    await request(app)
      .post(`/api/v1/invoice/${closed.body.data._id}/issue`)
      .set("Authorization", dooit.auth);

    // NB: mutate a field that still passes the totals invariant — changing
    // subtotal trips validation first and never reaches the immutability guard.
    const doc = await Invoice.findById(closed.body.data._id);
    doc.periodKey = "1999-01";
    await expect(doc.save()).rejects.toThrow(/immutable/i);
  });

  it("refuses to void a paid invoice", async () => {
    const closed = await close();
    await request(app)
      .post(`/api/v1/invoice/${closed.body.data._id}/issue`)
      .set("Authorization", dooit.auth);
    await request(app)
      .post(`/api/v1/invoice/${closed.body.data._id}/mark-paid`)
      .set("Authorization", dooit.auth);

    const res = await request(app)
      .post(`/api/v1/invoice/${closed.body.data._id}/void`)
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/refund/i);
  });

  it("sweeps open invoices past due into overdue", async () => {
    const closed = await close();
    await request(app)
      .post(`/api/v1/invoice/${closed.body.data._id}/issue`)
      .set("Authorization", dooit.auth)
      .send({ dueDays: -1 }); // already due

    const swept = await request(app)
      .post("/api/v1/invoice/sweep-overdue")
      .set("Authorization", dooit.auth);
    expect(swept.body.data.markedOverdue).toBe(1);
  });
});

describe("access", () => {
  it("a client can read its own invoices but not close a period", async () => {
    await close();

    const read = await request(app)
      .get("/api/v1/invoice")
      .set("Authorization", client.auth);
    expect(read.status).toBe(200);
    expect(read.body.data).toHaveLength(1);

    const write = await request(app)
      .post("/api/v1/invoice/close")
      .set("Authorization", client.auth)
      .send({ subscription: subId, periodKey: period });
    expect(write.status).toBe(403);
  });

  it("preview writes nothing", async () => {
    await meter("id_doc_verification", 2, "prev", { applicants: 2 });
    const res = await request(app)
      .get(`/api/v1/invoice/preview?subscription=${subId}&periodKey=${period}`)
      .set("Authorization", client.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1900);
    expect(res.body.meta.persisted).toBe(false);

    const list = await request(app)
      .get("/api/v1/invoice")
      .set("Authorization", dooit.auth);
    expect(list.body.data).toHaveLength(0); // nothing persisted
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("emailing an invoice", () => {
  const sendEmail = require("../../utils/sendEmail");
  const { renderInvoiceHtml } = require("../../services/billing/invoiceDocument");

  const issued = async () => {
    await meter("id_doc_verification", 10, "cust", { applicants: 10 });
    const closed = await close();
    const inv = closed.body.data;
    await request(app)
      .post(`/api/v1/invoice/${inv._id}/issue`)
      .set("Authorization", dooit.auth)
      .send({ dueDays: 14 });
    return inv._id;
  };

  const send = (id, body = {}, auth = dooit.auth) =>
    request(app).post(`/api/v1/invoice/${id}/send`).set("Authorization", auth).send(body);

  beforeEach(() => {
    process.env.SMTP_EMAIL = "billing@dooit.test";
    process.env.FROM_NAME = "dooit.ai";
    jest.clearAllMocks();
  });

  it("sends an issued invoice and records the delivery", async () => {
    const id = await issued();
    const res = await send(id);

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const sent = sendEmail.mock.calls[0][0];
    expect(sent.email).toBe("sarah@coinflip.test");
    expect(sent.subject).toMatch(/^Invoice INV-\d{4}-\d{4}/);
    expect(sent.message).toContain("Amount due");

    // The delivery is recorded on the invoice, masked.
    expect(res.body.data.sentAt).toBeTruthy();
    expect(res.body.data.sentCount).toBe(1);
    expect(res.body.data.lastSentTo).toBe("s****@coinflip.test");
    expect(res.body.meta.resend).toBe(false);
  });

  it("never returns the plaintext address to the operator", async () => {
    const id = await issued();
    const res = await send(id);

    expect(res.body.meta.sentTo).toBe("s****@coinflip.test");
    expect(JSON.stringify(res.body)).not.toContain("sarah@coinflip.test");
  });

  it("counts a resend rather than overwriting the first send", async () => {
    const id = await issued();
    await send(id);
    const again = await send(id);

    expect(again.status).toBe(200);
    expect(again.body.data.sentCount).toBe(2);
    expect(again.body.meta.resend).toBe(true);
  });

  it("delivers to an override address without changing who is billed", async () => {
    const id = await issued();
    const res = await send(id, { to: "ap@coinflip.test" });

    expect(res.status).toBe(200);
    expect(sendEmail.mock.calls[0][0].email).toBe("ap@coinflip.test");
    // The invoice still belongs to the account it bills.
    expect(String(res.body.data.user)).toBe(String(client.user._id));
  });

  it("rejects a malformed override address", async () => {
    const id = await issued();
    const res = await send(id, { to: "not-an-email" });

    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses to send a DRAFT — it has no number yet", async () => {
    await meter("id_doc_verification", 5, "cust", { applicants: 5 });
    const draft = (await close()).body.data;

    const res = await send(draft._id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/issue the invoice before sending/i);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses to send a VOID invoice", async () => {
    const id = await issued();
    await request(app)
      .post(`/api/v1/invoice/${id}/void`)
      .set("Authorization", dooit.auth)
      .send({ reason: "test" });

    const res = await send(id);
    expect(res.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not mark the invoice sent when delivery fails", async () => {
    const id = await issued();
    sendEmail.mockRejectedValueOnce(new Error("SMTP refused"));

    const res = await send(id);
    expect(res.status).toBe(502);

    // The record must not claim the customer was invoiced.
    const after = await request(app)
      .get(`/api/v1/invoice/${id}`)
      .set("Authorization", dooit.auth);
    expect(after.body.data.sentAt).toBeNull();
    expect(after.body.data.sentCount).toBe(0);
  });

  it("503s when SMTP is not configured, rather than silently doing nothing", async () => {
    const id = await issued();
    delete process.env.SMTP_EMAIL;

    const res = await send(id);
    expect(res.status).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("is dooit-only — a client cannot email itself an invoice", async () => {
    const id = await issued();
    const res = await send(id, {}, client.auth);

    expect(res.status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("renders the real figures, and shows included usage as Included", async () => {
    const id = await issued();
    await send(id);

    const html = sendEmail.mock.calls[0][0].message;
    expect(html).toContain("$1,900.00"); // base fee
    expect(html).toContain("Included"); // entitled usage, at zero
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
  });

  it("escapes markup so a plan name cannot inject into the email", () => {
    const html = renderInvoiceHtml(
      {
        invoiceNumber: "INV-2026-0001",
        periodKey: "2026-07",
        currency: "AUD",
        status: "open",
        lineItems: [
          { lineType: "base", description: "<script>alert(1)</script>", amount: "10.00" },
        ],
        subtotal: "10.00",
        total: "10.00",
        amountPaid: "0",
        amountDue: "10.00",
      },
      { accountName: "<img onerror=x>" }
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img onerror=x>");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("overdue reminders (dunning)", () => {
  const sendEmail = require("../../utils/sendEmail");
  const { nextStageFor, dunningSchedule } = require("../../services/billing/invoiceDunning");

  /** Issue an invoice, send it, then drag its due date `days` into the past. */
  const overdueInvoice = async (days, over = {}) => {
    await meter("id_doc_verification", 5, "cust", { applicants: 5 });
    const inv = (await close()).body.data;
    await request(app)
      .post(`/api/v1/invoice/${inv._id}/issue`)
      .set("Authorization", dooit.auth)
      .send({ dueDays: 14 });
    await request(app)
      .post(`/api/v1/invoice/${inv._id}/send`)
      .set("Authorization", dooit.auth)
      .send({});

    await Invoice.updateOne(
      { _id: inv._id },
      {
        $set: {
          dueAt: new Date(Date.now() - days * 86400000),
          status: "overdue",
          ...over,
        },
      }
    );

    // Setting the invoice up SENDS it, which is itself a sendEmail call. Clear
    // it here so each test's call-count assertions describe the dunning sweep
    // alone rather than the fixture.
    jest.clearAllMocks();
    return inv._id;
  };

  beforeEach(() => {
    process.env.SMTP_EMAIL = "billing@dooit.test";
    delete process.env.BILLING_DUNNING_ENABLED;
    delete process.env.BILLING_DUNNING_SCHEDULE;
    jest.clearAllMocks();
  });

  it("does not chase an invoice that is not yet due", async () => {
    await overdueInvoice(-3); // due in 3 days
    const stats = await sweepDunning();

    expect(stats.reminded).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends the first reminder once the invoice is a day past due", async () => {
    const id = await overdueInvoice(1);
    const stats = await sweepDunning();

    expect(stats.reminded).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const mail = sendEmail.mock.calls[0][0];
    expect(mail.subject).toMatch(/Reminder: invoice INV-\d{4}-\d{4} is overdue/);
    expect(mail.message).toContain("Payment reminder");
    // The reminder carries the invoice itself, not just a nag.
    expect(mail.message).toContain("Amount due");

    const after = await Invoice.findById(id);
    expect(after.dunning.lastStageDays).toBe(1);
    expect(after.dunning.reminderCount).toBe(1);
  });

  it("does NOT re-send the same stage on the next hourly sweep", async () => {
    await overdueInvoice(1);
    await sweepDunning();
    jest.clearAllMocks();

    const again = await sweepDunning();
    expect(again.reminded).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends the next stage when the invoice reaches it", async () => {
    const id = await overdueInvoice(1);
    await sweepDunning();

    // Now 7 days past due — the second step on the default ladder.
    await Invoice.updateOne(
      { _id: id },
      { $set: { dueAt: new Date(Date.now() - 7 * 86400000) } }
    );
    jest.clearAllMocks();

    const stats = await sweepDunning();
    expect(stats.reminded).toBe(1);

    const after = await Invoice.findById(id);
    expect(after.dunning.lastStageDays).toBe(7);
    expect(after.dunning.reminderCount).toBe(2);
  });

  it("catches up an outage with ONE email, not the whole ladder", async () => {
    // 40 days past due with nothing ever sent — every step has been passed.
    const id = await overdueInvoice(40);
    const stats = await sweepDunning();

    expect(stats.reminded).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // It jumps to the LAST step reached rather than replaying 1, 7, 14, 30.
    const after = await Invoice.findById(id);
    expect(after.dunning.lastStageDays).toBe(30);
    expect(after.dunning.reminderCount).toBe(1);
  });

  it("never chases an invoice the customer was never sent", async () => {
    await meter("id_doc_verification", 5, "cust", { applicants: 5 });
    const inv = (await close()).body.data;
    await request(app)
      .post(`/api/v1/invoice/${inv._id}/issue`)
      .set("Authorization", dooit.auth)
      .send({ dueDays: 14 });
    // Issued but NEVER sent, then overdue.
    await Invoice.updateOne(
      { _id: inv._id },
      { $set: { dueAt: new Date(Date.now() - 30 * 86400000), status: "overdue" } }
    );

    const stats = await sweepDunning();
    expect(stats.scanned).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("stops chasing once the balance is settled", async () => {
    const id = await overdueInvoice(10);
    await Invoice.updateOne({ _id: id }, { $set: { amountDue: 0 } });

    const stats = await sweepDunning();
    expect(stats.reminded).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("still chases a PARTIALLY paid invoice", async () => {
    const id = await overdueInvoice(10);
    await Invoice.updateOne({ _id: id }, { $set: { amountPaid: 1, amountDue: 1899 } });

    const stats = await sweepDunning();
    expect(stats.reminded).toBe(1);
  });

  it("does not record a stage when delivery fails, so the next sweep retries", async () => {
    const id = await overdueInvoice(1);
    sendEmail.mockRejectedValueOnce(new Error("SMTP refused"));

    const failedRun = await sweepDunning();
    expect(failedRun.failed).toBe(1);
    expect(failedRun.reminded).toBe(0);
    expect((await Invoice.findById(id)).dunning.lastStageDays).toBeNull();

    // Next sweep succeeds and the stage is finally recorded.
    const retry = await sweepDunning();
    expect(retry.reminded).toBe(1);
    expect((await Invoice.findById(id)).dunning.lastStageDays).toBe(1);
  });

  it("can be switched off entirely", async () => {
    process.env.BILLING_DUNNING_ENABLED = "false";
    await overdueInvoice(30);

    const stats = await sweepDunning();
    expect(stats.disabled).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when SMTP is not configured", async () => {
    delete process.env.SMTP_EMAIL;
    const stats = await sweepDunning();

    expect(stats.mailNotConfigured).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("honours a custom schedule and ignores junk entries", () => {
    process.env.BILLING_DUNNING_SCHEDULE = "3, 10, oops, -5, 10";
    expect(dunningSchedule()).toEqual([3, 10]);

    process.env.BILLING_DUNNING_SCHEDULE = "nonsense";
    expect(dunningSchedule()).toEqual([1, 7, 14, 30]); // falls back, never empty
  });

  it("picks the right stage for a given age", () => {
    const at = (days, lastStageDays = null) =>
      nextStageFor(
        { dueAt: new Date(Date.now() - days * 86400000), dunning: { lastStageDays } },
        new Date()
      );

    expect(at(0)).toBeNull(); // due today, not yet late
    expect(at(1)).toBe(1);
    expect(at(6, 1)).toBeNull(); // between steps
    expect(at(7, 1)).toBe(7);
    expect(at(100, 30)).toBeNull(); // ladder exhausted — stop chasing
  });
});
