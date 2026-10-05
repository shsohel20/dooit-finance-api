"use strict";

// Pure mapping functions: Dooit documents -> Xero payloads (and back for the
// few inbound fields we accept). No I/O here, so they are trivially testable.

const { toNumber } = require("../../utils/money");
const { getConfig } = require("../../config/xero");

const MASKED = "***";

/** Treat masked / ciphertext-looking values as absent. */
const clean = (v) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s || s === MASKED) return undefined;
  if (s.split(":").length === 3 && s.split(":")[0].length === 32) return undefined; // ciphertext
  return s;
};

const compact = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));

const toIsoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

const addressBlock = (type, a = {}) => {
  const block = compact({
    AddressType: type,
    AddressLine1: clean(a.street || a.address),
    City: clean(a.city || a.suburb),
    Region: clean(a.state),
    PostalCode: clean(a.zipcode || a.postcode),
    Country: clean(a.country),
  });
  return Object.keys(block).length > 1 ? block : null;
};

/** Customer (individual KYC record) -> Xero Contact. Returns null if unnameable. */
const customerToContact = (customer) => {
  const form = customer?.personalKyc?.personal_form || {};
  const d = form.customer_details || {};
  const name = [clean(d.given_name), clean(d.middle_name), clean(d.surname)].filter(Boolean).join(" ");
  if (!name) return null;

  const addr = addressBlock("STREET", form.residential_address);
  const phone = clean(form.contact_details?.phone);
  return compact({
    Name: name,
    FirstName: clean(d.given_name),
    LastName: clean(d.surname),
    EmailAddress: clean(form.contact_details?.email),
    Addresses: addr ? [addr] : undefined,
    Phones: phone ? [{ PhoneType: "DEFAULT", PhoneNumber: phone }] : undefined,
    // Dooit id stays discoverable from the Xero side without being the dedupe key.
    AccountNumber: `DOOIT-C-${String(customer._id).slice(-8).toUpperCase()}`,
  });
};

/** Company (Client) -> Xero Contact. */
const companyToContact = (client) => {
  const name = clean(client?.name);
  if (!name) return null;
  const addr = addressBlock("STREET", client.address);
  const phone = clean(client.phone);
  return compact({
    Name: name,
    EmailAddress: clean(client.email),
    Addresses: addr ? [addr] : undefined,
    Phones: phone ? [{ PhoneType: "DEFAULT", PhoneNumber: phone }] : undefined,
    TaxNumber: clean(client.taxId),
    Website: clean(client.website),
    AccountNumber: `DOOIT-K-${String(client._id).slice(-8).toUpperCase()}`,
  });
};

const INVOICE_STATUS_MAP = {
  draft: "DRAFT",
  open: "AUTHORISED",
  overdue: "AUTHORISED",
  paid: "AUTHORISED", // becomes PAID in Xero once its payment is applied
  void: "VOIDED",
};

/**
 * Dooit Invoice -> Xero ACCREC invoice.
 *
 * Lines are sent with LineAmountTypes "NoTax": Dooit has already computed
 * discount and tax as their own lines, and letting Xero re-derive tax would
 * make the totals disagree with the issued invoice.
 */
const invoiceToXero = (invoice, contactId) => {
  const cfg = getConfig();
  const lines = (invoice.lineItems || []).map((l) => {
    const amount = toNumber(l.amount);
    const qty = l.quantity;
    const unit = l.unitPrice == null ? null : toNumber(l.unitPrice);
    const exact =
      qty > 0 && unit != null && Math.abs(+(qty * unit).toFixed(2) - amount) < 0.005;
    return {
      Description: l.description,
      Quantity: exact ? qty : 1,
      UnitAmount: exact ? unit : amount,
      AccountCode: cfg.salesAccountCode,
      TaxType: "NONE",
    };
  });

  return compact({
    Type: "ACCREC",
    Contact: { ContactID: contactId },
    LineItems: lines,
    LineAmountTypes: "NoTax",
    Date: toIsoDate(invoice.issuedAt || invoice.createdAt || invoice.periodEnd),
    DueDate: toIsoDate(invoice.dueAt),
    Reference: invoice.invoiceNumber || undefined,
    InvoiceNumber: invoice.invoiceNumber || undefined,
    CurrencyCode: invoice.currency || "AUD",
    Status: INVOICE_STATUS_MAP[invoice.status] || "DRAFT",
  });
};

/**
 * Dooit Payment -> Xero Payment. Returns null for anything Xero models
 * differently (refunds are credit notes) or cannot accept (no bank account).
 */
const paymentToXero = (payment, xeroInvoiceId) => {
  const cfg = getConfig();
  if (payment.type !== "payment" || payment.status !== "paid") return null;
  if (!cfg.paymentAccountCode) return null;
  return compact({
    Invoice: { InvoiceID: xeroInvoiceId },
    Account: { Code: cfg.paymentAccountCode },
    Amount: toNumber(payment.amount),
    Date: toIsoDate(payment.paidAt || payment.createdAt),
    Reference: payment.uid || payment.transactionId || undefined,
  });
};

/** The subset of a Xero Contact Dooit will accept inbound. */
const xeroContactToLocal = (contact) =>
  compact({
    name: clean(contact?.Name),
    email: clean(contact?.EmailAddress)?.toLowerCase(),
    phone: clean((contact?.Phones || []).find((p) => p.PhoneNumber)?.PhoneNumber),
  });

/** Xero returns .NET dates as "/Date(1700000000000+0000)/" in some payloads. */
const parseXeroDate = (v) => {
  if (!v) return null;
  const m = /\/Date\((\d+)/.exec(v);
  const d = m ? new Date(Number(m[1])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Xero Organisation (+ the signed-in Xero user) -> pre-filled Dooit client form.
 * Only fills what Xero actually knows; `clientType` is left for the user, as it
 * is a regulated-sector choice Xero has no equivalent of.
 */
const organisationToClientPrefill = (org = {}, identity = {}) => {
  const addresses = org.Addresses || [];
  const a = addresses.find((x) => x.AddressType === "STREET") || addresses.find((x) => x.AddressType === "POBOX") || {};
  const street = [a.AddressLine1, a.AddressLine2, a.AddressLine3, a.AddressLine4].map(clean).filter(Boolean).join(", ");

  const ph = (org.Phones || []).find((p) => p.PhoneNumber && ["DEFAULT", "OFFICE"].includes(p.PhoneType)) || (org.Phones || []).find((p) => p.PhoneNumber);
  const phone = ph ? [ph.PhoneCountryCode && `+${ph.PhoneCountryCode}`, ph.PhoneAreaCode, ph.PhoneNumber].filter(Boolean).join(" ") : undefined;

  const site = (org.ExternalLinks || []).find((l) => l.LinkType === "Website" && l.Url)?.Url;
  const fullName = [identity.givenName, identity.familyName].filter(Boolean).join(" ");

  return compact({
    name: clean(org.LegalName) || clean(org.Name),
    tradingName: clean(org.Name),
    registrationNumber: clean(org.RegistrationNumber),
    taxId: clean(org.TaxNumber),
    email: clean(identity.email)?.toLowerCase(),
    phone,
    website: clean(site),
    address: compact({
      street: clean(street),
      city: clean(a.City),
      state: clean(a.Region),
      zipcode: clean(a.PostalCode),
      country: clean(a.Country) || clean(org.CountryCode),
    }),
    legalRepresentative: compact({
      name: clean(fullName),
      email: clean(identity.email)?.toLowerCase(),
    }),
    xeroOrganisationType: clean(org.OrganisationType),
  });
};

module.exports = {
  organisationToClientPrefill,
  customerToContact,
  companyToContact,
  invoiceToXero,
  paymentToXero,
  xeroContactToLocal,
  parseXeroDate,
  INVOICE_STATUS_MAP,
};
