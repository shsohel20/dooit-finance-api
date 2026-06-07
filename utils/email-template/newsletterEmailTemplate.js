function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function newsletterAdminHtml(sub) {
  const subscribedAt = new Date(sub.createdAt || Date.now()).toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long",
    day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const source = escapeHtml((sub.utm && sub.utm.source) || "footer-form");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>New Newsletter Subscriber</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    .hdr{background:linear-gradient(135deg,#4c1d95 0%,#7c3aed 100%);padding:32px 40px}
    .hdr h1{color:#fff;font-size:20px;font-weight:700;letter-spacing:-.3px;margin-bottom:6px}
    .hdr .sub{color:rgba(255,255,255,.7);font-size:13px}
    .badge{display:inline-block;background:rgba(255,255,255,.2);color:#ddd6fe;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;border:1px solid rgba(221,214,254,.3);margin-top:10px;letter-spacing:.5px}
    .body{padding:36px 40px}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:16px}
    .field{margin-bottom:18px}
    .field-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;margin-bottom:4px}
    .field-value{font-size:15px;color:#1e293b;line-height:1.5}
    .field-value a{color:#7c3aed;text-decoration:none}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:24px 0}
    .meta-row{display:flex;margin-top:24px;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0}
    .meta-cell{flex:1;padding:16px 20px;background:#f8fafc;border-right:1px solid #e2e8f0}
    .meta-cell:last-child{border-right:none}
    .stat-box{background:linear-gradient(135deg,#f5f3ff,#ede9fe);border:1px solid #ddd6fe;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px}
    .stat-box .stat-num{font-size:32px;font-weight:800;color:#6d28d9;line-height:1}
    .stat-box .stat-label{font-size:12px;color:#7c3aed;margin-top:6px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
    .ftr{background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;text-align:center}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.6}
    @media(max-width:600px){.hdr,.body{padding:24px 20px}.ftr{padding:16px 20px}.meta-row{flex-direction:column}.meta-cell{border-right:none;border-bottom:1px solid #e2e8f0}.meta-cell:last-child{border-bottom:none}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <h1>New Newsletter Subscriber</h1>
        <div class="sub">Someone has joined your mailing list</div>
        <div class="badge">NEW SUBSCRIBER</div>
      </div>
      <div class="body">
        <div class="section-title">Subscriber Details</div>
        <div class="field">
          <div class="field-label">Email Address</div>
          <div class="field-value"><a href="mailto:${escapeHtml(sub.email)}">${escapeHtml(sub.email)}</a></div>
        </div>
        <div class="meta-row">
          <div class="meta-cell">
            <div class="field-label">Subscribed</div>
            <div class="field-value" style="font-size:13px;color:#475569">${subscribedAt}</div>
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

function newsletterUserHtml(sub) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Welcome to the Dooit Newsletter</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    .hdr{background:linear-gradient(135deg,#4c1d95 0%,#7c3aed 100%);padding:40px;text-align:center}
    .hdr .icon{width:60px;height:60px;background:rgba(255,255,255,.15);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;font-size:26px;line-height:60px}
    .hdr h1{color:#fff;font-size:24px;font-weight:700;letter-spacing:-.3px;margin-bottom:8px}
    .hdr p{color:rgba(255,255,255,.75);font-size:14px}
    .body{padding:40px}
    .greeting{font-size:16px;color:#1e293b;margin-bottom:20px;line-height:1.6}
    .text{font-size:15px;color:#475569;line-height:1.7;margin-bottom:20px}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:28px 0}
    .perks{list-style:none;margin:16px 0}
    .perks li{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid #f8fafc;font-size:14px;color:#374151;line-height:1.5}
    .perks li:last-child{border-bottom:none}
    .perk-icon{flex-shrink:0;width:28px;height:28px;background:#f5f3ff;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:28px;text-align:center}
    .info-box{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:20px;margin:24px 0}
    .info-box p{font-size:14px;color:#5b21b6;line-height:1.6}
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
        <div class="icon">&#128233;</div>
        <h1>You're Subscribed!</h1>
        <p>Welcome to the Dooit newsletter</p>
      </div>
      <div class="body">
        <p class="greeting">Hi there,</p>
        <p class="text">
          Thank you for subscribing to the Dooit newsletter. You'll be the first to know
          about our latest updates, compliance insights, and platform news.
        </p>
        <hr class="divider"/>
        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:12px">What to Expect</p>
        <ul class="perks">
          <li>
            <span class="perk-icon">&#128240;</span>
            <span><strong>Industry Updates</strong> &mdash; Stay current with the latest regulatory and compliance news</span>
          </li>
          <li>
            <span class="perk-icon">&#128161;</span>
            <span><strong>Platform Insights</strong> &mdash; Tips, guides, and best practices for using Dooit effectively</span>
          </li>
          <li>
            <span class="perk-icon">&#127881;</span>
            <span><strong>Feature Announcements</strong> &mdash; Be the first to hear about new features and improvements</span>
          </li>
        </ul>
        <div class="info-box">
          <p>&#128274; You can unsubscribe at any time by replying to any newsletter with
          &ldquo;Unsubscribe&rdquo; in the subject line and we'll remove you promptly.</p>
        </div>
        <div class="signature">
          Warm regards,<br/>
          <strong>The Dooit Team</strong>
        </div>
      </div>
      <div class="ftr">
        <p>&copy; ${new Date().getFullYear()} Dooit. All rights reserved.<br/>
        You received this because you subscribed at dooit.com</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function newsletterText(sub) {
  return `New newsletter subscriber: ${sub.email}. Source: ${(sub.utm && sub.utm.source) || "footer-form"}.`;
}

module.exports = { newsletterAdminHtml, newsletterUserHtml, newsletterText };
