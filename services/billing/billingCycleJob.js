"use strict";

// services/billing/billingCycleJob.js
//
// The billing cycle sweep — what turns `nextInvoiceAt` from a stored date into
// an actual invoice.
//
// Before this existed, `nextInvoiceAt` was written on subscribe and change-plan
// (subscriptionController.js:182, :269) and read by nothing: the field and its
// index were there, but no period ever closed by itself. Two things followed
// from that, both silent:
//
//   1. A subscription's period never rolled forward. Once currentPeriodEnd
//      passed, the subscription sat expired-in-fact but `active` in the data,
//      and its usage accumulated against a period that had already ended.
//   2. `cancelAtPeriodEnd` never took effect. cancelSubscription() sets the
//      flag and leaves status 'active' "until the period actually ends"
//      (subscriptionController.js:318) — but nothing ended it, so a cancelled
//      subscription renewed forever.
//
// No queue/cron dependency: started from server.js as a setInterval sweep, the
// same shape as utils/craReviewNotifications.js. Hourly, because the work is
// gated on `nextInvoiceAt <= now` rather than on the sweep's own cadence — a
// missed or late tick delays an invoice, it never skips one.
//
// ── Safety ───────────────────────────────────────────────────────────────────
// The sweep is idempotent and safe to run on several app instances at once.
// closeSubscriptionPeriod() leans on the unique index on
// {subscription, periodKey} (excluding voided) rather than a check-then-insert,
// so a second instance loses the race with E11000 and reports `alreadyClosed`
// instead of issuing a duplicate invoice.
//
// ── Auto-issue is OFF by default ─────────────────────────────────────────────
// The sweep produces DRAFT invoices. Issuing allocates a number from a
// deliberately gapless sequence (invoiceService.allocateInvoiceNumber) and is
// customer-visible, so an automatic issue of a wrong invoice burns a number
// permanently and has to be voided rather than deleted. Set
// BILLING_AUTO_ISSUE=true once a deployment trusts the rating output.
//
// Reference: docs/billingmodule/mongoose-schema.md §B.4, schema-design.md §15.4

const Subscription = require("../../models/Subscription");
const {
  closeSubscriptionPeriod,
  issueInvoiceDoc,
  sweepOverdueInvoices,
} = require("./invoiceService");
const { periodKeysFor } = require("./usageService");
const { periodEndFor } = require("./subscriptionService");
const { sweepDunning } = require("./invoiceDunning");

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const INITIAL_DELAY_MS = 60 * 1000; // let DB connect / server settle

const autoIssueEnabled = () =>
  String(process.env.BILLING_AUTO_ISSUE || "").toLowerCase() === "true";

const taxRatePercent = () => Number(process.env.BILLING_TAX_RATE_PERCENT) || 0;

const invoiceDueDays = () => Number(process.env.BILLING_INVOICE_DUE_DAYS) || 14;

/**
 * Close and roll one subscription forward.
 *
 * The period being billed is the one containing `currentPeriodStart` — NOT the
 * month the sweep happens to run in. A sweep that fires on 1 August for a
 * period that ended 31 July must bill July, and `periodKeysFor` derives that
 * key in the account's timezone for the same reason the meter does
 * (usageService.js:32): a UTC-derived key bills late-July usage as August.
 *
 * @returns {String} what happened — 'invoiced' | 'ended' | 'already-closed'
 */
async function advanceSubscription(sub, now = new Date()) {
  const { periodKey } = periodKeysFor(sub.currentPeriodStart);

  const { invoice, alreadyClosed } = await closeSubscriptionPeriod(sub, periodKey, {
    taxRatePercent: taxRatePercent(),
    closedBy: null, // system-closed; a human close stamps the actor
  });

  if (invoice && invoice.status === "draft" && autoIssueEnabled()) {
    await issueInvoiceDoc(invoice, { dueDays: invoiceDueDays() });
  }

  // A subscription cancelled at period end is billed for the period it just
  // used, then ended. Cancelling never erases usage already incurred, which is
  // why the invoice above is produced first regardless.
  if (sub.cancelAtPeriodEnd) {
    sub.status = "expired";
    sub.endedAt = now;
    sub.nextInvoiceAt = null;
    await sub.save();
    return "ended";
  }

  // Roll forward from the period that just ended, not from `now`. Anchoring to
  // now would let a late sweep drift the customer's billing date later every
  // cycle.
  const nextStart = sub.currentPeriodEnd || now;
  const nextEnd = periodEndFor(sub.priceSnapshot?.billingCycle, nextStart);

  sub.currentPeriodStart = nextStart;
  sub.currentPeriodEnd = nextEnd;
  sub.nextInvoiceAt = nextEnd;
  await sub.save();

  return alreadyClosed ? "already-closed" : "invoiced";
}

/**
 * One sweep: renew every subscription whose period has ended, then flag
 * overdue invoices.
 *
 * Only `active` subscriptions renew. `paused` is excluded deliberately — a
 * paused account is not consuming cover, so billing it would be wrong — and
 * cancelled/expired ones have no next period.
 *
 * Returns counts for logging and tests.
 */
async function sweepBillingCycle(now = new Date()) {
  const due = await Subscription.find({
    status: "active",
    nextInvoiceAt: { $ne: null, $lte: now },
  });

  let invoiced = 0;
  let ended = 0;
  let alreadyClosed = 0;
  let failed = 0;

  for (const sub of due) {
    try {
      const outcome = await advanceSubscription(sub, now);
      if (outcome === "invoiced") invoiced++;
      else if (outcome === "ended") ended++;
      else alreadyClosed++;
    } catch (err) {
      // One bad subscription must not stop the rest of the run — the next
      // sweep retries it, and `nextInvoiceAt` is still in the past so nothing
      // is lost.
      failed++;
      console.error(
        `[BG] billing:cycle — subscription ${sub.uid || sub._id} failed ✗`.red,
        err.message
      );
    }
  }

  const markedOverdue = await sweepOverdueInvoices(now);

  // Dunning runs AFTER the overdue sweep, so an invoice that just crossed its
  // due date is chased on the same pass rather than waiting an hour.
  const dunning = await sweepDunning(now);

  return {
    scanned: due.length,
    invoiced,
    ended,
    alreadyClosed,
    failed,
    markedOverdue,
    reminded: dunning.reminded,
    remindersFailed: dunning.failed,
  };
}

/** Start the recurring sweep (called once from server.js). */
function startBillingCycleJob() {
  const run = async (label) => {
    try {
      const s = await sweepBillingCycle();
      console.log(
        `[BG] billing:cycle (${label}) — scanned ${s.scanned}, invoiced ${s.invoiced}, ` +
          `ended ${s.ended}, already-closed ${s.alreadyClosed}, failed ${s.failed}, ` +
          `overdue ${s.markedOverdue}, reminders ${s.reminded} (${s.remindersFailed} failed)` +
          `${autoIssueEnabled() ? "" : " [drafts only]"}`.cyan
      );
    } catch (err) {
      console.error(`[BG] billing:cycle (${label}) — failed ✗`.red, err.message);
    }
  };

  setTimeout(() => run("startup"), INITIAL_DELAY_MS).unref();
  setInterval(() => run("interval"), SWEEP_INTERVAL_MS).unref();
}

module.exports = { sweepBillingCycle, advanceSubscription, startBillingCycleJob };
