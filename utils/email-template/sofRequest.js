"use strict";

/**
 * SOF (Source of Funds) upload request email.
 *
 *   sofRequestHtml({ clientName, clientLogoUrl, customerName, uploadLink })
 *
 * Sent to a customer with a no-login upload link (?cid=<customerId>). The header
 * carries the Dooit logo co-branded with the requesting client, since the request
 * comes from that organisation but is served on the Dooit platform.
 *
 * Uses the shared cross-client branding in ./emailBranding — table-based and
 * fully inline-styled so it survives Gmail/Outlook stripping <style>.
 *
 * Cross-client rules this file follows:
 *   - Vertical rhythm comes from spacer <tr>s and <td> padding, never from
 *     margins between blocks — Word/Outlook collapses or inflates those.
 *   - Panels are <table>s, not styled <div>s (Word ignores padding + width on
 *     block divs, so div panels lose their inset and stretch).
 *   - Colours are solid hex; Word does not understand rgba().
 *   - The CTA ships a VML roundrect for Outlook alongside the HTML button.
 *
 * Note: the upload link is keyed on the customer id and never expires (see
 * models/SofVerification.js), so this email must not promise an expiry.
 */

const {
  FONT,
  esc,
  brandHeader,
  brandFooter,
  shell,
} = require("./emailBranding");

const firstNameOf = (name) => {
  const first = name ? String(name).trim().split(/\s+/)[0] : "";
  return first && first.toLowerCase() !== "customer" ? first : "";
};

// The four document types the upload page accepts (kept in step with
// SofVerification.DOC_TYPES and SofUploadClient's DOC_TYPE_OPTIONS).
const ACCEPTED_DOCS = [
  ["Bank statement", "Showing the salary or deposits into your account"],
  ["Payslip", "A recent payslip issued by your employer"],
  ["Bank cheque", "A cheque drawn in your name"],
  ["Bank certificate", "A statement of funds issued and stamped by your bank"],
];

const CHECKLIST = [
  "Your full name is clearly visible on the document",
  "Dated within the last three months",
  "The whole page is captured &mdash; no cropped corners or glare",
  "PDF, JPG, PNG or WEBP",
];

// ── Inline-styled building blocks ────────────────────────────────────────────

/** Vertical space as a real table row, which every client honours. */
const spacer = (h) =>
  `<tr><td height="${h}" style="height:${h}px;line-height:${h}px;font-size:0;mso-line-height-rule:exactly">&nbsp;</td></tr>`;

const text = (html, extra = "") =>
  `<p style="margin:0;font-size:15px;line-height:1.7;mso-line-height-rule:exactly;color:#475569;font-family:${FONT};${extra}">${html}</p>`;

/** Boxed section. A table so Word keeps the padding and the 100% width. */
const panel = (inner, { bg = "#f8fafc", border = "#e2e8f0" } = {}) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border:1px solid ${border};border-radius:12px">
    <tr><td style="padding:18px 22px">${inner}</td></tr>
  </table>`;

const eyebrow = (label) =>
  `<p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8;font-family:${FONT}">${label}</p>`;

// Bullet is a text character, not a background-filled span — Word drops the
// background on inline elements and the dot would vanish entirely.
const docRow = ([label, hint]) => `
    <tr>
      <td width="18" style="width:18px;padding:9px 10px 9px 0;vertical-align:top;font-size:15px;line-height:1.5;mso-line-height-rule:exactly;color:#2563eb;font-family:${FONT}">&bull;</td>
      <td style="padding:9px 0;font-family:${FONT}">
        <span style="display:block;font-size:14px;font-weight:700;color:#0f172a;line-height:1.4;mso-line-height-rule:exactly">${label}</span>
        <span style="display:block;font-size:13px;color:#64748b;line-height:1.5;mso-line-height-rule:exactly;padding-top:2px">${hint}</span>
      </td>
    </tr>`;

const checkRow = (label) => `
    <tr>
      <td width="20" style="width:20px;padding:7px 12px 7px 0;vertical-align:top;font-size:13px;font-weight:700;line-height:1.6;mso-line-height-rule:exactly;color:#2563eb;font-family:${FONT}">&#10003;</td>
      <td style="padding:7px 0;font-size:14px;line-height:1.6;mso-line-height-rule:exactly;color:#334155;font-family:${FONT}">${label}</td>
    </tr>`;

/**
 * CTA. Outlook (Word) ignores padding on <a> and border-radius outright, so it
 * gets a VML roundrect of the same size; every other client gets the gradient
 * table button, which stretches full width on narrow screens via .cta-btn.
 */
const ctaButton = (href, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto">
    <tr>
      <td align="center">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:280px" arcsize="16%" stroke="f" fillcolor="#2563eb">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold">${label}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center" bgcolor="#2563eb" style="border-radius:8px;background:#2563eb;background-image:linear-gradient(135deg,#2563eb,#1d4ed8)">
              <a href="${href}" class="cta-btn" style="display:inline-block;padding:15px 42px;font-size:16px;font-weight:600;letter-spacing:-.1px;line-height:20px;mso-line-height-rule:exactly;color:#ffffff;font-family:${FONT};border-radius:8px">${label}</a>
            </td>
          </tr>
        </table>
        <!--<![endif]-->
      </td>
    </tr>
  </table>`;

/**
 * @param {object}  opts
 * @param {string}  opts.clientName     Requesting organisation (co-brand + copy).
 * @param {string}  opts.clientLogoUrl  Optional hosted client logo.
 * @param {string}  opts.customerName   Customer's full name, for the greeting.
 * @param {string}  opts.uploadLink     No-login upload URL.
 */
function sofRequestHtml(opts = {}, legacyUploadLink) {
  // Legacy positional form: sofRequestHtml(clientName, uploadLink).
  const {
    clientName = "",
    clientLogoUrl = "",
    customerName = "",
    uploadLink = "#",
  } =
    typeof opts === "string"
      ? { clientName: opts, uploadLink: legacyUploadLink }
      : opts;

  const org = clientName ? esc(clientName) : "";
  const orgOrUs = org || "our compliance team";
  const coBrand = clientName ? { name: clientName, logoUrl: clientLogoUrl } : null;
  const first = firstNameOf(customerName);
  const link = uploadLink || "#";

  const body = `
      <tr>
        <td class="px" style="padding:36px 40px 34px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

            <tr><td style="font-size:17px;line-height:1.5;mso-line-height-rule:exactly;color:#1e293b;font-family:${FONT}">Hi${
              first ? ` <strong>${esc(first)}</strong>` : ""
            },</td></tr>
            ${spacer(16)}

            <tr><td>${text(
              `As part of ${
                org ? `<strong>${org}</strong>'s` : "our"
              } customer due diligence obligations, we need to verify your
              <strong>source of funds</strong>. This is a standard anti-money-laundering requirement and
              applies to every customer &mdash; it is not a reflection on your account.`
            )}</td></tr>
            ${spacer(18)}

            <tr><td>${text(
              `Uploading takes about a minute from your phone or computer. <strong>No account or password
              is needed</strong> &mdash; the button below opens a secure page linked to your record.`
            )}</td></tr>
            ${spacer(28)}

            <tr><td align="center">${ctaButton(
              link,
              "Upload My Document &rarr;"
            )}</td></tr>
            ${spacer(12)}
            <tr><td align="center" style="font-size:12px;line-height:1.6;mso-line-height-rule:exactly;color:#94a3b8;font-family:${FONT}">
              You can also scan the QR code provided by ${orgOrUs} to open the same page.
            </td></tr>
            ${spacer(28)}

            <tr><td>${panel(
              eyebrow("Please send any one of these") +
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${ACCEPTED_DOCS.map(
                  docRow
                ).join("")}</table>`
            )}</td></tr>
            ${spacer(20)}

            <tr><td>${panel(
              eyebrow("Before you upload") +
                text(
                  `Documents that meet these are usually verified straight away &mdash; anything unclear has
                  to be reviewed manually, which takes longer.`,
                  "font-size:14px;margin:0 0 8px"
                ) +
                `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${CHECKLIST.map(
                  checkRow
                ).join("")}</table>`,
              { bg: "#ffffff", border: "#e8edf3" }
            )}</td></tr>
            ${spacer(20)}

            <tr><td>${panel(
              `<p style="margin:0 0 6px;font-size:12px;line-height:1.6;mso-line-height-rule:exactly;color:#64748b;font-family:${FONT}">Button not working? Copy and paste this link into your browser:</p>
               <a href="${link}" style="color:#2563eb;font-size:12px;line-height:1.6;word-break:break-all;font-family:${FONT}">${link}</a>`
            )}</td></tr>
            ${spacer(20)}

            <tr><td>${panel(
              `<p style="margin:0;font-size:13px;line-height:1.6;mso-line-height-rule:exactly;color:#991b1b;font-family:${FONT}">
                 &#128274; Your document is encrypted in transit and held only for verification and
                 record-keeping. ${
                   org ? `${org} and Dooit` : "We"
                 } will never ask you for your password, PIN or full card number by
                 email. If you were not expecting this request, please contact ${orgOrUs} before uploading
                 anything.
               </p>`,
              { bg: "#fef2f2", border: "#fecaca" }
            )}</td></tr>
            ${spacer(26)}

            <tr><td style="border-top:1px solid #eef2f7;padding-top:20px;font-size:15px;line-height:1.8;mso-line-height-rule:exactly;color:#475569;font-family:${FONT}">
              Thank you for your help,<br/>
              <strong style="color:#0f172a">${
                org ? `The ${org} Compliance Team` : "The Compliance Team"
              }</strong>
            </td></tr>

          </table>
        </td>
      </tr>`;

  return shell({
    title: org
      ? `Source of Funds verification — ${clientName}`
      : "Source of Funds verification",
    preview: `${
      org ? `${clientName} needs` : "We need"
    } one document confirming your source of funds — it takes about a minute, no login required.`,
    cardRows:
      brandHeader({
        icon: "&#128196;", // page facing up
        title: "Source of Funds Verification",
        subtitle: org
          ? `A document request from ${org}`
          : "A document is needed to complete your review",
        coBrand,
      }) +
      body +
      brandFooter(
        "You received this email because a source of funds document was requested for your customer record."
      ),
  });
}

module.exports = sofRequestHtml;
module.exports.sofRequestHtml = sofRequestHtml;
