"use strict";

/**
 * Client onboarding email templates (sent from clientController.createClient).
 *
 *   clientWelcomeHtml({ name, loginUrl })
 *       — warm, professional "welcome aboard" onboarding email.
 *
 *   clientCredentialsHtml({ name, email, tempPassword, setPasswordUrl, loginUrl })
 *       — login details + secure password-setup / reset instructions.
 *         tempPassword may be null for pre-existing accounts (in that case the
 *         password row is omitted and only the set/reset link is shown).
 *
 * Both use the shared, cross-client branding in ./emailBranding.
 */

const {
  FONT,
  brandHeader,
  brandFooter,
  shell,
} = require("./emailBranding");

const firstNameOf = (name) =>
  (name ? String(name).trim().split(/\s+/)[0] : "") || "there";

// ── Small inline-styled building blocks ──────────────────────────────────────
const p = (html, extra = "") =>
  `<p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#475569;font-family:${FONT};${extra}">${html}</p>`;

const feature = (icon, text) => `
  <tr>
    <td style="padding:9px 0;vertical-align:top;width:30px">
      <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#eff6ff;color:#2563eb;font-size:12px;line-height:22px;text-align:center;font-weight:700">${icon}</span>
    </td>
    <td style="padding:9px 0;font-size:14px;line-height:1.6;color:#334155;font-family:${FONT}">${text}</td>
  </tr>`;

const ctaButton = (href, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px auto 4px">
    <tr>
      <td align="center" bgcolor="#2563eb" style="border-radius:8px;background:#2563eb;background-image:linear-gradient(135deg,#2563eb,#1d4ed8)">
        <a href="${href}" class="cta-btn" style="display:inline-block;padding:15px 42px;font-size:16px;font-weight:600;letter-spacing:-.1px;color:#ffffff;font-family:${FONT};border-radius:8px">${label}</a>
      </td>
    </tr>
  </table>`;

// ─────────────────────────────────────────────────────────────────────────────
// 1) Welcome / onboarding email
// ─────────────────────────────────────────────────────────────────────────────
function clientWelcomeHtml({ name, loginUrl = "#" } = {}) {
  const first = firstNameOf(name);

  const body = `
      <tr>
        <td class="px" style="padding:38px 40px 34px">
          <p style="margin:0 0 16px;font-size:17px;color:#1e293b;font-family:${FONT}">Hi <strong>${first}</strong>,</p>
          ${p(
            "Welcome to <strong>Dooit</strong> — we're delighted to have you on board. Your organisation's compliance workspace has been created and is ready to go."
          )}
          ${p(
            "Dooit is your all-in-one AML/CTF &amp; governance, risk and compliance platform — bringing client due diligence, risk assessment, transaction monitoring and regulatory reporting together in one secure place."
          )}

          <div style="background:#f8fafc;border:1px solid #e8edf3;border-radius:12px;padding:12px 22px;margin:6px 0 26px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8;font-family:${FONT}">What you can do with Dooit</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${feature("&#10003;", "Onboard clients and run automated KYC / KYB due diligence")}
              ${feature("&#10003;", "Assess and monitor customer risk with a dynamic risk register")}
              ${feature("&#10003;", "Screen against sanctions, PEP and adverse-media watchlists")}
              ${feature("&#10003;", "Generate audit-ready compliance reports in a few clicks")}
            </table>
          </div>

          ${ctaButton(loginUrl, "Go to Your Dashboard &rarr;")}

          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;margin:24px 0 0">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#1d4ed8;font-family:${FONT}">
              &#128231; <strong>Next up:</strong> a separate email with your login details and step-by-step
              password-setup instructions is on its way to this inbox. You'll be signed in within minutes.
            </p>
          </div>
        </td>
      </tr>`;

  return shell({
    title: "Welcome to Dooit",
    preview:
      "Your Dooit compliance workspace is ready — here's what you can do next.",
    cardRows:
      brandHeader({
        icon: "&#128075;", // waving hand
        title: "Welcome to Dooit",
        subtitle: "Your compliance workspace is ready",
      }) +
      body +
      brandFooter(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Login credentials + password setup / reset email
// ─────────────────────────────────────────────────────────────────────────────
function clientCredentialsHtml({
  name,
  email,
  tempPassword = null,
  setPasswordUrl = "#",
  loginUrl = "#",
} = {}) {
  const first = firstNameOf(name);

  const passwordRow = tempPassword
    ? `
            <tr>
              <td style="padding:12px 0 0;font-size:13px;color:#64748b;font-family:${FONT}">Temporary password</td>
            </tr>
            <tr>
              <td style="padding:2px 0 4px;font-size:17px;font-weight:700;color:#0f172a;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;letter-spacing:.5px">${tempPassword}</td>
            </tr>`
    : "";

  // Steps differ slightly depending on whether a temp password was issued.
  const steps = tempPassword
    ? [
        "Click <strong>“Set Your Password”</strong> below to choose your own secure password (recommended).",
        "Or sign in straight away using the email and temporary password above.",
        "If you use the temporary password, please change it from <em>Settings &rarr; Security</em> after your first login.",
      ]
    : [
        "An account already exists for this email address.",
        "Click <strong>“Set / Reset Your Password”</strong> below to choose a new secure password.",
        "Then sign in with your email and the password you just set.",
      ];

  const stepList = steps
    .map(
      (s, i) => `
    <tr>
      <td style="padding:7px 12px 7px 0;vertical-align:top;width:26px">
        <span style="display:inline-block;width:24px;height:24px;border-radius:50%;background:#1e3a5f;color:#ffffff;font-size:12px;font-weight:700;line-height:24px;text-align:center;font-family:${FONT}">${i + 1}</span>
      </td>
      <td style="padding:7px 0;font-size:14px;line-height:1.6;color:#334155;font-family:${FONT}">${s}</td>
    </tr>`
    )
    .join("");

  const body = `
      <tr>
        <td class="px" style="padding:38px 40px 34px">
          <p style="margin:0 0 16px;font-size:17px;color:#1e293b;font-family:${FONT}">Hi <strong>${first}</strong>,</p>
          ${p(
            "Here are the details you'll need to access your Dooit account. Keep this email secure and never share your credentials with anyone."
          )}

          <!-- Credentials card -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin:0 0 24px">
            <tr><td style="padding:20px 24px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:0 0 0;font-size:13px;color:#64748b;font-family:${FONT}">Login email</td>
                </tr>
                <tr>
                  <td style="padding:2px 0 4px;font-size:15px;font-weight:700;color:#0f172a;font-family:${FONT};word-break:break-all">${email || ""}</td>
                </tr>
                ${passwordRow}
              </table>
            </td></tr>
          </table>

          <!-- Primary CTA: set/reset password -->
          ${ctaButton(setPasswordUrl, tempPassword ? "Set Your Password" : "Set / Reset Your Password")}
          <p style="margin:10px 0 26px;text-align:center;font-size:12px;color:#94a3b8;font-family:${FONT}">This secure link is valid for <strong>24 hours</strong>.</p>

          <!-- How to get started -->
          <div style="background:#ffffff;border:1px solid #e8edf3;border-radius:12px;padding:16px 22px;margin:0 0 22px">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8;font-family:${FONT}">Getting started</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepList}</table>
          </div>

          <!-- Fallback link -->
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin:0 0 16px">
            <p style="margin:0 0 6px;font-size:12px;color:#64748b;font-family:${FONT}">Button not working? Copy and paste this link into your browser:</p>
            <a href="${setPasswordUrl}" style="color:#2563eb;font-size:12px;word-break:break-all;font-family:${FONT}">${setPasswordUrl}</a>
          </div>

          <!-- Security note -->
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 18px">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#991b1b;font-family:${FONT}">
              &#128274; Dooit will never ask for your password by email or phone. If you didn't expect this
              account, please contact our support team immediately.
            </p>
          </div>

          <p style="margin:22px 0 0;text-align:center;font-size:13px;color:#94a3b8;font-family:${FONT}">
            Prefer to sign in first? <a href="${loginUrl}" style="color:#2563eb;font-weight:600">Go to the login page &rarr;</a>
          </p>
        </td>
      </tr>`;

  return shell({
    title: "Your Dooit Login Details",
    preview: "Your Dooit login details and password-setup instructions inside.",
    cardRows:
      brandHeader({
        icon: "&#128273;", // key
        title: "Your Login Details",
        subtitle: "Access your Dooit account",
      }) +
      body +
      brandFooter("This is a security email — please do not reply."),
  });
}

module.exports = { clientWelcomeHtml, clientCredentialsHtml };
