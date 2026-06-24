const InvitationEmailTemplate = (companyName, inviteLink) => {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>You've Been Invited to ${companyName}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#eef2ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(79,70,229,.12)}
    .hdr{background:linear-gradient(135deg,#0f172a 0%,#312e81 50%,#4f46e5 100%);padding:52px 40px 44px;text-align:center;position:relative}
    .hdr .brand{color:rgba(199,210,254,.9);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:22px}
    .hdr .icon-wrap{width:76px;height:76px;background:rgba(255,255,255,.12);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:22px;font-size:32px;line-height:76px;border:2px solid rgba(199,210,254,.35)}
    .hdr h1{color:#fff;font-size:28px;font-weight:700;letter-spacing:-.5px;margin-bottom:10px}
    .hdr p{color:rgba(199,210,254,.85);font-size:15px;line-height:1.6}
    .hdr p strong{color:#fff}
    .accent-bar{height:4px;background:linear-gradient(90deg,#818cf8,#a78bfa,#c4b5fd)}
    .body{padding:44px 40px}
    .greeting{font-size:16px;color:#1e293b;line-height:1.7;margin-bottom:24px}
    .divider{border:none;border-top:1px solid #e0e7ff;margin:28px 0}
    .section-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#818cf8;margin-bottom:12px}
    .steps{list-style:none;margin:0 0 8px}
    .steps li{display:flex;align-items:flex-start;gap:14px;padding:14px 0;border-bottom:1px solid #f0f4ff;font-size:14px;color:#374151;line-height:1.6}
    .steps li:last-child{border-bottom:none}
    .step-num{flex-shrink:0;width:30px;height:30px;background:linear-gradient(135deg,#e0e7ff,#c7d2fe);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#4338ca;line-height:1}
    .cta-wrap{text-align:center;margin:36px 0 28px}
    .cta-btn{display:inline-block;background-color:#4f46e5;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);color:#ffffff!important;text-decoration:none;padding:16px 44px;border-radius:10px;font-size:16px;font-weight:700;letter-spacing:-.1px;box-shadow:0 6px 20px rgba(79,70,229,.4)}
    .fallback{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:16px 20px;margin-top:4px}
    .fallback p{font-size:13px;color:#6d28d9;line-height:1.6;margin-bottom:6px}
    .fallback a{color:#4f46e5;font-size:12px;word-break:break-all;text-decoration:none}
    .expiry-note{background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:16px 20px;margin-top:20px}
    .expiry-note p{font-size:13px;color:#92400e;line-height:1.6}
    .signature{margin-top:32px;font-size:15px;color:#374151;line-height:1.9;padding-top:24px;border-top:1px solid #e0e7ff}
    .signature strong{color:#4338ca}
    .ftr{background:#f5f3ff;border-top:1px solid #ddd6fe;padding:24px 40px;text-align:center}
    .ftr p{color:#7c6fd4;font-size:12px;line-height:1.7}
    .ftr a{color:#6d28d9;text-decoration:none}
    @media(max-width:600px){.hdr,.body{padding:32px 20px}.ftr{padding:16px 20px}.cta-btn{padding:14px 30px;font-size:15px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <div class="brand">${companyName}</div>
        <div class="icon-wrap">&#128231;</div>
        <h1>You've Been Invited</h1>
        <p>You have been invited to join the <strong>${companyName}</strong> platform.<br/>
        Accept your invitation to get started.</p>
      </div>
      <div class="accent-bar"></div>
      <div class="body">
        <p class="greeting">
          Hello,<br/><br/>
          A member of the <strong>${companyName}</strong> team has invited you to create
          your account on the Dooit compliance platform. Click the button below to accept
          your invitation and complete your registration.
        </p>
        <hr class="divider"/>
        <p class="section-label">Getting Started</p>
        <ul class="steps">
          <li>
            <span class="step-num">1</span>
            <span><strong>Accept the invitation</strong> by clicking the button below</span>
          </li>
          <li>
            <span class="step-num">2</span>
            <span><strong>Create your account</strong> by setting a secure password</span>
          </li>
          <li>
            <span class="step-num">3</span>
            <span><strong>Access the platform</strong> and start collaborating with your team</span>
          </li>
        </ul>
        <div class="cta-wrap">
          <a href="${inviteLink}" class="cta-btn" style="display:inline-block;background-color:#4f46e5;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);color:#ffffff!important;text-decoration:none;padding:16px 44px;border-radius:10px;font-size:16px;font-weight:700">Accept Invitation &rarr;</a>
        </div>
        <div class="fallback">
          <p>Button not working? Copy and paste this link into your browser:</p>
          <a href="${inviteLink}">${inviteLink}</a>
        </div>
        <div class="expiry-note">
          <p>&#9200; This invitation link will expire in <strong>72 hours</strong>.
          If you did not expect this email, you can safely ignore it — no account will be created without your action.</p>
        </div>
        <div class="signature">
          Regards,<br/>
          <strong>The ${companyName} Team</strong>
        </div>
      </div>
      <div class="ftr">
        <p>&copy; ${year} ${companyName}. All rights reserved.<br/>
        You received this invitation because someone at ${companyName} added your email address.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
};

module.exports = InvitationEmailTemplate;
