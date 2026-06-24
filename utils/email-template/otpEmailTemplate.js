/**
 * OTP and password-reset email templates.
 *
 * otpVerificationHtml(code, userName) – account confirmation OTP
 * passwordResetHtml(resetUrl, userName) – forgot-password reset link
 */

function otpVerificationHtml(code, userName) {
  const digits = String(code).padStart(6, "0").split("");

  const digitBoxes = digits
    .map(
      (d) =>
        `<span style="display:inline-block;width:48px;height:60px;background:#f8fafc;border:2px solid #cbd5e1;border-radius:10px;font-size:30px;font-weight:800;color:#1e293b;text-align:center;line-height:60px;margin:0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">${d}</span>`
    )
    .join("");

  const displayName = userName ? String(userName).trim() : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Verify Your Account</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,.09)}
    .hdr{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:40px 40px 36px;text-align:center}
    .hdr .shield{width:64px;height:64px;background:rgba(255,255,255,.15);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px;font-size:28px;line-height:64px;border:2px solid rgba(255,255,255,.25)}
    .hdr h1{color:#fff;font-size:24px;font-weight:700;letter-spacing:-.4px;margin-bottom:8px}
    .hdr p{color:rgba(255,255,255,.75);font-size:14px}
    .body{padding:40px}
    .greeting{font-size:16px;color:#1e293b;margin-bottom:16px;line-height:1.6}
    .text{font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px}
    .otp-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;text-align:center;margin-bottom:14px}
    .otp-wrap{text-align:center;margin:0 0 10px}
    .otp-expiry{text-align:center;font-size:13px;color:#64748b;margin-top:10px}
    .otp-expiry strong{color:#dc2626}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:28px 0}
    .info-box{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 20px;margin-top:4px}
    .info-box p{font-size:13px;color:#1d4ed8;line-height:1.6}
    .security-box{background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 18px;margin-top:16px}
    .security-box p{font-size:13px;color:#991b1b;line-height:1.6}
    .ftr{background:#f8fafc;border-top:1px solid #e2e8f0;padding:22px 40px;text-align:center}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.7}
    @media(max-width:560px){
      .hdr,.body{padding:28px 20px}
      .ftr{padding:16px 20px}
      .otp-wrap span{width:38px!important;height:50px!important;font-size:24px!important;line-height:50px!important;margin:0 2px!important}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <div class="shield">&#128274;</div>
        <h1>Verify Your Account</h1>
        <p>Enter the code below to confirm your email address</p>
      </div>
      <div class="body">
        ${displayName
          ? `<p class="greeting">Hi <strong>${displayName}</strong>,</p>`
          : `<p class="greeting">Hi there,</p>`}
        <p class="text">
          To complete your registration and activate your account, please use
          the one-time verification code below. Do not share this code with anyone.
        </p>
        <div class="otp-label">Your Verification Code</div>
        <div class="otp-wrap">${digitBoxes}</div>
        <p class="otp-expiry">This code expires in <strong>10 minutes</strong></p>
        <hr class="divider"/>
        <div class="info-box">
          <p>&#128221; Enter this code in the verification screen to activate your account.
          If the code expires, you can request a new one from the login page.</p>
        </div>
        <div class="security-box">
          <p>&#128683; If you did not create an account with Dooit, please ignore this email.
          No action is needed — your email address will not be used.</p>
        </div>
      </div>
      <div class="ftr">
        <p>&copy; ${new Date().getFullYear()} Dooit. All rights reserved.<br/>
        This is a security email &mdash; please do not reply.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function passwordResetHtml(resetUrl, userName) {
  const displayName = userName ? String(userName).trim() : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Reset Your Password</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,.09)}
    .hdr{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:40px;text-align:center}
    .hdr .icon{width:64px;height:64px;background:rgba(255,255,255,.15);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px;font-size:28px;line-height:64px;border:2px solid rgba(255,255,255,.25)}
    .hdr h1{color:#fff;font-size:24px;font-weight:700;letter-spacing:-.4px;margin-bottom:8px}
    .hdr p{color:rgba(255,255,255,.75);font-size:14px}
    .body{padding:40px}
    .greeting{font-size:16px;color:#1e293b;margin-bottom:16px;line-height:1.6}
    .text{font-size:15px;color:#475569;line-height:1.7;margin-bottom:24px}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:28px 0}
    .cta-wrap{text-align:center;margin:8px 0 28px}
    .cta-btn{display:inline-block;background-color:#2563eb;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#ffffff!important;text-decoration:none;padding:15px 40px;border-radius:8px;font-size:16px;font-weight:600;letter-spacing:-.1px;box-shadow:0 4px 12px rgba(37,99,235,.35)}
    .fallback{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px}
    .fallback p{font-size:13px;color:#64748b;line-height:1.6;margin-bottom:6px}
    .fallback a{color:#2563eb;font-size:12px;word-break:break-all;text-decoration:none}
    .expiry-box{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-top:16px}
    .expiry-box p{font-size:13px;color:#92400e;line-height:1.6}
    .security-box{background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 18px;margin-top:16px}
    .security-box p{font-size:13px;color:#991b1b;line-height:1.6}
    .ftr{background:#f8fafc;border-top:1px solid #e2e8f0;padding:22px 40px;text-align:center}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.7}
    @media(max-width:560px){.hdr,.body{padding:28px 20px}.ftr{padding:16px 20px}.cta-btn{padding:13px 28px;font-size:15px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <div class="icon">&#128273;</div>
        <h1>Reset Your Password</h1>
        <p>You requested a password reset for your account</p>
      </div>
      <div class="body">
        ${displayName
          ? `<p class="greeting">Hi <strong>${displayName}</strong>,</p>`
          : `<p class="greeting">Hi there,</p>`}
        <p class="text">
          We received a request to reset the password for your Dooit account.
          Click the button below to set a new password. This link is valid for
          <strong>10 minutes</strong>.
        </p>
        <div class="cta-wrap">
          <a href="${resetUrl}" class="cta-btn" style="display:inline-block;background-color:#2563eb;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#ffffff!important;text-decoration:none;padding:15px 40px;border-radius:8px;font-size:16px;font-weight:600;letter-spacing:-.1px">Reset My Password &rarr;</a>
        </div>
        <div class="fallback">
          <p>Button not working? Copy and paste this link into your browser:</p>
          <a href="${resetUrl}">${resetUrl}</a>
        </div>
        <div class="expiry-box">
          <p>&#9200; This reset link expires in <strong>10 minutes</strong>.
          If it has expired, visit the login page and request a new reset link.</p>
        </div>
        <div class="security-box">
          <p>&#128683; If you did not request a password reset, please ignore this email.
          Your password will remain unchanged and your account is secure.</p>
        </div>
      </div>
      <div class="ftr">
        <p>&copy; ${new Date().getFullYear()} Dooit. All rights reserved.<br/>
        This is a security email &mdash; please do not reply.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { otpVerificationHtml, passwordResetHtml };
