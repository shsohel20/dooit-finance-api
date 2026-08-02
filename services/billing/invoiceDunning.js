"use strict";

// services/billing/invoiceDunning.js
//
// Overdue reminders. Runs on the hourly billing sweep.
//
// ── The schedule is by DAYS PAST DUE, not by "how many have I sent" ──────────
// The sweep runs every hour, so a stage recorded only as a count would re-fire
// on every tick for a whole day. `dunning.lastStageDays` records WHICH step was
// last sent, and a step only fires when it is strictly greater than that — so
// each stage sends exactly once no matter how often the sweep runs, and a
// deployment that was down for a week catches up with one email rather than
// four.
//
// ── An invoice that was never sent is never chased ───────────────────────────
// Reminders require `sentAt`. Chasing someone for an invoice they were never
// given is both wrong and unanswerable — they cannot pay what they have not
// received. If a deployment issues invoices but never sends them, nothing is
// dunned, and that is the correct outcome rather than a gap.
//
// Configure with:
//   BILLING_DUNNING_ENABLED   'false' turns reminders off entirely
//   BILLING_DUNNING_SCHEDULE  days past due, comma-separated (default 1,7,14,30)

const Invoice = require("../../models/Invoice");
const { deliverInvoiceEmail, mailConfigured } = require("./invoiceMailer");
const { toNumber } = require("../../utils/money");

const DEFAULT_SCHEDULE = [1, 7, 14, 30];

const dunningEnabled = () =>
  String(process.env.BILLING_DUNNING_ENABLED ?? "true").toLowerCase() !== "false";

/** Parsed, de-duplicated, ascending. Junk entries are dropped, not guessed at. */
function dunningSchedule() {
  const raw = process.env.BILLING_DUNNING_SCHEDULE;
  if (!raw) return DEFAULT_SCHEDULE;

  const days = [
    ...new Set(
      String(raw)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0)
    ),
  ].sort((a, b) => a - b);

  return days.length ? days : DEFAULT_SCHEDULE;
}

const money = (v, currency = "AUD") =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(toNumber(v));

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }) : "—";

/** The banner rendered above the invoice itself. */
function reminderBanner(invoice, daysPastDue) {
  const overdue = daysPastDue === 1 ? "1 day" : `${daysPastDue} days`;
  return `
    <div style="max-width:660px;margin:0 auto 18px;padding:14px 16px;border-radius:10px;background:#fef3c7;border:1px solid #f59e0b40;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <div style="font-size:14px;font-weight:800;color:#92400e">Payment reminder</div>
      <div style="font-size:12.5px;color:#78350f;margin-top:5px;line-height:1.5">
        Invoice <strong>${invoice.invoiceNumber}</strong> for
        <strong>${money(invoice.amountDue, invoice.currency)}</strong>
        was due on <strong>${fmtDate(invoice.dueAt)}</strong> and is now ${overdue} overdue.
        If payment is already on its way, please ignore this message.
      </div>
    </div>`;
}

/** Whole days between `dueAt` and now. Negative before the due date. */
function daysPastDue(invoice, now = new Date()) {
  if (!invoice.dueAt) return null;
  return Math.floor((now.getTime() - new Date(invoice.dueAt).getTime()) / 86400000);
}

/**
 * The schedule step this invoice is due for, or null when none is.
 * Returns the HIGHEST step reached but not yet sent, so a long outage sends one
 * reminder rather than replaying the whole ladder.
 */
function nextStageFor(invoice, now = new Date()) {
  const past = daysPastDue(invoice, now);
  if (past == null || past < 0) return null;

  const sent = invoice.dunning?.lastStageDays ?? -1;
  const reached = dunningSchedule().filter((d) => d <= past && d > sent);
  return reached.length ? reached[reached.length - 1] : null;
}

/**
 * One dunning pass over every unpaid, already-delivered invoice.
 * Returns counts for logging and tests.
 */
async function sweepDunning(now = new Date()) {
  if (!dunningEnabled()) return { scanned: 0, reminded: 0, failed: 0, skipped: 0, disabled: true };
  if (!mailConfigured()) {
    return { scanned: 0, reminded: 0, failed: 0, skipped: 0, mailNotConfigured: true };
  }

  const candidates = await Invoice.find({
    status: { $in: ["open", "overdue"] },
    dueAt: { $ne: null, $lt: now },
    // Never chase an invoice the customer was not sent.
    sentAt: { $ne: null },
  });

  let reminded = 0;
  let failed = 0;
  let skipped = 0;

  for (const invoice of candidates) {
    // A partially paid invoice is still chased; a fully settled one is not,
    // whatever its status field happens to say.
    if (toNumber(invoice.amountDue) <= 0) {
      skipped += 1;
      continue;
    }

    const stage = nextStageFor(invoice, now);
    if (stage == null) {
      skipped += 1;
      continue;
    }

    try {
      const past = daysPastDue(invoice, now);
      await deliverInvoiceEmail(invoice, {
        subject: `Reminder: invoice ${invoice.invoiceNumber} is overdue`,
        introHtml: reminderBanner(invoice, past),
      });

      // Stamped only after the send succeeds — otherwise the record would show
      // a reminder the customer never received, and the stage would be burned.
      invoice.dunning = {
        lastStageDays: stage,
        lastRemindedAt: now,
        reminderCount: (invoice.dunning?.reminderCount || 0) + 1,
      };
      await invoice.save();
      reminded += 1;
    } catch (err) {
      // One undeliverable invoice must not stop the rest of the run. The stage
      // is not recorded, so the next sweep retries it.
      failed += 1;
      console.error(
        `[BG] billing:dunning — ${invoice.invoiceNumber || invoice._id} failed ✗`.red,
        err.message
      );
    }
  }

  return { scanned: candidates.length, reminded, failed, skipped };
}

module.exports = {
  sweepDunning,
  nextStageFor,
  daysPastDue,
  dunningSchedule,
  dunningEnabled,
};
