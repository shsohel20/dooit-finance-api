"use strict";

/**
 * User account emails (sent from userController.createUser).
 *
 *   userWelcomeHtml({ name, email, tempPassword, userType, role, roleDescription,
 *                     clientName, clientLogoUrl, setPasswordUrl,
 *                     forgotPasswordUrl, loginUrl })
 *       — welcome + credentials email for a newly created user.
 *
 * The body adapts to the account's **user type** (which workspace they belong to)
 * and **role** (what they can do there). Roles are created dynamically by admins,
 * so anything not in ROLE_PROFILES falls back to the Role model's own
 * `description`, then to a generic profile — an unknown role never renders blank.
 *
 * When the user belongs to a client tenant, the header carries a Dooit + client
 * co-brand lockup and the copy names the organisation.
 *
 * Uses the shared cross-client branding in ./emailBranding.
 */

const {
  FONT,
  esc,
  brandHeader,
  brandFooter,
  shell,
} = require("./emailBranding");

const firstNameOf = (name) =>
  (name ? String(name).trim().split(/\s+/)[0] : "") || "there";

/** Normalise a role/userType key: "Compliance Officer" -> "compliance officer". */
const keyOf = (v) => String(v ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");

/** Title-case a raw role name for display: "aml analyst" -> "AML Analyst". */
const titleCase = (v) =>
  String(v ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w+/g, (w) =>
      // Keep known acronyms upper-cased.
      /^(aml|kyc|kyb|ctf|mlro|grc|it|hr)$/i.test(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    );

// ─────────────────────────────────────────────────────────────────────────────
// User-type profiles — which workspace the account belongs to.
// ─────────────────────────────────────────────────────────────────────────────
const USER_TYPE_PROFILES = {
  dooit: {
    label: "Platform",
    scopeLabel: "Platform",
    intro:
      "Your account has been created on the <strong>Dooit platform console</strong>, with oversight across the organisations you administer.",
  },
  client: {
    label: "Client Workspace",
    scopeLabel: "Organisation",
    intro:
      "Your account has been created in your organisation's <strong>Dooit compliance workspace</strong> — the shared platform for AML/CTF, due diligence and regulatory reporting.",
  },
  branch: {
    label: "Branch Workspace",
    scopeLabel: "Branch",
    intro:
      "Your account has been created in your branch's <strong>Dooit compliance workspace</strong>, scoped to the customers and cases handled at your branch.",
  },
  customer: {
    label: "Customer Portal",
    scopeLabel: "Organisation",
    intro:
      "Your account has been created on the <strong>Dooit customer portal</strong>, where you can submit and track your onboarding and verification details.",
  },
  user: {
    label: "Workspace",
    scopeLabel: "Organisation",
    intro:
      "Your account has been created on the <strong>Dooit compliance platform</strong>.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Role profiles — what the account can do. Keys are normalised role names.
// ─────────────────────────────────────────────────────────────────────────────
const ROLE_PROFILES = {
  admin: {
    headline: "You have <strong>administrator</strong> access",
    capabilities: [
      "Manage users, roles and permissions across the workspace",
      "Configure risk rules, workflows and organisation settings",
      "Access every case, customer record and compliance report",
      "Review audit trails and export regulatory reports",
    ],
  },
  manager: {
    headline: "You have <strong>manager</strong> access",
    capabilities: [
      "Assign, review and sign off on cases across your team",
      "Monitor team workload, SLAs and escalation queues",
      "Approve customer risk ratings and onboarding decisions",
      "Generate management and compliance reports",
    ],
  },
  "compliance officer": {
    headline: "You have <strong>compliance officer</strong> access",
    capabilities: [
      "Review and approve customer due diligence and risk assessments",
      "Escalate, investigate and close AML alerts and cases",
      "Prepare and submit regulatory reports (SMR / SAR)",
      "Maintain the risk register and compliance documentation",
    ],
  },
  compliance: {
    headline: "You have <strong>compliance</strong> access",
    capabilities: [
      "Review customer due diligence and risk assessments",
      "Investigate and resolve AML alerts and cases",
      "Contribute to regulatory reporting and record keeping",
    ],
  },
  mlro: {
    headline: "You are registered as the <strong>MLRO</strong>",
    capabilities: [
      "Act as the reporting officer for suspicious matter reports",
      "Approve escalations and final case dispositions",
      "Oversee the organisation's AML/CTF programme and risk appetite",
      "Access full audit trails and regulator-ready reporting",
    ],
  },
  analyst: {
    headline: "You have <strong>analyst</strong> access",
    capabilities: [
      "Work assigned cases and alerts through to resolution",
      "Run KYC/KYB checks, sanctions, PEP and adverse-media screening",
      "Document findings and supporting evidence on each case",
      "Escalate high-risk matters for compliance review",
    ],
  },
  auditor: {
    headline: "You have <strong>auditor</strong> access",
    capabilities: [
      "Read-only access to cases, decisions and supporting evidence",
      "Review complete audit trails and change history",
      "Export records and reports for independent review",
    ],
  },
  viewer: {
    headline: "You have <strong>read-only</strong> access",
    capabilities: [
      "View cases, customers and reports shared with you",
      "Export permitted records for reference",
    ],
  },
  user: {
    headline: "Your access has been set up",
    capabilities: [
      "Access the areas of the workspace assigned to your role",
      "Work the cases and records allocated to you",
      "Update your profile and security settings at any time",
    ],
  },
};

/**
 * Resolve the role block. Falls back through: known profile → the Role model's
 * own description → generic profile, so admin-created roles always render.
 */
function resolveRoleProfile(role, roleDescription) {
  const key = keyOf(role);
  if (ROLE_PROFILES[key]) return ROLE_PROFILES[key];

  // Loose match so "senior aml analyst" still resolves to the analyst profile.
  const loose = Object.keys(ROLE_PROFILES).find(
    (k) => k !== "user" && key.includes(k)
  );
  if (loose) return ROLE_PROFILES[loose];

  if (roleDescription) {
    return {
      headline: `You have been assigned the <strong>${esc(titleCase(role))}</strong> role`,
      capabilities: [esc(roleDescription)],
    };
  }
  return ROLE_PROFILES.user;
}

// ── Small inline-styled building blocks ──────────────────────────────────────
const p = (html, extra = "") =>
  `<p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#475569;font-family:${FONT};${extra}">${html}</p>`;

const capability = (text) => `
  <tr>
    <td style="padding:9px 0;vertical-align:top;width:30px">
      <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#eff6ff;color:#2563eb;font-size:12px;line-height:22px;text-align:center;font-weight:700">&#10003;</span>
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

/** Label/value row inside the account-summary card. */
const detailRow = (label, value, mono = false) => `
    <tr>
      <td style="padding:9px 0;font-size:13px;color:#64748b;font-family:${FONT};white-space:nowrap;vertical-align:top">${label}</td>
      <td style="padding:9px 0 9px 18px;font-size:14px;font-weight:700;color:#0f172a;text-align:right;word-break:break-word;font-family:${
        mono
          ? "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace"
          : FONT
      }">${value}</td>
    </tr>`;

/** Small pill used for the role / user-type badges. */
const pill = (text) =>
  `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:12px;font-weight:700;font-family:${FONT}">${text}</span>`;

// ─────────────────────────────────────────────────────────────────────────────
// Welcome + credentials email
// ─────────────────────────────────────────────────────────────────────────────
function userWelcomeHtml({
  name,
  email,
  tempPassword = null,
  userType = "user",
  role = "user",
  roleDescription = "",
  clientName = "",
  clientLogoUrl = "",
  setPasswordUrl = "",
  forgotPasswordUrl = "",
  loginUrl = "#",
} = {}) {
  const first = firstNameOf(name);
  const typeProfile =
    USER_TYPE_PROFILES[keyOf(userType)] || USER_TYPE_PROFILES.user;
  const roleProfile = resolveRoleProfile(role, roleDescription);

  const roleLabel = titleCase(role) || "User";
  const orgName = clientName ? esc(clientName) : "";
  const coBrand = clientName ? { name: clientName, logoUrl: clientLogoUrl } : null;

  // Password row is omitted when the account already existed (no temp password).
  const passwordRow = tempPassword
    ? detailRow("Temporary password", esc(tempPassword), true)
    : "";

  const capabilities = roleProfile.capabilities.map(capability).join("");

  const body = `
      <tr>
        <td class="px" style="padding:38px 40px 34px">
          <p style="margin:0 0 16px;font-size:17px;color:#1e293b;font-family:${FONT}">Hi <strong>${esc(
            first
          )}</strong>,</p>
          ${p(
            orgName
              ? `${typeProfile.intro.replace(
                  "your organisation's",
                  `<strong>${orgName}</strong>'s`
                )}`
              : typeProfile.intro
          )}

          <!-- Role / access badges -->
          <div style="margin:0 0 24px">
            ${pill(esc(roleLabel))}&nbsp;${pill(esc(typeProfile.label))}
          </div>

          <!-- Account summary -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin:0 0 24px">
            <tr><td style="padding:8px 24px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${orgName ? detailRow(typeProfile.scopeLabel, orgName) : ""}
                ${detailRow("Role", esc(roleLabel))}
                ${detailRow("Login email", esc(email || ""), true)}
                ${passwordRow}
              </table>
            </td></tr>
          </table>

          ${
            tempPassword
              ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin:0 0 26px">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#92400e;font-family:${FONT}">
              &#9888; This is a <strong>temporary password</strong>. Please sign in and change it straight away from
              <em>Settings &rarr; Security</em>. Never share your credentials with anyone.
            </p>
          </div>`
              : ""
          }

          <!-- Primary CTA -->
          ${ctaButton(
            setPasswordUrl || loginUrl,
            setPasswordUrl ? "Set Your Password" : "Sign In to Dooit &rarr;"
          )}
          ${
            setPasswordUrl
              ? `<p style="margin:10px 0 26px;text-align:center;font-size:12px;color:#94a3b8;font-family:${FONT}">This secure link is valid for <strong>24 hours</strong>.</p>`
              : `<p style="margin:10px 0 26px;text-align:center;font-size:12px;color:#94a3b8;font-family:${FONT}">&nbsp;</p>`
          }

          <!-- Role-specific capabilities -->
          <div style="background:#ffffff;border:1px solid #e8edf3;border-radius:12px;padding:16px 22px;margin:0 0 22px">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8;font-family:${FONT}">What you can do</p>
            <p style="margin:0 0 6px;font-size:14px;color:#334155;font-family:${FONT}">${roleProfile.headline}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${capabilities}</table>
          </div>

          <!-- Forgot password -->
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px 22px;margin:0 0 22px">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94a3b8;font-family:${FONT}">Forgot your password?</p>
            <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#334155;font-family:${FONT}">
              If your temporary password stops working or this link expires, you can reset it yourself at any
              time &mdash; no need to contact an administrator.
            </p>
            <a href="${
              forgotPasswordUrl || loginUrl
            }" style="display:inline-block;font-size:14px;font-weight:600;color:#2563eb;font-family:${FONT}">Reset my password &rarr;</a>
          </div>

          ${
            setPasswordUrl
              ? `<!-- Fallback link -->
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin:0 0 16px">
            <p style="margin:0 0 6px;font-size:12px;color:#64748b;font-family:${FONT}">Button not working? Copy and paste this link into your browser:</p>
            <a href="${setPasswordUrl}" style="color:#2563eb;font-size:12px;word-break:break-all;font-family:${FONT}">${setPasswordUrl}</a>
          </div>`
              : ""
          }

          <!-- Security note -->
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 18px">
            <p style="margin:0;font-size:13px;line-height:1.6;color:#991b1b;font-family:${FONT}">
              &#128274; Dooit will never ask for your password by email or phone. If you weren't expecting this
              account, please contact our support team immediately.
            </p>
          </div>

          <p style="margin:22px 0 0;text-align:center;font-size:13px;color:#94a3b8;font-family:${FONT}">
            <a href="${loginUrl}" style="color:#2563eb;font-weight:600">Go to the login page &rarr;</a>
          </p>
        </td>
      </tr>`;

  return shell({
    title: orgName ? `Your ${clientName} Dooit Account` : "Your Dooit Account",
    preview: `Your ${roleLabel} account is ready — login details and password setup inside.`,
    cardRows:
      brandHeader({
        icon: "&#128273;", // key
        title: "Your Account Is Ready",
        subtitle: orgName
          ? `${roleLabel} access to ${clientName} on Dooit`
          : `${roleLabel} access to your Dooit workspace`,
        coBrand,
      }) +
      body +
      brandFooter("This is a security email — please do not reply."),
  });
}

module.exports = { userWelcomeHtml, USER_TYPE_PROFILES, ROLE_PROFILES };
