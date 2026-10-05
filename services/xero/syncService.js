"use strict";

// Sync engine. Idempotent by construction:
//   • XeroEntityLink maps every Dooit entity to its Xero id (unique indexes), so
//     a re-run updates instead of creating.
//   • A payload hash per link means an unchanged entity makes no API call.
//   • Duplicate-contact errors are resolved by adopting the existing Xero contact.

const mongoose = require("mongoose");
const XeroConnection = require("../../models/XeroConnection");
const XeroEntityLink = require("../../models/XeroEntityLink");
const Client = require("../../models/Client");
const Customer = require("../../models/Customer");
const Invoice = require("../../models/Invoice");
const Payment = require("../../models/Payment");
const { toDecimal } = require("../../utils/money");
const { reconcileInvoice } = require("../billing/paymentService");
const xero = require("./client");
const map = require("./mappers");
const { logSync, hashPayload } = require("./syncLog");

const STALE_RUN_MS = 30 * 60 * 1000;

const emptySummary = () => ({
  contacts: { created: 0, updated: 0, skipped: 0, failed: 0 },
  invoices: { created: 0, updated: 0, skipped: 0, failed: 0 },
  payments: { created: 0, updated: 0, skipped: 0, failed: 0 },
});

const getLink = (tenantId, entityType, localId) =>
  XeroEntityLink.findOne({ tenantId, entityType, localId: String(localId) });

/** Insert-or-adopt a link; a unique-index race resolves to the winner's row. */
const saveLink = async (conn, entityType, localId, fields) => {
  try {
    return await XeroEntityLink.findOneAndUpdate(
      { tenantId: conn.tenantId, entityType, localId: String(localId) },
      { $set: { companyId: conn.companyId, lastSyncedAt: new Date(), ...fields } },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code === 11000) return getLink(conn.tenantId, entityType, localId);
    throw err;
  }
};

const ctx = (conn) => ({ tenantId: conn.tenantId, companyId: conn.companyId });

// ── Contacts ─────────────────────────────────────────────────────────────────

/**
 * Push one contact. `entityType` is "customer" | "company".
 * @returns {Promise<{ action: string, xeroId?: string }>}
 */
const pushContact = async (conn, entityType, localId, payload) => {
  const bucket = entityType === "customer" ? "customer" : "company";
  if (!payload) {
    await logSync({ ...ctx(conn), entity: "contact", entityId: localId, action: "skip", direction: "outbound", status: "skipped", error: "no usable name" });
    return { action: "skipped" };
  }

  const hash = hashPayload(payload);
  const link = await getLink(conn.tenantId, bucket, localId);
  if (link && link.payloadHash === hash) return { action: "skipped", xeroId: link.xeroId };

  try {
    let contact;
    let action;
    if (link) {
      contact = await xero.updateContact(conn, link.xeroId, payload);
      action = "update";
    } else {
      try {
        contact = await xero.createContact(conn, payload);
        action = "create";
      } catch (err) {
        if (err.code !== "DUPLICATE_CONTACT") throw err;
        // Same name already exists in Xero — adopt it rather than fail or duplicate.
        const found = (await xero.getContacts(conn, { where: `Name=="${payload.Name.replace(/"/g, '\\"')}"` }))[0];
        if (!found) throw err;
        contact = await xero.updateContact(conn, found.ContactID, payload);
        action = "adopt";
      }
    }
    await saveLink(conn, bucket, localId, {
      xeroId: contact.ContactID,
      payloadHash: hash,
      remoteUpdatedAt: map.parseXeroDate(contact.UpdatedDateUTC),
    });
    await logSync({ ...ctx(conn), entity: "contact", entityId: localId, action, direction: "outbound", status: "success", payloadHash: hash });
    return { action: action === "adopt" ? "updated" : action === "create" ? "created" : "updated", xeroId: contact.ContactID };
  } catch (err) {
    await logSync({ ...ctx(conn), entity: "contact", entityId: localId, action: link ? "update" : "create", direction: "outbound", status: "failed", error: err.message, payloadHash: hash });
    return { action: "failed", error: err.message };
  }
};

// ── Invoices ─────────────────────────────────────────────────────────────────

const pushInvoice = async (conn, invoice) => {
  if (invoice.status === "draft") return { action: "skipped" }; // drafts are not billed yet

  // Invoices are issued to the company, which must exist as a Xero contact first.
  const company = await Client.findById(invoice.client).lean();
  let contactLink = invoice.client ? await getLink(conn.tenantId, "company", invoice.client) : null;
  if (!contactLink && company) {
    const r = await pushContact(conn, "company", company._id, map.companyToContact(company));
    if (r.xeroId) contactLink = { xeroId: r.xeroId };
  }
  if (!contactLink) {
    await logSync({ ...ctx(conn), entity: "invoice", entityId: invoice._id, action: "skip", direction: "outbound", status: "skipped", error: "no Xero contact for invoice company" });
    return { action: "skipped" };
  }

  const payload = map.invoiceToXero(invoice, contactLink.xeroId);
  const hash = hashPayload(payload);
  const link = await getLink(conn.tenantId, "invoice", invoice._id);
  if (link && link.payloadHash === hash) return { action: "skipped", xeroId: link.xeroId };

  try {
    let result;
    if (link) {
      // Xero locks authorised invoices that have payments; only status moves then.
      const body = link.remoteStatus === "PAID" ? { Status: payload.Status } : payload;
      result = await xero.updateInvoice(conn, link.xeroId, body);
    } else {
      result = await xero.createInvoice(conn, payload);
    }
    await saveLink(conn, "invoice", invoice._id, {
      xeroId: result.InvoiceID,
      payloadHash: hash,
      remoteStatus: result.Status,
      remoteUpdatedAt: map.parseXeroDate(result.UpdatedDateUTC),
    });
    await logSync({ ...ctx(conn), entity: "invoice", entityId: invoice._id, action: link ? "update" : "create", direction: "outbound", status: "success", payloadHash: hash });
    return { action: link ? "updated" : "created", xeroId: result.InvoiceID };
  } catch (err) {
    await logSync({ ...ctx(conn), entity: "invoice", entityId: invoice._id, action: link ? "update" : "create", direction: "outbound", status: "failed", error: err.message, payloadHash: hash });
    return { action: "failed", error: err.message };
  }
};

// ── Payments ─────────────────────────────────────────────────────────────────

const pushPayment = async (conn, payment) => {
  // Payments that originated in Xero must not be echoed back.
  if (payment.gateway === "xero") return { action: "skipped" };

  const existing = await getLink(conn.tenantId, "payment", payment._id);
  if (existing) return { action: "skipped", xeroId: existing.xeroId };

  const invLink = await getLink(conn.tenantId, "invoice", payment.invoice);
  const payload = invLink ? map.paymentToXero(payment, invLink.xeroId) : null;
  if (!payload) {
    await logSync({ ...ctx(conn), entity: "payment", entityId: payment._id, action: "skip", direction: "outbound", status: "skipped", error: invLink ? "not a settled payment or no XERO_PAYMENT_ACCOUNT_CODE" : "invoice not in Xero yet" });
    return { action: "skipped" };
  }

  const hash = hashPayload(payload);
  try {
    const result = await xero.createPayment(conn, payload);
    await saveLink(conn, "payment", payment._id, {
      xeroId: result.PaymentID,
      payloadHash: hash,
      remoteUpdatedAt: map.parseXeroDate(result.UpdatedDateUTC),
    });
    // Reflect the settled state on the Xero-side invoice link.
    await XeroEntityLink.updateOne(
      { tenantId: conn.tenantId, entityType: "invoice", localId: String(payment.invoice) },
      { $set: { remoteStatus: result.Invoice?.Status || invLink.remoteStatus } }
    );
    await logSync({ ...ctx(conn), entity: "payment", entityId: payment._id, action: "create", direction: "outbound", status: "success", payloadHash: hash });
    return { action: "created", xeroId: result.PaymentID };
  } catch (err) {
    await logSync({ ...ctx(conn), entity: "payment", entityId: payment._id, action: "create", direction: "outbound", status: "failed", error: err.message, payloadHash: hash });
    return { action: "failed", error: err.message };
  }
};

// ── Outbound ─────────────────────────────────────────────────────────────────

const tally = (bucket, r) => {
  const k = r.action === "created" ? "created" : r.action === "updated" ? "updated" : r.action === "failed" ? "failed" : "skipped";
  bucket[k] += 1;
};

/**
 * Push everything for the company that changed since `since` (all when null).
 * Order matters: contacts -> invoices -> payments, because each needs the
 * previous one's Xero id.
 */
const runOutbound = async (conn, { since = null, summary = emptySummary() } = {}) => {
  const touched = since ? { updatedAt: { $gte: since } } : {};

  const company = await Client.findById(conn.companyId).lean();
  if (company) tally(summary.contacts, await pushContact(conn, "company", company._id, map.companyToContact(company)));

  const customers = Customer.find({ "relations.client": conn.companyId, ...touched }).cursor();
  for await (const c of customers) {
    const plain = typeof c.decryptForRole === "function" ? c.decryptForRole() : c.toObject();
    tally(summary.contacts, await pushContact(conn, "customer", c._id, map.customerToContact(plain)));
  }

  const invoices = Invoice.find({ client: conn.companyId, ...touched }).cursor();
  for await (const inv of invoices) tally(summary.invoices, await pushInvoice(conn, inv));

  // Payments move independently of the invoice's own updatedAt — always scan the
  // company's settled payments; the link table makes the scan cheap and exact.
  const payments = Payment.find({ client: conn.companyId, type: "payment", status: "paid" }).cursor();
  for await (const p of payments) tally(summary.payments, await pushPayment(conn, p));

  return summary;
};

// ── Inbound ──────────────────────────────────────────────────────────────────

const looksEncrypted = (v) => typeof v === "string" && v.split(":").length === 3 && v.split(":")[0].length === 32;

/** Apply a Xero contact to the linked Dooit record. Last-writer-wins on UpdatedDateUTC. */
const applyInboundContact = async (conn, xeroContact) => {
  const link = await XeroEntityLink.findOne({
    tenantId: conn.tenantId,
    entityType: { $in: ["company", "customer"] },
    xeroId: xeroContact.ContactID,
  });
  if (!link) return { action: "skipped" }; // not a contact Dooit manages

  const remoteAt = map.parseXeroDate(xeroContact.UpdatedDateUTC);
  if (remoteAt && link.remoteUpdatedAt && remoteAt <= link.remoteUpdatedAt) return { action: "skipped" };

  const incoming = map.xeroContactToLocal(xeroContact);
  const outboundShape = link.entityType === "company" ? map.companyToContact : map.customerToContact;

  try {
    if (link.entityType === "company") {
      const set = {};
      ["name", "email", "phone"].forEach((k) => incoming[k] && (set[k] = incoming[k]));
      if (Object.keys(set).length) await Client.updateOne({ _id: link.localId }, { $set: set });
    } else {
      // Customer PII may be stored encrypted by the Privacy module — never
      // overwrite ciphertext with plaintext; only touch plaintext fields.
      const raw = await Customer.collection.findOne({ _id: new mongoose.Types.ObjectId(link.localId) });
      const base = "personalKyc.personal_form.contact_details";
      const set = {};
      if (incoming.email && !looksEncrypted(raw?.personalKyc?.personal_form?.contact_details?.email)) set[`${base}.email`] = incoming.email;
      if (incoming.phone && !looksEncrypted(raw?.personalKyc?.personal_form?.contact_details?.phone)) set[`${base}.phone`] = incoming.phone;
      if (Object.keys(set).length) await Customer.collection.updateOne({ _id: raw._id }, { $set: set });
    }
    // Re-baseline the hash so the next outbound pass does not bounce this edit back.
    const fresh = link.entityType === "company"
      ? await Client.findById(link.localId).lean()
      : await Customer.findById(link.localId);
    const payload = fresh ? outboundShape(fresh.toObject ? fresh.toObject() : fresh) : null;
    await XeroEntityLink.updateOne(
      { _id: link._id },
      { $set: { remoteUpdatedAt: remoteAt, lastSyncedAt: new Date(), ...(payload ? { payloadHash: hashPayload(payload) } : {}) } }
    );
    await logSync({ ...ctx(conn), entity: "contact", entityId: link.localId, action: "update", direction: "inbound", status: "success" });
    return { action: "updated" };
  } catch (err) {
    await logSync({ ...ctx(conn), entity: "contact", entityId: link.localId, action: "update", direction: "inbound", status: "failed", error: err.message });
    return { action: "failed" };
  }
};

/**
 * Record Xero payments against a linked Dooit invoice as Dooit Payment docs
 * (idempotent via the unique transactionId), then reconcile the invoice.
 */
const applyInboundPayments = async (conn, localInvoice, xeroInvoice) => {
  const out = { created: 0 };
  for (const xp of xeroInvoice.Payments || []) {
    if (xp.PaymentType && xp.PaymentType !== "ACCRECPAYMENT") continue;
    const known = await XeroEntityLink.findOne({ tenantId: conn.tenantId, entityType: "payment", xeroId: xp.PaymentID }).lean();
    if (known) continue; // already known — pushed by us or ingested before

    const transactionId = `xero:${xp.PaymentID}`;
    try {
      const doc = await Payment.create({
        user: localInvoice.user,
        client: localInvoice.client,
        invoice: localInvoice._id,
        type: "payment",
        amount: toDecimal(Number(xp.Amount || 0).toFixed(2)),
        currency: localInvoice.currency,
        method: "bank_transfer",
        methodLabel: "Xero",
        status: "paid",
        transactionId,
        gateway: "xero",
        paidAt: map.parseXeroDate(xp.Date) || new Date(),
      });
      await saveLink(conn, "payment", doc._id, { xeroId: xp.PaymentID, remoteUpdatedAt: map.parseXeroDate(xp.UpdatedDateUTC) });
      out.created += 1;
      await logSync({ ...ctx(conn), entity: "payment", entityId: doc._id, action: "create", direction: "inbound", status: "success" });
    } catch (err) {
      if (err.code === 11000 || /transactionId.*unique|to be unique/i.test(err.message)) continue; // replay
      await logSync({ ...ctx(conn), entity: "payment", entityId: xp.PaymentID, action: "create", direction: "inbound", status: "failed", error: err.message });
    }
  }
  if (out.created) {
    const inv = await Invoice.findById(localInvoice._id);
    if (inv && inv.status !== "void") await reconcileInvoice(inv);
  }
  return out;
};

/** Apply one Xero invoice (status + payments) to its linked Dooit invoice. */
const applyInboundInvoice = async (conn, xeroInvoice) => {
  const link = await XeroEntityLink.findOne({ tenantId: conn.tenantId, entityType: "invoice", xeroId: xeroInvoice.InvoiceID });
  if (!link) return { action: "skipped" }; // invoice not created from Dooit

  const local = await Invoice.findById(link.localId);
  if (!local) return { action: "skipped" };

  try {
    await applyInboundPayments(conn, local, xeroInvoice);

    // A void in Xero is surfaced, not applied: voiding a Dooit invoice releases
    // usage records and is a deliberate human action (see invoiceService).
    const note = xeroInvoice.Status === "VOIDED" && local.status !== "void" ? "voided in Xero — review in Dooit" : null;
    await XeroEntityLink.updateOne(
      { _id: link._id },
      { $set: { remoteStatus: xeroInvoice.Status, remoteUpdatedAt: map.parseXeroDate(xeroInvoice.UpdatedDateUTC), lastSyncedAt: new Date() } }
    );
    await logSync({ ...ctx(conn), entity: "invoice", entityId: local._id, action: "update", direction: "inbound", status: note ? "skipped" : "success", error: note });
    return { action: "updated" };
  } catch (err) {
    await logSync({ ...ctx(conn), entity: "invoice", entityId: local._id, action: "update", direction: "inbound", status: "failed", error: err.message });
    return { action: "failed" };
  }
};

/** Pull everything modified in Xero since `since` for linked entities. */
const runInbound = async (conn, { since = null, summary = emptySummary() } = {}) => {
  const linkedContacts = await XeroEntityLink.find({ tenantId: conn.tenantId, entityType: { $in: ["company", "customer"] } }).distinct("xeroId");
  if (linkedContacts.length) {
    for (let i = 0; i < linkedContacts.length; i += 40) {
      const batch = await xero.getContacts(conn, { ids: linkedContacts.slice(i, i + 40), modifiedSince: since });
      for (const c of batch) tally(summary.contacts, await applyInboundContact(conn, c));
    }
  }

  const linkedInvoices = await XeroEntityLink.find({ tenantId: conn.tenantId, entityType: "invoice" }).distinct("xeroId");
  for (let i = 0; i < linkedInvoices.length; i += 40) {
    const batch = await xero.getInvoices(conn, { ids: linkedInvoices.slice(i, i + 40), modifiedSince: since });
    for (const inv of batch) tally(summary.invoices, await applyInboundInvoice(conn, inv));
  }
  return summary;
};

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Full or incremental sync for a connection; records progress on the connection
 * so Settings can show running/last-sync/error state.
 */
const runSync = async (connectionId, { full = false } = {}) => {
  const claimed = await XeroConnection.findOneAndUpdate(
    {
      _id: connectionId,
      status: "connected",
      // A "running" flag older than the lock window belongs to a crashed worker.
      $or: [
        { lastSyncStatus: { $ne: "running" } },
        { updatedAt: { $lt: new Date(Date.now() - STALE_RUN_MS) } },
      ],
    },
    { $set: { lastSyncStatus: "running", lastSyncError: null } },
    { new: true }
  );
  if (!claimed) return { skipped: true };

  const started = new Date();
  const summary = emptySummary();
  try {
    const since = full ? null : claimed.outboundCursor;
    await runOutbound(claimed, { since, summary });
    await runInbound(claimed, { since: full ? null : claimed.inboundCursor, summary });

    const failed = Object.values(summary).reduce((n, b) => n + b.failed, 0);
    await XeroConnection.updateOne(
      { _id: claimed._id },
      {
        $set: {
          lastSyncAt: new Date(),
          lastSyncStatus: failed ? "partial" : "success",
          lastSyncError: failed ? `${failed} item(s) failed — see sync log` : null,
          lastSyncSummary: summary,
          outboundCursor: started,
          inboundCursor: started,
        },
      }
    );
    await logSync({ ...ctx(claimed), entity: "sync", action: full ? "full" : "incremental", direction: "system", status: failed ? "failed" : "success", error: failed ? `${failed} item(s) failed` : null });
    return { skipped: false, summary };
  } catch (err) {
    await XeroConnection.updateOne(
      { _id: claimed._id },
      { $set: { lastSyncStatus: "failed", lastSyncError: err.message.slice(0, 500), lastSyncSummary: summary } }
    );
    await logSync({ ...ctx(claimed), entity: "sync", action: full ? "full" : "incremental", status: "failed", error: err.message });
    throw err; // lets the job queue retry with back-off
  }
};

module.exports = {
  emptySummary,
  pushContact,
  pushInvoice,
  pushPayment,
  runOutbound,
  runInbound,
  runSync,
  applyInboundContact,
  applyInboundInvoice,
};
