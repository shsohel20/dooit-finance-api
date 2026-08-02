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

// Brand colours extracted from dooit_Invoice.html
//   Page background : #f2f2f3
//   Card background : #ffffff
//   Brand accent    : #5980a6  (logo suffix ".ai", blue rule, borders)
//   Dark text       : #1d1f20 / #1d2d3d
//   Muted text      : #999    / #d4d4d7
//   Totals box fill : #eef6ff (border: #5980a6)
//   Outside-plan    : #b45309 (amber, unchanged from original)
//   Included line   : #5980a6 (was teal; now brand blue)

/**
 * Render the invoice.
 *
 * @param {Object} invoice   an Invoice document or lean object
 * @param {Object} opts      { accountName, accountEmail, brandName }
 * @returns {String} a self-contained HTML document
 */
function renderInvoiceHtml(
  invoice,
  {
    accountName,
    brandName = "Dooit.ai",
    brandLogoUrl = "https://dooit.ai/assets/img/logo.png",
  } = {}
) {
  const currency = invoice.currency || "AUD";
  const lines = [...(invoice.lineItems || [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  );

  const allowance = invoice.allowance || {};
  const isPaid = invoice.status === "paid";
  const isVoid = invoice.status === "void";

  // Header brand mark. A hosted <img> is used when brandLogoUrl is set;
  // brandName is kept as the img alt text so image-blocking email clients
  // (Gmail/Outlook default to blocking remote images) still show the name.
  // When no URL is given we fall back to the styled wordmark: brand name
  // split at the last "." so "dooit.ai" renders dark "dooit" + blue ".ai".
  const dotIdx = brandName.lastIndexOf(".");
  const brandBase   = dotIdx > 0 ? brandName.slice(0, dotIdx) : brandName;
  const brandSuffix = dotIdx > 0 ? brandName.slice(dotIdx)    : "";

  const brandMark = brandLogoUrl
    ? `<img src="${esc(brandLogoUrl)}" alt="${esc(brandName)}"
         height="36"
         style="height:36px;width:auto;max-width:200px;display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic">`
    : `<div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:36px;color:#1d1f20;letter-spacing:-.5px;line-height:1">
         ${esc(brandBase)}<span style="color:#5980a6">${esc(brandSuffix)}</span>
       </div>`;

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
        ? `<span style="color:#5980a6;font-weight:700">Included</span>`
        : money(l.amount, currency);
      return `
        <tr>
          <td style="padding:11px 14px;border-bottom:1px solid #e8e9eb;vertical-align:top">
            <div style="font-size:13px;color:#1d1f20;font-weight:600;line-height:1.3">${esc(l.description)}</div>
            <div style="font-size:11px;color:#999;margin-top:2px;letter-spacing:.2px">
              ${esc(LINE_LABELS[l.lineType] || l.lineType)}${
                l.isExcluded
                  ? ` &nbsp;<span style="color:#b45309;font-weight:700;font-size:10px;` +
                    `background:#fef3c7;padding:1px 5px;border-radius:3px">OUTSIDE PLAN</span>`
                  : ""
              }
            </div>
          </td>
          <td style="padding:11px 14px;border-bottom:1px solid #e8e9eb;text-align:right;font-size:13px;color:#4a515b;white-space:nowrap;vertical-align:top">
            ${l.quantity == null ? "—" : Number(l.quantity).toLocaleString("en-AU")}
          </td>
          <td style="padding:11px 14px;border-bottom:1px solid #e8e9eb;text-align:right;font-size:13px;color:#4a515b;white-space:nowrap;vertical-align:top">
            ${l.unitPrice == null ? "—" : money(l.unitPrice, currency)}
          </td>
          <td style="padding:11px 14px;border-bottom:1px solid #e8e9eb;text-align:right;font-size:13px;color:#1d2d3d;font-weight:700;white-space:nowrap;vertical-align:top">
            ${amount}
          </td>
        </tr>`;
    })
    .join("");

  const allowanceBlock =
    allowance.included == null && !allowance.used
      ? ""
      : `
      <div style="margin-top:16px;padding:13px 16px;background:#f2f2f3;border-radius:8px;border-left:3px solid #5980a6">
        <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#999;margin-bottom:5px">
          Allowance this period
        </div>
        <div style="font-size:13px;color:#1d2d3d">
          <strong style="color:#1d1f20">${Number(allowance.used || 0).toLocaleString("en-AU")}</strong>
          ${esc(allowance.unit || "applicant")}s used
          ${
            allowance.included == null
              ? " — <em>unlimited</em>"
              : ` of <strong>${Number(allowance.included).toLocaleString("en-AU")}</strong> included`
          }
          ${
            allowance.overage
              ? ` · <strong style="color:#b45309">${Number(allowance.overage).toLocaleString("en-AU")} over</strong>`
              : ""
          }
        </div>
      </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(invoice.invoiceNumber || "Invoice")}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:32px 16px;background:#f2f2f3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:12px;box-shadow:0 2px 16px rgba(29,31,32,.08);overflow:hidden">

    <!-- ── Header ── -->
    <div style="padding:28px 32px 0">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="vertical-align:top">
            ${brandMark}
            <div style="font-size:11px;color:#999;margin-top:8px;letter-spacing:.3px">AML/CTF compliance platform</div>
          </td>
          <td style="vertical-align:top;text-align:right">
            <div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:26px;color:#1d1f20;letter-spacing:-.3px;line-height:1">
              ${esc(invoice.invoiceNumber || "Draft invoice")}
            </div>
            <div style="font-size:11px;color:#999;margin-top:4px">Period ${esc(invoice.periodKey || "")}</div>
            ${
              isVoid
                ? `<div style="margin-top:6px;display:inline-block;padding:3px 10px;border-radius:4px;background:#d4d4d720;color:#999;font-size:11px;font-weight:700;letter-spacing:.5px;border:1px solid #d4d4d7">VOID</div>`
                : isPaid
                  ? `<div style="margin-top:6px;display:inline-block;padding:3px 10px;border-radius:4px;background:#eef6ff;color:#5980a6;font-size:11px;font-weight:700;letter-spacing:.5px;border:1px solid #5980a6">PAID</div>`
                  : ""
            }
          </td>
        </tr>
      </table>
    </div>

    <!-- ── Brand-blue rule (matches thumbnail) ── -->
    <div style="height:3px;background:#5980a6;margin:20px 32px 0;border-radius:2px"></div>

    <!-- ── Billed-to / Dates ── -->
    <div style="padding:20px 32px 0">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="vertical-align:top;font-size:12.5px;color:#4a515b">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#999;margin-bottom:6px">Billed to</div>
            <div style="font-size:14px;font-weight:700;color:#1d1f20">${esc(accountName || "—")}</div>
            <div style="font-size:12px;color:#4a515b;margin-top:2px">
              ${esc(invoice.planSnapshot?.planName || "")}${
                invoice.planSnapshot?.planVersion ? ` v${invoice.planSnapshot.planVersion}` : ""
              }
            </div>
          </td>
          <td style="vertical-align:top;text-align:right;font-size:12.5px;color:#4a515b">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#999;margin-bottom:6px">Dates</div>
            <div>Service period: ${fmtDate(invoice.periodStart)} – ${fmtDate(invoice.periodEnd)}</div>
            <div style="margin-top:2px">Issued: ${fmtDate(invoice.issuedAt)}</div>
            <div style="margin-top:2px">Due: <strong style="color:#1d1f20">${fmtDate(invoice.dueAt)}</strong></div>
          </td>
        </tr>
      </table>
    </div>

    <!-- ── Line items ── -->
    <div style="padding:20px 32px 0">
      ${allowanceBlock}
      <table style="width:100%;border-collapse:collapse;margin-top:${allowanceBlock ? "16px" : "0"}">
        <thead>
          <tr style="background:#f2f2f3">
            <th style="padding:8px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#999;border-radius:6px 0 0 6px">Description</th>
            <th style="padding:8px 14px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#999">Qty</th>
            <th style="padding:8px 14px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#999">Unit price</th>
            <th style="padding:8px 14px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#999;border-radius:0 6px 6px 0">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <!-- ── Totals (brand-blue box: #eef6ff fill, #5980a6 border) ── -->
    <table style="width:100%;border-collapse:collapse;padding:20px 32px 0;margin-top:20px">
      <tr><td></td><td style="width:260px;padding:0 32px 0 0">
      <div style="background:#eef6ff;border:1.5px solid #5980a6;border-radius:8px;padding:16px 20px;min-width:240px">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:5px 0;font-size:12.5px;color:#4a515b">Subtotal</td>
            <td style="padding:5px 0;text-align:right;font-size:12.5px;color:#1d2d3d">${money(invoice.subtotal, currency)}</td>
          </tr>
          ${
            toNumber(invoice.discount) > 0
              ? `<tr>
                  <td style="padding:5px 0;font-size:12.5px;color:#4a515b">Discount${
                    invoice.discountApplied?.type === "percentage"
                      ? ` (${invoice.discountApplied.value}%)`
                      : ""
                  }</td>
                  <td style="padding:5px 0;text-align:right;font-size:12.5px;color:#5980a6;font-weight:600">−${money(invoice.discount, currency)}</td>
                </tr>`
              : ""
          }
          ${
            toNumber(invoice.tax) > 0
              ? `<tr>
                  <td style="padding:5px 0;font-size:12.5px;color:#4a515b">GST (${invoice.taxRatePercent || 0}%)</td>
                  <td style="padding:5px 0;text-align:right;font-size:12.5px;color:#1d2d3d">${money(invoice.tax, currency)}</td>
                </tr>`
              : ""
          }
          <tr>
            <td style="padding:10px 0 5px;border-top:1.5px solid #5980a680;font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;color:#1d2d3d">Total</td>
            <td style="padding:10px 0 5px;border-top:1.5px solid #5980a680;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;color:#1d2d3d">${money(invoice.total, currency)}</td>
          </tr>
          ${
            toNumber(invoice.amountPaid) > 0
              ? `<tr>
                  <td style="padding:4px 0;font-size:12.5px;color:#4a515b">Amount paid</td>
                  <td style="padding:4px 0;text-align:right;font-size:12.5px;color:#5980a6;font-weight:600">−${money(invoice.amountPaid, currency)}</td>
                </tr>`
              : ""
          }
          <tr>
            <td style="padding:4px 0;font-size:14px;font-weight:700;color:#1d1f20">Amount due</td>
            <td style="padding:4px 0;text-align:right;font-size:14px;font-weight:700;color:${
              toNumber(invoice.amountDue) > 0 ? "#b45309" : "#5980a6"
            }">${money(invoice.amountDue, currency)}</td>
          </tr>
        </table>
      </div>
      </td></tr>
    </table>

    <!-- ── Notes ── -->
    ${
      invoice.notes
        ? `<div style="padding:18px 32px 0;font-size:12px;color:#4a515b;white-space:pre-wrap;line-height:1.6">${esc(invoice.notes)}</div>`
        : ""
    }

    <!-- ── Footer ── -->
    <div style="margin:18px 32px 0;padding:14px 0;border-top:1px solid #e8e9eb;font-size:10.5px;color:#999;padding-bottom:28px">
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