require("./setup");
const { makeStore } = require("./fakes");

const mockLinks = makeStore([["tenantId", "entityType", "localId"], ["tenantId", "entityType", "xeroId"]]);
jest.mock("../../models/XeroEntityLink", () => ({
  findOne: (f) => mockLinks.findOne(f),
  findOneAndUpdate: (f, u, o) => mockLinks.findOneAndUpdate(f, u, o),
  updateOne: (f, u) => mockLinks.updateOne(f, u),
}));
jest.mock("../../models/XeroConnection", () => ({}));
jest.mock("../../models/Client", () => ({ findById: jest.fn(() => ({ lean: async () => null })), updateOne: jest.fn() }));
jest.mock("../../models/Customer", () => ({}));
jest.mock("../../models/Invoice", () => ({}));
jest.mock("../../models/Payment", () => ({}));
jest.mock("../../services/billing/paymentService", () => ({ reconcileInvoice: jest.fn() }));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn(), hashPayload: jest.requireActual("../../services/xero/syncLog").hashPayload }));
jest.mock("../../services/xero/client", () => ({
  createContact: jest.fn(), updateContact: jest.fn(), getContacts: jest.fn(),
  createInvoice: jest.fn(), updateInvoice: jest.fn(), createPayment: jest.fn(),
}));

const xero = require("../../services/xero/client");
const sync = require("../../services/xero/syncService");
const { hashPayload } = require("../../services/xero/syncLog");

const conn = { tenantId: "t1", companyId: "co1" };
const payload = { Name: "Acme" };

beforeEach(() => { mockLinks.reset(); jest.clearAllMocks(); });

describe("contact sync — duplicate prevention", () => {
  it("creates once, then skips an unchanged contact without any API call", async () => {
    xero.createContact.mockResolvedValue({ ContactID: "X1", UpdatedDateUTC: "2026-01-01T00:00:00Z" });
    expect(await sync.pushContact(conn, "company", "L1", payload)).toMatchObject({ action: "created", xeroId: "X1" });
    expect(await sync.pushContact(conn, "company", "L1", payload)).toMatchObject({ action: "skipped", xeroId: "X1" });
    expect(xero.createContact).toHaveBeenCalledTimes(1);
    expect(mockLinks.rows).toHaveLength(1);
    expect(mockLinks.rows[0].payloadHash).toBe(hashPayload(payload));
  });

  it("updates (never re-creates) when the mapped payload changed", async () => {
    xero.createContact.mockResolvedValue({ ContactID: "X1" });
    xero.updateContact.mockResolvedValue({ ContactID: "X1" });
    await sync.pushContact(conn, "company", "L1", payload);
    const r = await sync.pushContact(conn, "company", "L1", { Name: "Acme 2" });
    expect(r.action).toBe("updated");
    expect(xero.createContact).toHaveBeenCalledTimes(1);
    expect(xero.updateContact).toHaveBeenCalledWith(conn, "X1", { Name: "Acme 2" });
  });

  it("adopts the existing Xero contact on a duplicate-name error instead of failing", async () => {
    xero.createContact.mockRejectedValue(Object.assign(new Error("dup"), { code: "DUPLICATE_CONTACT" }));
    xero.getContacts.mockResolvedValue([{ ContactID: "EXISTING" }]);
    xero.updateContact.mockResolvedValue({ ContactID: "EXISTING" });
    const r = await sync.pushContact(conn, "customer", "L2", payload);
    expect(r).toMatchObject({ action: "updated", xeroId: "EXISTING" });
    expect(mockLinks.rows[0]).toMatchObject({ xeroId: "EXISTING", entityType: "customer" });
  });

  it("records a failure (and no link) for other errors", async () => {
    xero.createContact.mockRejectedValue(new Error("boom"));
    expect(await sync.pushContact(conn, "company", "L3", payload)).toMatchObject({ action: "failed" });
    expect(mockLinks.rows).toHaveLength(0);
  });

  it("skips entities that cannot be mapped", async () => {
    expect((await sync.pushContact(conn, "customer", "L4", null)).action).toBe("skipped");
    expect(xero.createContact).not.toHaveBeenCalled();
  });

  it("the unique index turns a racing second link into the winner's row", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "company", localId: "L9", xeroId: "WIN" });
    await expect(mockLinks.create({ tenantId: "t1", entityType: "company", localId: "L9", xeroId: "LOSE" })).rejects.toMatchObject({ code: 11000 });
  });
});

describe("payment sync", () => {
  it("does not push a payment twice, nor echo a Xero-originated payment", async () => {
    await mockLinks.create({ tenantId: "t1", entityType: "invoice", localId: "I1", xeroId: "XI1" });
    xero.createPayment.mockResolvedValue({ PaymentID: "XP1", Invoice: { Status: "PAID" } });
    const p = { _id: "P1", invoice: "I1", type: "payment", status: "paid", amount: 10 };
    expect((await sync.pushPayment(conn, p)).action).toBe("created");
    expect((await sync.pushPayment(conn, p)).action).toBe("skipped");
    expect((await sync.pushPayment(conn, { ...p, _id: "P2", gateway: "xero" })).action).toBe("skipped");
    expect(xero.createPayment).toHaveBeenCalledTimes(1);
  });

  it("skips (with a log) when the invoice is not yet in Xero", async () => {
    const r = await sync.pushPayment(conn, { _id: "P3", invoice: "NOPE", type: "payment", status: "paid", amount: 5 });
    expect(r.action).toBe("skipped");
    expect(xero.createPayment).not.toHaveBeenCalled();
  });
});

describe("invoice sync", () => {
  it("never sends draft invoices", async () => {
    expect((await sync.pushInvoice(conn, { _id: "I9", status: "draft" })).action).toBe("skipped");
    expect(xero.createInvoice).not.toHaveBeenCalled();
  });
});
