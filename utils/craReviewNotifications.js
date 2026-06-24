"use strict";

/**
 * CRA periodic-review notification sweep — CRA_Scoring_Method.md Section 4:
 * "On CRA completion: system auto-sets next_review_date = today + (3yr Low /
 *  2yr Med / 1yr High). CO reminded 30 days before due (N_020).
 *  Overdue → N_021 daily."
 *
 * N_020  CRA — Periodic Review Due      → once per assessment, ≤30 days out
 * N_021  CRA — Periodic Review Overdue  → daily while overdue
 *
 * In-app notifications only (AppNotification); rule metadata comes from
 * NotificationRule (seeded from seed/notification_rules.json) with safe
 * fallbacks so reminders still fire if the rules are not seeded.
 *
 * No queue/cron dependency — started from server.js as a setInterval sweep
 * (12-hourly; the daily dedupe keeps N_021 at one per day).
 */

const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const AppNotification = require("../models/AppNotification");
const NotificationRule = require("../models/NotificationRule");
const User = require("../models/User");
const UserType = require("../models/UserType");
const sendEmail = require("./sendEmail");

const DUE_SOON_DAYS = 30;
const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
const INITIAL_DELAY_MS = 60 * 1000;            // let DB connect / server settle

// Fallbacks if notification_rules are not seeded (urgency must fit the
// AppNotification enum Routine/Urgent/Critical)
const RULE_DEFAULTS = {
  N_020: { title: "CRA — Periodic Review Due", urgency: "Urgent", actionLabel: "Start CRA Review" },
  N_021: { title: "CRA — Periodic Review Overdue", urgency: "Critical", actionLabel: "Complete CRA Review Now" },
};

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

// Seeded rules carry the datasheet's raw urgency strings ("Action Required",
// "Overdue") — map anything outside the AppNotification enum to the default.
const VALID_URGENCY = new Set(["Routine", "Urgent", "Critical"]);

// Email recipients per rule (spec: N_020 → CO; N_021 → CO + Senior Manager).
// Confirmed against production data 12 Jun 2026: Compliance Officers carry
// role "officer", Senior Managers role "manager" (userType "client");
// "admin"/"client-admin" kept as fallback for clients without dedicated COs.
// Override per deployment via CRA_NOTIFY_ROLES_DUE / CRA_NOTIFY_ROLES_OVERDUE
// (comma-separated).
const DEFAULT_EMAIL_ROLES = {
  N_020: ["officer", "compliance-officer", "compliance", "co", "client-admin", "admin"],
  N_021: ["officer", "compliance-officer", "compliance", "co", "client-admin", "admin", "manager", "senior-manager"],
};

function emailRolesFor(ruleId) {
  const env =
    ruleId === "N_021" ? process.env.CRA_NOTIFY_ROLES_OVERDUE : process.env.CRA_NOTIFY_ROLES_DUE;
  if (env) return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return DEFAULT_EMAIL_ROLES[ruleId] || [];
}

/** AES-256-GCM ciphertext format used by roleEncryptionPlugin */
function looksEncrypted(val) {
  if (!val || typeof val !== "string") return false;
  const parts = val.split(":");
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

/**
 * Resolve a user's plaintext email. User emails are encrypted at rest by
 * roleEncryptionPlugin, and Mongoose reads outside a request context mask
 * them to "***" — so callers must query via the NATIVE collection (bypassing
 * the plugin middleware) and decrypt here. Returns null when unusable.
 */
function resolveEmail(raw) {
  if (!raw || typeof raw !== "string") return null;
  if (looksEncrypted(raw)) {
    try {
      const { decrypt } = require("./encryption");
      const plain = decrypt(raw);
      return /@/.test(plain) ? plain : null;
    } catch {
      return null; // missing/invalid ENCRYPTION_KEY — skip rather than fail
    }
  }
  return /@/.test(raw) ? raw : null;
}

/**
 * Email the client's COs (spec channel "In-app + Email"). Skips silently when
 * SMTP isn't configured or the assessment has no client (standalone).
 * Failures never abort the sweep. Returns the number of emails sent.
 */
async function emailReviewNotification(ruleId, assessment, title, body, actionLabel) {
  if (!process.env.SMTP_EMAIL || !assessment.client) return 0;

  const roles = emailRolesFor(ruleId);

  // clientBelongs now lives on UserType, not User. Use native collection reads
  // so the encryption plugin (which requires a request context) is bypassed.
  const memberships = await UserType.collection
    .find(
      { clientBelongs: assessment.client, isActive: true },
      { projection: { user: 1, role: 1 } },
    )
    .toArray();

  const targetUserIds = [
    ...new Set(
      memberships
        .filter((m) => roles.includes((m.role || "").toLowerCase()))
        .map((m) => m.user),
    ),
  ];

  if (!targetUserIds.length) return 0;

  // Native read bypasses roleEncryptionPlugin so we get raw ciphertext,
  // which resolveEmail() can decrypt directly.
  const users = await User.collection
    .find(
      { _id: { $in: targetUserIds }, isActive: { $ne: false } },
      { projection: { email: 1, name: 1 } },
    )
    .toArray();

  const recipients = users
    .map((u) => ({ name: u.name, email: resolveEmail(u.email) }))
    .filter((u) => u.email);

  const base = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
  const link = `${base}/cra/${assessment._id}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;padding:24px">
      <h2 style="color:#1F3864;margin:0 0 8px;font-size:18px">${title}</h2>
      <p style="color:#1a1a1a;font-size:13px;line-height:1.5">${body}</p>
      <p style="margin:20px 0">
        <a href="${link}" style="background:#1F3864;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:bold">${actionLabel}</a>
      </p>
      <p style="color:#888;font-size:11px;border-top:1px solid #eee;padding-top:12px">
        dooit.ai compliance notification (${ruleId}) — CRA periodic review schedule. Do not reply to this email.
      </p>
    </div>`;

  let sent = 0;
  for (const r of recipients) {
    try {
      await sendEmail({ email: r.email, subject: `[dooit] ${title}`, message: html });
      sent++;
    } catch (err) {
      console.error(`[BG] cra:reviewNotifications — email to ${r.name || r.email} failed:`.red, err.message);
    }
  }
  return sent;
}

async function dispatchReviewNotification(ruleId, assessment, body) {
  const rule = await NotificationRule.findOne({ notifId: ruleId }).lean();
  const def = RULE_DEFAULTS[ruleId];
  const title = rule?.notifName || def.title;
  const actionLabel = rule?.actionButtonLabel || def.actionLabel;

  await AppNotification.create({
    ruleId,
    client: assessment.client || null,
    title,
    body,
    urgency: VALID_URGENCY.has(rule?.urgency) ? rule.urgency : def.urgency,
    actionLabel,
    actionUrl: `/cra/${assessment._id}`,
    linkedRecord: assessment._id,
    linkedRecordType: "IndividualRiskAssessment",
  });

  // spec channel "In-app + Email" — same dedupe as the in-app entry, since
  // both fire from the same dispatch
  let emails = 0;
  try {
    emails = await emailReviewNotification(ruleId, assessment, title, body, actionLabel);
  } catch (err) {
    console.error(`[BG] cra:reviewNotifications — email dispatch failed:`.red, err.message);
  }
  return emails;
}

/**
 * One sweep over all assessments with a review date due within 30 days or
 * already overdue. Returns { dueSoon, overdue } counts for logging/tests.
 */
async function sweepCraReviewNotifications(now = new Date()) {
  const dueCutoff = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const candidates = await IndividualRiskAssessment.find({
    nextReviewDate: { $ne: null, $lte: dueCutoff },
    serviceBlocked: { $ne: true },
    ecddStatus: { $ne: "Declined" },
  })
    .select("customer customerName client riskLabel riskScore nextReviewDate createdAt")
    .lean();

  let dueSoon = 0;
  let overdue = 0;
  let emailsSent = 0;

  for (const a of candidates) {
    // a newer assessment for the same customer supersedes this one's review cycle
    if (a.customer) {
      const newer = await IndividualRiskAssessment.exists({
        customer: a.customer,
        createdAt: { $gt: a.createdAt },
      });
      if (newer) continue;
    }

    const name = a.customerName || "customer";

    if (a.nextReviewDate <= now) {
      // N_021 — daily while overdue
      const sentToday = await AppNotification.exists({
        ruleId: "N_021",
        linkedRecord: a._id,
        createdAt: { $gte: startOfDay },
      });
      if (sentToday) continue;
      emailsSent += await dispatchReviewNotification(
        "N_021",
        a,
        `CRA periodic review for ${name} (${a.riskLabel} risk) was due on ${fmtDate(a.nextReviewDate)} and has not been completed.`,
      );
      overdue++;
    } else {
      // N_020 — once per assessment
      const alreadySent = await AppNotification.exists({
        ruleId: "N_020",
        linkedRecord: a._id,
      });
      if (alreadySent) continue;
      emailsSent += await dispatchReviewNotification(
        "N_020",
        a,
        `CRA periodic review for ${name} (${a.riskLabel} risk) is due on ${fmtDate(a.nextReviewDate)}.`,
      );
      dueSoon++;
    }
  }

  return { dueSoon, overdue, emailsSent, scanned: candidates.length };
}

/** Start the recurring sweep (called once from server.js). */
function startCraReviewNotificationJob() {
  const run = async (label) => {
    try {
      const stats = await sweepCraReviewNotifications();
      console.log(
        `[BG] cra:reviewNotifications (${label}) — scanned ${stats.scanned}, N_020 sent ${stats.dueSoon}, N_021 sent ${stats.overdue}, emails ${stats.emailsSent}`.cyan,
      );
    } catch (err) {
      console.error(`[BG] cra:reviewNotifications (${label}) — failed ✗`.red, err.message);
    }
  };

  setTimeout(() => run("startup"), INITIAL_DELAY_MS).unref();
  setInterval(() => run("interval"), SWEEP_INTERVAL_MS).unref();
}

module.exports = { sweepCraReviewNotifications, startCraReviewNotificationJob };
