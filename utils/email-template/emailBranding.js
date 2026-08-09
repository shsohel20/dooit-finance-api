"use strict";

/**
 * Shared branding for Dooit transactional emails.
 *
 * Everything here is table-based and fully inline-styled so it renders
 * consistently across Gmail, Outlook (desktop + web), Apple Mail and mobile
 * clients — many of which strip <head><style> blocks. A <style> block is still
 * emitted by the shell() helper below purely as progressive enhancement
 * (mobile @media tweaks); nothing depends on it to look correct.
 *
 * Logo:
 *   Set EMAIL_LOGO_URL to a publicly reachable PNG/SVG (ideally a white or
 *   transparent wordmark, ~280x92) and the real Dooit logo is shown in the
 *   header. Without it, a styled white "Dooit.AI" text wordmark is rendered,
 *   which always displays on every client with zero external image loading.
 */

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/**
 * Escape untrusted text before interpolating it into an email body. Names,
 * client names and role labels are user-supplied, so they must never be able
 * to inject markup into the rendered HTML.
 */
const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Real hosted Dooit logo (black wordmark on transparent). Rendered on a WHITE
// band so it's always visible. Override with EMAIL_LOGO_URL if the asset moves.
const LOGO_URL = (process.env.EMAIL_LOGO_URL || "https://dooit.ai/assets/img/logo.png").trim();
const SUPPORT_EMAIL =
  (process.env.SUPPORT_EMAIL || process.env.FROM_EMAIL || "support@dooit.ai").trim();
const BRAND_COLOR = "#2563eb";

/**
 * Logo lockup, sized for the white header band. Renders the hosted image; if the
 * recipient blocks images the `alt` text keeps the brand visible. Falls back to a
 * dark text wordmark only when LOGO_URL is explicitly cleared.
 */
const logoMark = () =>
  LOGO_URL
    ? `<img src="${LOGO_URL}" alt="Dooit.AI" height="36" style="display:inline-block;height:36px;width:auto;max-width:160px;border:0;line-height:100%;outline:none;text-decoration:none" />`
    : `<span style="font-family:${FONT};font-size:26px;font-weight:800;letter-spacing:-.5px;color:#0f172a;line-height:1">Dooit<span style="color:#2563eb">.AI</span></span>`;

/**
 * Partner (client/tenant) mark shown beside the Dooit logo when an email is sent
 * on behalf of a specific client. Prefers the client's hosted logo; falls back to
 * their name as a text wordmark so co-branding still reads when no logo is set.
 */
const coBrandMark = ({ name, logoUrl } = {}) =>
  logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${esc(name)}" height="32" style="display:inline-block;height:32px;width:auto;max-width:150px;border:0;line-height:100%;outline:none;text-decoration:none;vertical-align:middle" />`
    : `<span style="font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:-.2px;color:#0f172a;vertical-align:middle">${esc(name)}</span>`;

/**
 * Brand header: a white band carrying the logo, followed by a gradient hero with
 * an optional emoji icon badge + title + subtitle. Returns two <tr> rows to drop
 * inside the card <table>. Two bands keep the (black) logo readable while
 * preserving the branded gradient hero used across Dooit emails.
 *
 * `coBrand` ({ name, logoUrl }) renders a Dooit + client lockup in the white band,
 * separated by a hairline divider — used for emails addressed to a client's own
 * users so both brands are present.
 */
function brandHeader({ icon = "", title = "", subtitle = "", coBrand = null }) {
  const hasCoBrand = Boolean(coBrand && (coBrand.logoUrl || coBrand.name));

  // Divider is a filled <div> rather than a border so Outlook keeps its height.
  const logoBand = hasCoBrand
    ? `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto">
            <tr>
              <td style="padding:0 18px 0 0;vertical-align:middle">${logoMark()}</td>
              <td style="width:1px;padding:0;vertical-align:middle">
                <div style="width:1px;height:30px;background:#e2e8f0;font-size:0;line-height:0">&nbsp;</div>
              </td>
              <td style="padding:0 0 0 18px;vertical-align:middle">${coBrandMark(coBrand)}</td>
            </tr>
          </table>`
    : logoMark();

  return `
      <tr>
        <td style="background:#ffffff;padding:22px 40px 20px;text-align:center;border-bottom:1px solid #eef2f7">
          ${logoBand}
        </td>
      </tr>
      <tr>
        <td style="background-color:#1e3a5f;background-image:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:32px 40px;text-align:center">
          ${
            // Table (not a styled <div>) so Word keeps the badge a centred
            // 60px box instead of stretching it to the full header width.
            icon
              ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 14px">
            <tr>
              <td width="60" height="60" align="center" valign="middle" style="width:60px;height:60px;background:#2a4d7d;border:2px solid #5580b8;border-radius:50%;font-size:26px;line-height:56px;mso-line-height-rule:exactly">${icon}</td>
            </tr>
          </table>`
              : ""
          }
          <h1 style="margin:0;color:#ffffff;font-size:23px;font-weight:700;letter-spacing:-.3px;line-height:1.3;mso-line-height-rule:exactly;font-family:${FONT}">${title}</h1>
          ${
            subtitle
              ? `<p style="margin:8px 0 0;color:#dbe6f5;font-size:14px;line-height:1.5;mso-line-height-rule:exactly;font-family:${FONT}">${subtitle}</p>`
              : ""
          }
        </td>
      </tr>`;
}

/** Footer row with support contact + copyright. Returns a <tr>. */
function brandFooter(
  note = "This is a system-generated email — please do not reply."
) {
  return `
      <tr>
        <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:22px 40px;text-align:center">
          <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.7;font-family:${FONT}">
            Need help? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#2563eb;text-decoration:none">${SUPPORT_EMAIL}</a><br/>
            &copy; ${new Date().getFullYear()} Dooit. All rights reserved.<br/>${note}
          </p>
        </td>
      </tr>`;
}

/**
 * Full HTML document shell. `cardRows` is the concatenation of <tr> rows
 * (header + body + footer). `preview` is hidden preheader text shown in the
 * inbox list preview.
 */
function shell({ title, preview = "", cardRows = "" }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
  <meta name="x-apple-disable-message-reformatting"/>
  <meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no"/>
  <meta name="color-scheme" content="light"/>
  <meta name="supported-color-schemes" content="light"/>
  <title>${title}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <style>
    /* Word can't parse the -apple-system stack and silently falls back to
       Times New Roman, so restate a font it does know. .mono opts back out. */
    *{font-family:Arial,Helvetica,sans-serif !important}
    .mono{font-family:Consolas,'Courier New',monospace !important}
    /* Word rounds fractional line-heights up, which loosens every block; pin
       them so paragraph spacing matches the other clients. */
    body,table,td,p,a,span,div,h1{mso-line-height-rule:exactly}
  </style>
  <![endif]-->
  <style>
    body{margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;word-spacing:normal}
    table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}
    td{mso-line-height-rule:exactly}
    img{border:0;height:auto;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
    a{text-decoration:none}
    /* Neutralise iOS/Gmail auto-linking of phone numbers, dates and addresses. */
    a[x-apple-data-detectors],.unstyled-auto-detected-link a,u+#body a,#MessageViewBody a{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}
    @media only screen and (max-width:600px){
      .card{width:100%!important;border-radius:0!important}
      .px{padding-left:22px!important;padding-right:22px!important}
      .cta-btn{display:block!important;width:100%!important;box-sizing:border-box!important;text-align:center!important}
    }
  </style>
</head>
<body id="body" style="margin:0;padding:0;background:#f1f5f9;font-family:${FONT}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${preview}</div>
  <!-- Filler stops the client from pulling body copy into the inbox preview. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <div role="article" aria-roledescription="email" aria-label="${title}" lang="en">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9">
    <tr>
      <td align="center" style="padding:32px 12px">
        <!--[if mso]>
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td>
        <![endif]-->
        <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(15,23,42,.09)">
          ${cardRows}
        </table>
        <!--[if mso]>
        </td></tr></table>
        <![endif]-->
      </td>
    </tr>
  </table>
  </div>
</body>
</html>`;
}

module.exports = {
  FONT,
  LOGO_URL,
  SUPPORT_EMAIL,
  BRAND_COLOR,
  esc,
  logoMark,
  coBrandMark,
  brandHeader,
  brandFooter,
  shell,
};
