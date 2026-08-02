// services/billing/paymentService.js
//
// Reconciling an invoice against its payments.
//
// One function, in one place, because "what is still owed" must have exactly one
// answer. Computing it inline at each call site is how an invoice ends up
// disagreeing with its own payment history.
//
// Reference: docs/billingmodule/mongoose-schema.md §G.7, §G.10

const Payment = require("../../models/Payment");
const { toDecimal, toNumber } = require("../../utils/money");

/**
 * Recompute an invoice's paid/due figures from its settled payments and apply
 * the resulting status.
 *
 * Derived, never incremented: adding to a running total drifts the moment a
 * refund, a retry or a partial payment arrives out of order. Summing the
 * payments is idempotent and self-correcting.
 *
 * @param {Object} invoice  an Invoice document (mutated and saved)
 */
async function reconcileInvoice(invoice) {
  const payments = await Payment.find({
    invoice: invoice._id,
    status: { $in: ["paid", "refunded"] },
  }).lean();

  // A refunded payment still collected money at the time — what reverses it is
  // the refund document, so only `type` decides the direction.
  const collected = payments
    .filter((p) => p.type === "payment")
    .reduce((s, p) => s + toNumber(p.amount), 0);
  const refunded = payments
    .filter((p) => p.type === "refund")
    .reduce((s, p) => s + toNumber(p.amount), 0);

  const net = +(collected - refunded).toFixed(2);
  const total = toNumber(invoice.total);
  const due = +(total - net).toFixed(2);

  invoice.amountPaid = toDecimal(net.toFixed(2));
  invoice.amountDue = toDecimal(due.toFixed(2));

  // Status follows the money, not the other way round.
  if (invoice.status !== "void") {
    if (due <= 0 && total > 0) {
      invoice.status = "paid";
      invoice.paidAt = invoice.paidAt || new Date();
    } else if (due > 0) {
      // A refund can take a paid invoice back to open — and back to overdue if
      // it was already past its due date.
      const pastDue = invoice.dueAt && invoice.dueAt.getTime() < Date.now();
      invoice.status = pastDue ? "overdue" : "open";
      invoice.paidAt = null;
    }
  }

  await invoice.save();
  return { collected, refunded, net, due };
}

/**
 * How much of a payment has already been refunded.
 * Used to stop the sum of partial refunds exceeding what was collected.
 */
async function refundedTotalFor(paymentId) {
  const refunds = await Payment.find({
    refundOf: paymentId,
    type: "refund",
    status: { $in: ["paid", "refunded"] },
  }).lean();
  return refunds.reduce((s, r) => s + toNumber(r.amount), 0);
}

module.exports = { reconcileInvoice, refundedTotalFor };
