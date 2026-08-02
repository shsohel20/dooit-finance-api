"use strict";

// services/billing/invoiceDocument.js
//
// Render an invoice as HTML, and that same HTML as a PDF.
//
// ONE renderer, deliberately. The emailed body and the attached PDF are the
// same document, so a customer querying a charge and the operator looking at
// the attachment are always reading identical numbers. Two templates would
// eventually disagree about a total, and an invoice that contradicts its own
// attachment is not recoverable by explanation.
//
// Everything rendered comes from the invoice's OWN line items — the schema
// stores each line's description, quantity and unit price precisely so the
// document reproduces years later without loading the plan, the product
// catalogue or the subscription (Invoice.js:12). Nothing here joins.

const { launchPdfBrowser } = require("../../utils/puppeteerLaunch");
const { toNumber } = require("../../utils/money");

const money = (v, currency = "AUD") =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(toNumber(v));

const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-AU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

// User-supplied text (plan names, line descriptions, notes) is interpolated
// into HTML that is emailed and rendered by Chrome. Escape it.
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const LINE_LABELS = {
  base: "Subscription",
  usage: "Usage",
  overage: "Overage",
  adjustment: "Adjustment",
  discount: "Discount",
  tax: "Tax",
};

/**
 * Render the invoice.
 *
 * @param {Object} invoice   an Invoice document or lean object
 * @param {Object} opts      { accountName, accountEmail, brandName }
 * @returns {String} a self-contained HTML document
 */
function renderInvoiceHtml(invoice, { accountName, brandName = "Dooit.ai" } = {}) {
  const currency = invoice.currency || "AUD";
  const lines = [...(invoice.lineItems || [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  );

  const allowance = invoice.allowance || {};
  const isPaid = invoice.status === "paid";
  const isVoid = invoice.status === "void";

  const rows = lines
    // `discount` and `tax` are totals-block concepts. They are still line items
    // so the invoice reconciles against its own lines, but rendering them here
    // as well would show each of them twice.
    .filter((l) => !["discount", "tax"].includes(l.lineType))
    .map((l) => {
      // Included lines are shown at zero on purpose (Model B): the invoice must
      // say what was consumed even when the base fee already paid for it.
      // Excluded lines carry a real amount and are flagged in the sub-label
      // below, so a customer can see which charges fell outside their plan.
      const amount = l.isIncluded
        ? `<span style="color:#0e766a;font-weight:700">Included</span>`
        : money(l.amount, currency);
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #eef0f3">
            <div style="font-size:13px;color:#25292f;font-weight:600">${esc(l.description)}</div>
            <div style="font-size:11px;color:#98a0ab;margin-top:2px">
              ${esc(LINE_LABELS[l.lineType] || l.lineType)}${
                l.isExcluded
                  ? ` · <span style="color:#b45309;font-weight:700">outside your plan</span>`
                  : ""
              }
            </div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;text-align:right;font-size:13px;color:#6b7280">
            ${l.quantity == null ? "—" : Number(l.quantity).toLocaleString("en-AU")}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;text-align:right;font-size:13px;color:#6b7280">
            ${l.unitPrice == null ? "—" : money(l.unitPrice, currency)}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;text-align:right;font-size:13px;color:#12151a;font-weight:700">
            ${amount}
          </td>
        </tr>`;
    })
    .join("");

  const allowanceBlock =
    allowance.included == null && !allowance.used
      ? ""
      : `
      <div style="margin-top:18px;padding:12px 14px;background:#f7f8f9;border-radius:10px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#98a0ab">
          Allowance this period
        </div>
        <div style="font-size:12.5px;color:#4a515b;margin-top:5px">
          ${Number(allowance.used || 0).toLocaleString("en-AU")}
          ${esc(allowance.unit || "applicant")}s used
          ${
            allowance.included == null
              ? " · unlimited"
              : ` of ${Number(allowance.included).toLocaleString("en-AU")} included`
          }
          ${
            allowance.overage
              ? ` · <strong>${Number(allowance.overage).toLocaleString("en-AU")} over</strong>`
              : ""
          }
        </div>
      </div>`;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${esc(invoice.invoiceNumber || "Invoice")}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:660px;margin:0 auto">

    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
      <div>
        <div style="font-size:20px;font-weight:800;color:#12151a;letter-spacing:-.4px">${esc(brandName)}</div>
        <div style="font-size:12px;color:#8a919b;margin-top:2px">AML/CTF compliance platform</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:19px;font-weight:800;color:#12151a">
          ${esc(invoice.invoiceNumber || "Draft invoice")}
        </div>
        <div style="font-size:12px;color:#8a919b;margin-top:2px">Period ${esc(invoice.periodKey)}</div>
        ${
          isVoid
            ? `<div style="margin-top:6px;display:inline-block;padding:3px 9px;border-radius:999px;background:#64748b1a;color:#475569;font-size:11px;font-weight:800">VOID</div>`
            : isPaid
              ? `<div style="margin-top:6px;display:inline-block;padding:3px 9px;border-radius:999px;background:#10b9811a;color:#047857;font-size:11px;font-weight:800">PAID</div>`
              : ""
        }
      </div>
    </div>

    <div style="height:1px;background:#eef0f3;margin:18px 0"></div>

    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="vertical-align:top;font-size:12.5px;color:#4a515b">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#98a0ab;margin-bottom:4px">Billed to</div>
          <div style="font-weight:700;color:#25292f">${esc(accountName || "—")}</div>
          <div style="margin-top:2px">${esc(invoice.planSnapshot?.planName || "")}${
            invoice.planSnapshot?.planVersion ? ` v${invoice.planSnapshot.planVersion}` : ""
          }</div>
        </td>
        <td style="vertical-align:top;text-align:right;font-size:12.5px;color:#4a515b">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#98a0ab;margin-bottom:4px">Dates</div>
          <div>Service period: ${fmtDate(invoice.periodStart)} – ${fmtDate(invoice.periodEnd)}</div>
          <div style="margin-top:2px">Issued: ${fmtDate(invoice.issuedAt)}</div>
          <div style="margin-top:2px">Due: <strong>${fmtDate(invoice.dueAt)}</strong></div>
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:18px">
      <thead>
        <tr style="background:#f7f8f9">
          <th style="padding:8px 12px;text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#98a0ab">Description</th>
          <th style="padding:8px 12px;text-align:right;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#98a0ab">Qty</th>
          <th style="padding:8px 12px;text-align:right;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#98a0ab">Unit</th>
          <th style="padding:8px 12px;text-align:right;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#98a0ab">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    ${allowanceBlock}

    <table style="width:100%;border-collapse:collapse;margin-top:18px">
      <tr><td></td><td style="width:230px">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:4px 0;font-size:12.5px;color:#6b7280">Subtotal</td>
            <td style="padding:4px 0;text-align:right;font-size:12.5px;color:#25292f">${money(invoice.subtotal, currency)}</td>
          </tr>
          ${
            toNumber(invoice.discount) > 0
              ? `<tr><td style="padding:4px 0;font-size:12.5px;color:#6b7280">Discount${
                  invoice.discountApplied?.type === "percentage"
                    ? ` (${invoice.discountApplied.value}%)`
                    : ""
                }</td>
                 <td style="padding:4px 0;text-align:right;font-size:12.5px;color:#047857">−${money(invoice.discount, currency)}</td></tr>`
              : ""
          }
          ${
            toNumber(invoice.tax) > 0
              ? `<tr><td style="padding:4px 0;font-size:12.5px;color:#6b7280">Tax (${invoice.taxRatePercent || 0}%)</td>
                 <td style="padding:4px 0;text-align:right;font-size:12.5px;color:#25292f">${money(invoice.tax, currency)}</td></tr>`
              : ""
          }
          <tr>
            <td style="padding:8px 0 4px;border-top:1px solid #eef0f3;font-size:14px;font-weight:800;color:#12151a">Total</td>
            <td style="padding:8px 0 4px;border-top:1px solid #eef0f3;text-align:right;font-size:14px;font-weight:800;color:#12151a">${money(invoice.total, currency)}</td>
          </tr>
          ${
            toNumber(invoice.amountPaid) > 0
              ? `<tr><td style="padding:4px 0;font-size:12.5px;color:#6b7280">Paid</td>
                 <td style="padding:4px 0;text-align:right;font-size:12.5px;color:#047857">−${money(invoice.amountPaid, currency)}</td></tr>`
              : ""
          }
          <tr>
            <td style="padding:4px 0;font-size:13px;font-weight:800;color:#12151a">Amount due</td>
            <td style="padding:4px 0;text-align:right;font-size:13px;font-weight:800;color:${
              toNumber(invoice.amountDue) > 0 ? "#b45309" : "#047857"
            }">${money(invoice.amountDue, currency)}</td>
          </tr>
        </table>
      </td></tr>
    </table>

    ${
      invoice.notes
        ? `<div style="margin-top:18px;font-size:12px;color:#6b7280;white-space:pre-wrap">${esc(invoice.notes)}</div>`
        : ""
    }

    <div style="margin-top:22px;padding-top:12px;border-top:1px solid #eef0f3;font-size:11px;color:#98a0ab">
      ${esc(brandName)} · This invoice is generated from metered usage recorded against your subscription.
      Amounts are in ${esc(currency)}.
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render the same HTML to a PDF buffer.
 *
 * Callers should treat a failure here as non-fatal where possible — an invoice
 * email that arrives without its attachment is far better than one that never
 * arrives because Chrome would not start.
 */
async function renderInvoicePdf(html) {
  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });

    // Puppeteer 23+ returns a Uint8Array, not a Buffer. Express's res.send()
    // only recognises Buffer as binary — anything else that is an object gets
    // JSON-serialised, so an un-normalised return downloads as
    // `{"0":37,"1":80,...}` under a .pdf filename. It fails silently: the
    // response is a clean 200 and only opening the file reveals it.
    // Nodemailer has the same blind spot for attachment content.
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * True when a PDF failure is an environment problem rather than a problem with
 * this particular invoice.
 *
 * Worth separating because the two need opposite responses. A missing or
 * unstartable Chrome breaks EVERY invoice and is fixed on the host, not in the
 * data; reporting it as a plain 500 sends whoever is on call looking through
 * billing records for a fault that was never there.
 */
const isBrowserUnavailable = (err) =>
  /Could not find (Chrome|Chromium)|Failed to launch the browser process|ENOENT/i.test(
    err?.message || ""
  );

module.exports = { renderInvoiceHtml, renderInvoicePdf, isBrowserUnavailable };
