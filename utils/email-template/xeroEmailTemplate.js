"use strict";

/**
 * Xero connection emails.
 *
 *   xeroConnectionApprovalHtml(...) — to the EXISTING client's registered
 *       address: "someone wants to connect this Xero organisation — approve?"
 *   xeroConnectionDecisionHtml(...) — to the requester: approved / rejected.
 *
 * Organisation and requester names come from Xero, i.e. from outside Dooit, so
 * every dynamic value is HTML-escaped before it reaches the markup. URLs are
 * built by the caller from server-side values and escaped here as attributes.
 */

const { FONT, brandHeader, brandFooter, shell } = require("./emailBranding");

const escapeHtml = (v = "") =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const p = (html, extra = "") =>
  `<p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#475569;font-family:${FONT};${extra}">${html}</p>`;

const detailRow = (label, value) => `
  <tr>
    <td style="padding:8px 0;width:38%;font-size:13px;color:#94a3b8;font-family:${FONT};vertical-align:top">${label}</td>
    <td style="padding:8px 0;font-size:14px;color:#1e293b;font-weight:600;font-family:${FONT};vertical-align:top">${value}</td>
  </tr>`;

const button = (href, label, { primary = true } = {}) => `
  <td align="center" ${primary ? 'bgcolor="#2563eb"' : ""} style="border-radius:8px;${
    primary ? "background:#2563eb" : "border:1px solid #cbd5e1;background:#ffffff"
  }">
    <a href="${escapeHtml(href)}" class="cta-btn" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:600;color:${
      primary ? "#ffffff" : "#334155"
    };font-family:${FONT};border-radius:8px">${label}</a>
  </td>`;

// ─────────────────────────────────────────────────────────────────────────────
// 1) Approval request → the existing client's registered address
// ─────────────────────────────────────────────────────────────────────────────
function xeroConnectionApprovalHtml({
  organisationName,
  requesterName,
  requesterEmail,
  approveUrl,
  rejectUrl,
  expiresInMinutes = 30,
} = {}) {
  const org = escapeHtml(organisationName || "your organisation");

  const body = `
      <tr>
        <td class="px" style="padding:36px 40px 32px">
          ${p(`A request was made to connect the Xero organisation <strong>${org}</strong> to your Dooit account.`)}

          <div style="background:#f8fafc;border:1px solid #e8edf3;border-radius:12px;padding:10px 22px;margin:4px 0 24px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${detailRow("Xero organisation", org)}
              ${requesterName ? detailRow("Requested by", escapeHtml(requesterName)) : ""}
              ${detailRow("Xero user email", escapeHtml(requesterEmail || ""))}
            </table>
          </div>

          ${p("If you recognise this request, approve the connection below. You'll be asked to sign in as your account administrator to confirm.")}

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 24px">
            <tr>
              ${button(approveUrl, "Approve Xero Connection")}
              <td style="width:12px"></td>
              ${button(rejectUrl, "Reject Request", { primary: false })}
            </tr>
          </table>

          <div style="background:#f8fafc;border:1px solid #e8edf3;border-radius:8px;padding:14px 18px;margin:0 0 18px">
            <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#334155;font-family:${FONT}"><strong>If you approve:</strong> this Xero organisation is linked to your Dooit account and data can sync between them.</p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:#334155;font-family:${FONT}"><strong>If you reject:</strong> nothing is connected and nothing changes on your account.</p>
          </div>

          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px 18px">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#9a3412;font-family:${FONT}">
              &#9888; <strong>Don't recognise this?</strong> Reject it, or simply ignore this email. This link expires in
              ${Number(expiresInMinutes)} minutes and can be used only once. Dooit will never ask you to share it.
            </p>
          </div>
        </td>
      </tr>`;

  return shell({
    title: "Confirm Xero connection",
    preview: `Confirm the Xero connection for ${org}`,
    cardRows:
      brandHeader({
        icon: "&#128279;",
        title: "Confirm Xero connection",
        subtitle: "Your approval is needed to link a Xero organisation",
      }) +
      body +
      brandFooter("Sent because a Xero connection was requested for your Dooit account."),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Outcome → the requester
// ─────────────────────────────────────────────────────────────────────────────
function xeroConnectionDecisionHtml({ organisationName, approved, continueUrl } = {}) {
  const org = escapeHtml(organisationName || "your organisation");

  const content = approved
    ? `${p(`Good news — the Xero organisation <strong>${org}</strong> has been connected to Dooit.`)}
       ${
         continueUrl
           ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 8px"><tr>${button(
               continueUrl,
               "Continue to Dooit"
             )}</tr></table>`
           : ""
       }`
    : `${p(`The request to connect the Xero organisation <strong>${org}</strong> to Dooit was declined by the account administrator.`)}
       ${p("No connection was made. If you think this is a mistake, please contact the administrator of the Dooit account directly.")}`;

  return shell({
    title: approved ? "Xero connection approved" : "Xero connection declined",
    preview: approved ? "Your Xero connection was approved" : "Your Xero connection request was declined",
    cardRows:
      brandHeader({
        icon: approved ? "&#10003;" : "&#10005;",
        title: approved ? "Connection approved" : "Request declined",
      }) +
      `<tr><td class="px" style="padding:34px 40px 30px">${content}</td></tr>` +
      brandFooter(),
  });
}

module.exports = { xeroConnectionApprovalHtml, xeroConnectionDecisionHtml, escapeHtml };
