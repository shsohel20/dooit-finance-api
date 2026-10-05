require("./setup");
const mongoose = require("mongoose");
const m = require("../../services/xero/mappers");
const { toDecimal } = require("../../utils/money");

const oid = () => new mongoose.Types.ObjectId();

describe("Customer -> Contact", () => {
  const customer = {
    _id: oid(),
    personalKyc: { personal_form: {
      customer_details: { given_name: "Jane", surname: "Citizen" },
      contact_details: { email: "jane@example.com", phone: "0400 000 000" },
      residential_address: { address: "1 Main St", suburb: "Sydney", state: "NSW", postcode: "2000", country: "AU" },
    } },
  };

  it("maps name, email, phone and address", () => {
    const c = m.customerToContact(customer);
    expect(c).toMatchObject({
      Name: "Jane Citizen", FirstName: "Jane", LastName: "Citizen", EmailAddress: "jane@example.com",
      Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "0400 000 000" }],
      Addresses: [{ AddressType: "STREET", AddressLine1: "1 Main St", City: "Sydney", Region: "NSW", PostalCode: "2000", Country: "AU" }],
    });
    expect(c.AccountNumber).toMatch(/^DOOIT-C-/);
  });

  it("never sends masked or ciphertext PII to Xero", () => {
    const enc = `${"a".repeat(32)}:${"b".repeat(32)}:cafe`;
    const c = m.customerToContact({ _id: oid(), personalKyc: { personal_form: {
      customer_details: { given_name: "Jane", surname: "***" },
      contact_details: { email: enc, phone: "***" },
    } } });
    expect(c.Name).toBe("Jane");
    expect(c.EmailAddress).toBeUndefined();
    expect(c.Phones).toBeUndefined();
  });

  it("returns null when there is no usable name", () => {
    expect(m.customerToContact({ _id: oid(), personalKyc: {} })).toBeNull();
  });
});

describe("Company -> Contact", () => {
  it("maps the client record", () => {
    const c = m.companyToContact({ _id: oid(), name: "Acme Pty Ltd", email: "a@acme.com", phone: "02", taxId: "ABN1", address: { street: "5 Way", city: "Perth" } });
    expect(c).toMatchObject({ Name: "Acme Pty Ltd", EmailAddress: "a@acme.com", TaxNumber: "ABN1" });
    expect(c.Addresses[0]).toMatchObject({ AddressLine1: "5 Way", City: "Perth" });
  });
});

describe("Invoice -> Invoice", () => {
  const invoice = (over = {}) => ({
    invoiceNumber: "INV-2026-0001", status: "open", currency: "AUD",
    issuedAt: new Date("2026-03-01T10:00:00Z"), dueAt: new Date("2026-03-15T10:00:00Z"),
    lineItems: [
      { description: "Platform fee", quantity: 1, unitPrice: toDecimal(100), amount: toDecimal(100), lineType: "base" },
      { description: "ID checks", quantity: 10, unitPrice: toDecimal(2.5), amount: toDecimal(25), lineType: "usage" },
      { description: "Loyalty discount", amount: toDecimal(-12.5), lineType: "discount" },
      { description: "GST", amount: toDecimal(11.25), lineType: "tax" },
    ],
    ...over,
  });

  it("maps amount, due date, status and reference", () => {
    const x = m.invoiceToXero(invoice(), "contact-1");
    expect(x).toMatchObject({
      Type: "ACCREC", Contact: { ContactID: "contact-1" }, Reference: "INV-2026-0001",
      Date: "2026-03-01", DueDate: "2026-03-15", Status: "AUTHORISED", CurrencyCode: "AUD", LineAmountTypes: "NoTax",
    });
  });

  it("keeps the Xero total identical to the Dooit total", () => {
    const x = m.invoiceToXero(invoice(), "c");
    const sum = x.LineItems.reduce((s, l) => s + l.Quantity * l.UnitAmount, 0);
    expect(+sum.toFixed(2)).toBe(123.75); // 100 + 25 - 12.5 + 11.25
    expect(x.LineItems[1]).toMatchObject({ Quantity: 10, UnitAmount: 2.5 });
  });

  it.each([["draft", "DRAFT"], ["open", "AUTHORISED"], ["overdue", "AUTHORISED"], ["paid", "AUTHORISED"], ["void", "VOIDED"]])(
    "status %s -> %s", (from, to) => expect(m.invoiceToXero(invoice({ status: from }), "c").Status).toBe(to)
  );
});

describe("Payment -> Payment", () => {
  const pay = (over = {}) => ({ type: "payment", status: "paid", amount: toDecimal(50), uid: "PAY-0000001", paidAt: new Date("2026-03-02T00:00:00Z"), ...over });

  it("maps a settled payment", () => {
    expect(m.paymentToXero(pay(), "inv-1")).toEqual({
      Invoice: { InvoiceID: "inv-1" }, Account: { Code: "090" }, Amount: 50, Date: "2026-03-02", Reference: "PAY-0000001",
    });
  });
  it("skips refunds and unsettled payments", () => {
    expect(m.paymentToXero(pay({ type: "refund" }), "i")).toBeNull();
    expect(m.paymentToXero(pay({ status: "pending" }), "i")).toBeNull();
  });
});

describe("inbound helpers", () => {
  it("extracts accepted contact fields", () => {
    expect(m.xeroContactToLocal({ Name: "New Name", EmailAddress: "X@Y.com", Phones: [{ PhoneNumber: "" }, { PhoneNumber: "123" }] }))
      .toEqual({ name: "New Name", email: "x@y.com", phone: "123" });
  });
  it("parses .NET and ISO dates", () => {
    expect(m.parseXeroDate("/Date(1700000000000+0000)/").getTime()).toBe(1700000000000);
    expect(m.parseXeroDate("2026-01-01T00:00:00Z")).toBeInstanceOf(Date);
    expect(m.parseXeroDate(null)).toBeNull();
  });
});
