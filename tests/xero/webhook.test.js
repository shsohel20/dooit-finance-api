require("./setup");
const crypto = require("crypto");
const request = require("supertest");
const express = require("express");

const mockLog = jest.fn();
const mockEnqueue = jest.fn();
const mockConn = { findOne: jest.fn() };
jest.mock("../../services/xero/syncLog", () => ({ logSync: (...a) => mockLog(...a), hashPayload: jest.fn() }));
jest.mock("../../services/xero/jobQueue", () => ({ enqueue: (...a) => mockEnqueue(...a) }));
jest.mock("../../models/XeroConnection", () => ({
  findOne: (...a) => { const p = Promise.resolve(mockConn.findOne(...a)); p.select = () => p; p.lean = () => p; return p; },
}));

const webhook = require("../../services/xero/webhook");
const errorHandler = require("../../middleware/error");
const routes = require("../../routes/xero");

const sign = (body, key = "test-webhook-key") => crypto.createHmac("sha256", key).update(body).digest("base64");
const app = express();
app.use("/xero", routes);
app.use(errorHandler);

const body = JSON.stringify({
  events: [
    { resourceId: "r1", eventCategory: "CONTACT", eventType: "UPDATE", tenantId: "t1", eventDateUtc: "2026-01-01T00:00:00" },
    { resourceId: "r2", eventCategory: "INVOICE", eventType: "UPDATE", tenantId: "t1", eventDateUtc: "2026-01-01T00:00:01" },
    { resourceId: "r3", eventCategory: "SUBSCRIPTION", eventType: "UPDATE", tenantId: "t1" },
  ],
  firstEventSequence: 1, lastEventSequence: 3,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockConn.findOne.mockReturnValue({ companyId: "co1" });
  mockEnqueue.mockResolvedValue({ job: {}, duplicate: false });
});

describe("signature verification", () => {
  it("accepts a correct signature", () => expect(webhook.verifySignature(Buffer.from(body), sign(body))).toBe(true));
  it("rejects a wrong key, tampered body, and missing header", () => {
    expect(webhook.verifySignature(Buffer.from(body), sign(body, "other"))).toBe(false);
    expect(webhook.verifySignature(Buffer.from(body + " "), sign(body))).toBe(false);
    expect(webhook.verifySignature(Buffer.from(body), undefined)).toBe(false);
    expect(webhook.verifySignature(Buffer.from(body), "short")).toBe(false);
  });
  it("rejects everything when no webhook key is configured", () => {
    expect(webhook.verifySignature(Buffer.from(body), sign(body), "")).toBe(false);
  });
});

describe("POST /xero/webhook", () => {
  it("returns 401 and queues nothing for an invalid signature", async () => {
    const res = await request(app).post("/xero/webhook").set("Content-Type", "application/json").set("x-xero-signature", "bad").send(body);
    expect(res.status).toBe(401);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ entity: "webhook", status: "failed" }));
  });

  it("returns 401 when the signature header is absent", async () => {
    const res = await request(app).post("/xero/webhook").set("Content-Type", "application/json").send(body);
    expect(res.status).toBe(401);
  });

  it("acks a valid delivery with an empty 200 and queues supported events only", async () => {
    const res = await request(app).post("/xero/webhook").set("Content-Type", "application/json").set("x-xero-signature", sign(body)).send(body);
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
    expect(mockEnqueue).toHaveBeenCalledTimes(2); // CONTACT + INVOICE, not SUBSCRIPTION
    expect(mockEnqueue.mock.calls[0][0]).toBe("inbound_event");
    expect(mockEnqueue.mock.calls[0][1]).toMatchObject({ tenantId: "t1", payload: { category: "CONTACT", resourceId: "r1" } });
  });

  it("acks Xero's empty 'intent to receive' payload", async () => {
    const empty = JSON.stringify({ events: [], firstEventSequence: 0, lastEventSequence: 0 });
    const res = await request(app).post("/xero/webhook").set("Content-Type", "application/json").set("x-xero-signature", sign(empty)).send(empty);
    expect(res.status).toBe(200);
  });

  it("ignores events for organisations that are not connected", async () => {
    mockConn.findOne.mockReturnValue(null);
    const out = await webhook.processPayload(JSON.parse(body));
    expect(out.queued).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("does not double-count a redelivered event", async () => {
    mockEnqueue.mockResolvedValue({ job: {}, duplicate: true });
    expect((await webhook.processPayload(JSON.parse(body))).queued).toBe(0);
  });
});
