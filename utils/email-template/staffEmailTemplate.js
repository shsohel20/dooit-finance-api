"use strict";

/**
 * staffWelcomeHtml — welcome email sent when a new staff account is created.
 * Includes login email and temporary password.
 */
function staffWelcomeHtml(name, email, password) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Welcome to Dooit</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,.09)}
    .hdr{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:40px;text-align:center}
    .hdr .icon{width:64px;height:64px;background:rgba(255,255,255,.15);border-radius:50%;display:inline-block;line-height:64px;font-size:28px;margin-bottom:18px;border:2px solid rgba(255,255,255,.25)}
    .hdr h1{color:#fff;font-size:24px;font-weight:700;margin-bottom:8px}
    .hdr p{color:rgba(255,255,255,.75);font-size:14px}
    .body{padding:40px}
    .greeting{font-size:16px;color:#1e293b;margin-bottom:16px;line-height:1.6}
    .text{font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px}
    .cred-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin-bottom:20px}
    .cred-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px}
    .cred-row:last-child{border-bottom:none}
    .cred-label{color:#64748b;font-weight:500}
    .cred-value{color:#1e293b;font-weight:700;font-family:monospace;font-size:15px}
    .warn-box{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-top:4px}
    .warn-box p{font-size:13px;color:#92400e;line-height:1.6}
    .ftr{background:#f8fafc;border-top:1px solid #e2e8f0;padding:22px 40px;text-align:center}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.7}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <div class="icon">&#127381;</div>
        <h1>Welcome to Dooit</h1>
        <p>Your staff account has been created</p>
      </div>
      <div class="body">
        <p class="greeting">Hi <strong>${name}</strong>,</p>
        <p class="text">
          Your employee account has been set up on the Dooit platform.
          Use the credentials below to sign in for the first time.
          Please change your password immediately after logging in.
        </p>
        <div class="cred-box">
          <div class="cred-row">
            <span class="cred-label">Email</span>
            <span class="cred-value">${email}</span>
          </div>
          <div class="cred-row">
            <span class="cred-label">Temporary Password</span>
            <span class="cred-value">${password}</span>
          </div>
        </div>
        <div class="warn-box">
          <p>&#9888; This password is temporary. You will be prompted to change it on your first login. Never share your credentials with anyone.</p>
        </div>
      </div>
      <div class="ftr">
        <p>&copy; ${new Date().getFullYear()} Dooit. All rights reserved.<br/>This is a system-generated email — please do not reply.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { staffWelcomeHtml };
