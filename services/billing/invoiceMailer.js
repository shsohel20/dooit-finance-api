"use strict";

// services/billing/invoiceMailer.js
//
// Deliver an invoice by email — the one place that actually sends one.
//
// Shared by the manual `POST /invoice/:id/send` and the automatic overdue
// reminders in invoiceDunning.js. Both put the same document in front of the
// same customer, so they must resolve the address, render the attachment and
// handle a failed send identically. A reminder that renders differently from
// the invoice it is chasing is worse than no reminder.

const { renderInvoiceHtml, renderInvoicePdf, billToFromClient } = require("./invoiceDocument");
const { resolveUserEmailById, maskEmail } = require("../../utils/resolveUserEmail");
const sendEmail = require("../../utils/sendEmail");
const Client = require("../../models/Client");

/** True when this deployment can send mail at all. */
const mailConfigured = () => !!process.env.SMTP_EMAIL;

/**
 * Render and send one invoice.
 *
 * Does NOT stamp anything on the invoice — the caller decides what a successful
 * delivery means (a first send, a resend, a dunning stage), and stamping here
 * would force one meaning on all three.
 *
 * @param {Object} invoice
 * @param {Object} opts
 *   to         override recipient; defaults to the account's address
 *   subject    email subject
 *   introHtml  optional banner rendered above the invoice (used by reminders)
 * @returns {{ to, maskedTo, pdfAttached }}
 * @throws when there is no address, or when the transport rejects the message
 */
async function deliverInvoiceEmail(invoice, { to = null, subject, introHtml = "" } = {}) {
  const account = await resolveUserEmailById(invoice.user);
  const recipient = to || account.email;

  if (!recipient) {
    const err = new Error(
      "This account has no usable email address on file — pass `to` to send it elsewhere"
    );
    err.statusCode = 422;
    throw err;
  }

  // Resolved by id rather than relying on the caller to have populated it —
  // deliverInvoiceEmail is shared by the manual send and the dunning sweep,
  // and both must render the same billTo regardless of what the caller's own
  // query happened to load.
  // invoice.client may arrive as a raw ObjectId or already populated,
  // depending on the caller's own query — normalise to an id either way.
  const clientId = invoice.client?._id || invoice.client;
  const client = clientId
    ? await Client.findById(clientId).select("name address registrationNumber").lean()
    : null;

  const html = renderInvoiceHtml(invoice, {
    accountName: account.name,
    billTo: billToFromClient(client),
  });

  // The PDF is best-effort. Chrome failing to start is an infrastructure
  // problem; it must not stop the customer receiving an invoice they can read
  // perfectly well in the email body.
  let attachments = [];
  let pdfAttached = true;
  try {
    const pdf = await renderInvoicePdf(html);
    attachments = [
      {
        filename: `${invoice.invoiceNumber || "invoice"}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      },
    ];
  } catch (err) {
    pdfAttached = false;
    console.error("[billing] invoice PDF render failed — sending without it:", err.message);
  }

  await sendEmail({
    email: recipient,
    subject,
    message: introHtml ? `${introHtml}${html}` : html,
    attachments,
  });

  return { to: recipient, maskedTo: maskEmail(recipient), pdfAttached };
}

module.exports = { deliverInvoiceEmail, mailConfigured };
