function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function leadAdminHtml(lead) {
  const submittedAt = new Date(lead.createdAt || Date.now()).toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long",
    day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>New Lead Received</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    .hdr{background:linear-gradient(135deg,#064e3b 0%,#059669 100%);padding:32px 40px}
    .hdr h1{color:#fff;font-size:20px;font-weight:700;letter-spacing:-.3px;margin-bottom:6px}
    .hdr .sub{color:rgba(255,255,255,.7);font-size:13px}
    .badge{display:inline-block;background:rgba(255,255,255,.2);color:#d1fae5;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;border:1px solid rgba(209,250,229,.3);margin-top:10px;letter-spacing:.5px}
    .body{padding:36px 40px}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:16px}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:20px}
    .grid-cell{padding:16px 20px;background:#fff;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0}
    .grid-cell:nth-child(2n){border-right:none}
    .grid-cell:nth-last-child(-n+2){border-bottom:none}
    .field-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;margin-bottom:4px}
    .field-value{font-size:14px;color:#1e293b;line-height:1.5;word-break:break-all}
    .field-value a{color:#059669;text-decoration:none}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:24px 0}
    .consent-yes{display:inline-block;background:#d1fae5;color:#065f46;font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px}
    .consent-no{display:inline-block;background:#fee2e2;color:#991b1b;font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px}
    .meta-row{display:flex;margin-top:24px;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0}
    .meta-cell{flex:1;padding:16px 20px;background:#f8fafc;border-right:1px solid #e2e8f0}
    .meta-cell:last-child{border-right:none}
    .ftr{background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;text-align:center}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.6}
    @media(max-width:600px){.hdr,.body{padding:24px 20px}.ftr{padding:16px 20px}.grid-2{grid-template-columns:1fr}.grid-cell{border-right:none}.grid-cell:nth-last-child(-n+2){border-bottom:1px solid #e2e8f0}.grid-cell:last-child{border-bottom:none}.meta-row{flex-direction:column}.meta-cell{border-right:none;border-bottom:1px solid #e2e8f0}.meta-cell:last-child{border-bottom:none}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <h1>New Lead Received</h1>
        <div class="sub">A prospect has submitted an enquiry form</div>
        <div class="badge">NEW LEAD</div>
      </div>
      <div class="body">
        <div class="section-title">Contact Information</div>
        <div class="grid-2">
          <div class="grid-cell">
            <div class="field-label">First Name</div>
            <div class="field-value">${escapeHtml(lead.firstName)}</div>
          </div>
          <div class="grid-cell">
            <div class="field-label">Last Name</div>
            <div class="field-value">${escapeHtml(lead.lastName)}</div>
          </div>
          <div class="grid-cell">
            <div class="field-label">Email</div>
            <div class="field-value"><a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a></div>
          </div>
          <div class="grid-cell">
            <div class="field-label">Phone</div>
            <div class="field-value">${escapeHtml(lead.phoneNumber)}</div>
          </div>
        </div>
        <hr class="divider"/>
        <div class="section-title">Business Details</div>
        <div class="grid-2">
          <div class="grid-cell">
            <div class="field-label">Business Name</div>
            <div class="field-value">${escapeHtml(lead.businessName || "—")}</div>
          </div>
          <div class="grid-cell">
            <div class="field-label">Industry</div>
            <div class="field-value">${escapeHtml(lead.industry || "—")}</div>
          </div>
          <div class="grid-cell">
            <div class="field-label">Zip / Postal Code</div>
            <div class="field-value">${escapeHtml(lead.zipCode || "—")}</div>
          </div>
          <div class="grid-cell">
            <div class="field-label">Annual Revenue</div>
            <div class="field-value">${escapeHtml(lead.annualRevenue || "—")}</div>
          </div>
        </div>
        <hr class="divider"/>
        <div class="section-title">Compliance</div>
        <div style="margin-bottom:8px">
          <div class="field-label" style="margin-bottom:8px">Consent Given</div>
          ${lead.consent
            ? '<span class="consent-yes">&#10003; Yes — Consent Provided</span>'
            : '<span class="consent-no">&#10007; No — Consent Not Provided</span>'}
        </div>
        <div class="meta-row">
          <div class="meta-cell">
            <div class="field-label">Submitted</div>
            <div class="field-value" style="font-size:13px;color:#475569">${submittedAt}</div>
          </div>
          <div class="meta-cell">
            <div class="field-label">Source</div>
            <div class="field-value" style="font-size:13px;color:#475569">${escapeHtml(lead.source || "web-form")}</div>
          </div>
        </div>
      </div>
      <div class="ftr">
        <p><strong style="color:#64748b">Dooit</strong> &mdash; Internal Lead Notification &mdash; Do not forward externally</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function leadUserHtml(lead) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Thank You for Your Enquiry</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    .hdr{background:linear-gradient(135deg,#064e3b 0%,#059669 100%);padding:40px;text-align:center}
    .hdr .icon{width:52px;height:52px;background:rgba(255,255,255,.15);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;font-size:22px;line-height:52px}
    .hdr h1{color:#fff;font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:8px}
    .hdr p{color:rgba(255,255,255,.75);font-size:14px}
    .body{padding:40px}
    .greeting{font-size:16px;color:#1e293b;margin-bottom:20px;line-height:1.6}
    .text{font-size:15px;color:#475569;line-height:1.7;margin-bottom:20px}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:28px 0}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:16px}
    .summary-list{border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
    .summary-row{display:flex;padding:13px 20px;border-bottom:1px solid #f1f5f9;align-items:baseline}
    .summary-row:last-child{border-bottom:none}
    .summary-row:nth-child(even){background:#f8fafc}
    .sl{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.7px;color:#94a3b8;min-width:140px}
    .sv{font-size:14px;color:#1e293b}
    .info-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:24px 0}
    .info-box p{font-size:14px;color:#166534;line-height:1.6}
    .signature{margin-top:28px;font-size:15px;color:#374151;line-height:1.7}
    .ftr{background:#f8fafc;border-top:1px solid #e2e8f0;padding:24px 40px;text-align:center}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.6}
    @media(max-width:600px){.hdr,.body{padding:28px 20px}.ftr{padding:16px 20px}.sl{min-width:100px}.summary-row{flex-direction:column;gap:4px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <div class="icon">&#128203;</div>
        <h1>Enquiry Received</h1>
        <p>Thank you for getting in touch with us</p>
      </div>
      <div class="body">
        <p class="greeting">Hi <strong>${escapeHtml(lead.firstName)}</strong>,</p>
        <p class="text">
          Thank you for your interest in Dooit. We've received your enquiry regarding
          <strong>${escapeHtml(lead.businessName || "your business")}</strong> and a
          member of our team will be in touch with you shortly.
        </p>
        <hr class="divider"/>
        <div class="section-title">Submission Summary</div>
        <div class="summary-list">
          <div class="summary-row">
            <span class="sl">Email</span>
            <span class="sv">${escapeHtml(lead.email)}</span>
          </div>
          <div class="summary-row">
            <span class="sl">Phone</span>
            <span class="sv">${escapeHtml(lead.phoneNumber)}</span>
          </div>
          <div class="summary-row">
            <span class="sl">Industry</span>
            <span class="sv">${escapeHtml(lead.industry || "—")}</span>
          </div>
          <div class="summary-row">
            <span class="sl">Annual Revenue</span>
            <span class="sv">${escapeHtml(lead.annualRevenue || "—")}</span>
          </div>
        </div>
        <div class="info-box">
          <p>&#128337; Our team typically responds within <strong>1&ndash;2 business days</strong>.
          If your enquiry is urgent, please reply to this email and we will prioritize your request.</p>
        </div>
        <div class="signature">
          Kind regards,<br/>
          <strong>The Dooit Team</strong>
        </div>
      </div>
      <div class="ftr">
        <p>&copy; ${new Date().getFullYear()} Dooit. All rights reserved.<br/>
        This is an automated confirmation — please do not reply to this address.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function leadText(lead) {
  return `New lead: ${lead.firstName} ${lead.lastName} — ${lead.email} — ${lead.phoneNumber}. Business: ${lead.businessName} (${lead.industry}). Revenue: ${lead.annualRevenue}. Consent: ${lead.consent ? "Yes" : "No"}.`;
}

module.exports = { leadAdminHtml, leadUserHtml, leadText };
