function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contactAdminHtml(contact) {
  const submittedAt = new Date(contact.createdAt || Date.now()).toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long",
    day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const source = escapeHtml((contact.utm && contact.utm.source) || "contact-form");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>New Contact Request</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    .hdr{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);padding:32px 40px}
    .hdr h1{color:#fff;font-size:20px;font-weight:700;letter-spacing:-.3px;margin-bottom:6px}
    .hdr .sub{color:rgba(255,255,255,.65);font-size:13px}
    .badge{display:inline-block;background:rgba(59,130,246,.25);color:#93c5fd;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;border:1px solid rgba(147,197,253,.3);margin-top:10px;letter-spacing:.5px}
    .body{padding:36px 40px}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:16px}
    .field{margin-bottom:18px}
    .field-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;margin-bottom:4px}
    .field-value{font-size:15px;color:#1e293b;line-height:1.5}
    .field-value a{color:#2563eb;text-decoration:none}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:24px 0}
    .msg-box{background:#f8fafc;border-left:4px solid #2563eb;border-radius:0 6px 6px 0;padding:16px 20px;font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap;word-break:break-word}
    .meta-row{display:flex;margin-top:24px;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0}
    .meta-cell{flex:1;padding:16px 20px;background:#f8fafc;border-right:1px solid #e2e8f0}
    .meta-cell:last-child{border-right:none}
    .ftr{background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;text-align:center}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.6}
    @media(max-width:600px){.hdr,.body{padding:24px 20px}.ftr{padding:16px 20px}.meta-row{flex-direction:column}.meta-cell{border-right:none;border-bottom:1px solid #e2e8f0}.meta-cell:last-child{border-bottom:none}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <h1>New Contact Request</h1>
        <div class="sub">A message has been submitted via the contact form</div>
        <div class="badge">ACTION REQUIRED</div>
      </div>
      <div class="body">
        <div class="section-title">Sender Details</div>
        <div class="field">
          <div class="field-label">Full Name</div>
          <div class="field-value">${escapeHtml(contact.name)}</div>
        </div>
        <div class="field">
          <div class="field-label">Email Address</div>
          <div class="field-value"><a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a></div>
        </div>
        <div class="field">
          <div class="field-label">Subject</div>
          <div class="field-value">${escapeHtml(contact.subject)}</div>
        </div>
        <hr class="divider"/>
        <div class="section-title">Message</div>
        <div class="msg-box">${escapeHtml(contact.message)}</div>
        <div class="meta-row">
          <div class="meta-cell">
            <div class="field-label">Submitted</div>
            <div class="field-value" style="font-size:13px;color:#475569">${submittedAt}</div>
          </div>
          <div class="meta-cell">
            <div class="field-label">Source</div>
            <div class="field-value" style="font-size:13px;color:#475569">${source}</div>
          </div>
        </div>
      </div>
      <div class="ftr">
        <p><strong style="color:#64748b">Dooit</strong> &mdash; Internal Notification &mdash; Do not forward externally</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function contactUserHtml(contact) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>We've Received Your Message</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    .hdr{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:40px;text-align:center}
    .hdr .icon{width:52px;height:52px;background:rgba(255,255,255,.15);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;font-size:22px}
    .hdr h1{color:#fff;font-size:22px;font-weight:700;letter-spacing:-.3px;margin-bottom:8px}
    .hdr p{color:rgba(255,255,255,.75);font-size:14px}
    .body{padding:40px}
    .greeting{font-size:16px;color:#1e293b;margin-bottom:20px;line-height:1.6}
    .text{font-size:15px;color:#475569;line-height:1.7;margin-bottom:20px}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:28px 0}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:12px}
    .msg-box{background:#f8fafc;border-left:4px solid #2563eb;border-radius:0 6px 6px 0;padding:16px 20px;font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap;word-break:break-word}
    .info-box{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:20px;margin:24px 0}
    .info-box p{font-size:14px;color:#1d4ed8;line-height:1.6}
    .signature{margin-top:28px;font-size:15px;color:#374151;line-height:1.7}
    .ftr{background:#f8fafc;border-top:1px solid #e2e8f0;padding:24px 40px;text-align:center}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.6}
    @media(max-width:600px){.hdr,.body{padding:28px 20px}.ftr{padding:16px 20px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <div class="icon">&#9993;</div>
        <h1>Message Received</h1>
        <p>We'll get back to you as soon as possible</p>
      </div>
      <div class="body">
        <p class="greeting">Hi <strong>${escapeHtml(contact.name)}</strong>,</p>
        <p class="text">
          Thank you for reaching out. We've successfully received your message regarding
          <strong>${escapeHtml(contact.subject)}</strong> and a member of our team will
          review it and respond shortly.
        </p>
        <hr class="divider"/>
        <div class="section-title">Your Message</div>
        <div class="msg-box">${escapeHtml(contact.message)}</div>
        <div class="info-box">
          <p>&#128337; Our typical response time is <strong>1&ndash;2 business days</strong>.
          For urgent matters, please reply to this email and we'll prioritize your request.</p>
        </div>
        <div class="signature">
          Warm regards,<br/>
          <strong>The Dooit Support Team</strong>
        </div>
      </div>
      <div class="ftr">
        <p>&copy; ${new Date().getFullYear()} Dooit. All rights reserved.<br/>
        This is an automated confirmation &mdash; please do not reply to this address.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function contactText(contact) {
  return `New contact from ${contact.name} (${contact.email}). Subject: ${contact.subject}. Message: ${contact.message}`;
}

module.exports = { contactAdminHtml, contactUserHtml, contactText };
