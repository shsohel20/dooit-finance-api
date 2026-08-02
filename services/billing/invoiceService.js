// services/billing/invoiceService.js
//
// The close job: turn a period's usage into an invoice.
//
// ── MODEL B ──────────────────────────────────────────────────────────────────
// The base fee buys a QUOTA OF APPLICANTS. Usage of products the plan entitles
// is covered by that quota and bills nothing; only applicants beyond the
// allowance bill, at the plan's overage price.
//
// This is the decision that unblocked §15.1 of schema-design.md. It has one
// consequence worth stating plainly, because it inverts the naive reading:
//
//   entitled product usage produces ZERO-AMOUNT invoice lines.
//
// They are still written, so the invoice shows what was consumed ("430 ID
// verifications — included"), but they contribute nothing to the subtotal. The
// customer already paid for them in the base fee; billing them again would
// double-charge.
//
// ── The two other money rules ────────────────────────────────────────────────
// UNENTITLED usage is charged at list price, per event, and never touches the
// applicant allowance. Each of these products costs dooit real money to serve,
// so serving them free is a straight loss; charging them per use also means a
// customer is never blocked partway through verifying a real applicant.
//
// A NEGOTIATED DISCOUNT is read from the subscription, not the price snapshot,
// because it must stay renegotiable. Each invoice copies the discount it
// applied into its own lines, so history is still reproducible.
//
// Reference: docs/billingmodule/schema-design.md §15.1, §15.6

const Invoice = require("../../models/Invoice");
const UsageRecord = require("../../models/UsageRecord");
const { toDecimal, toNumber } = require("../../utils/money");
const { nextSequence } = require("../../utils/sequence");
const { periodKeysFor } = require("./usageService");

/** Round once, at the line total — never per event (§15.6). */
const money2 = (n) => toDecimal(Number(n).toFixed(2));

/**
 * Price a quantity through a graduated tier ladder.
 *
 * Each band is priced separately (the ladder's `discountPercent` column is
 * display only — the band's unitPrice is authoritative). Accumulate in full
 * precision and round ONCE at the end; rounding per band drifts.
 */
function priceThroughTiers(quantity, tiers, fallbackUnitPrice) {
  if (!tiers?.length) {
    return { amount: quantity * toNumber(fallbackUnitPrice), bands: [] };
  }

  const sorted = [...tiers].sort((a, b) => a.from - b.from);
  let remaining = quantity;
  let total = 0;
  const bands = [];

  // A band's size is the distance from the PREVIOUS band's ceiling — not
  // `to - from + 1`.
  //
  // The ladder "0–1,000 / 1,001–10,000" describes cumulative thresholds: the
  // first 1,000 units, then the next 9,000. Treating the first band as
  // inclusive on both ends gives it 1,001 units and shifts every band after it,
  // overcharging by one unit per band (5,200 units priced A$3,772.08 instead of
  // A$3,772.00). Measuring from the previous ceiling is both correct and
  // simpler — `from` is presentation, `to` is the real boundary.
  let previousCeiling = 0;

  for (const t of sorted) {
    if (remaining <= 0) break;
    const ceiling = t.to == null ? Infinity : t.to;
    const bandSize = ceiling - previousCeiling;
    const take = Math.min(remaining, bandSize);
    if (take <= 0) continue;

    const unit = toNumber(t.unitPrice);
    total += take * unit;
    bands.push({ from: t.from, to: t.to, quantity: take, unitPrice: unit });

    remaining -= take;
    previousCeiling = ceiling;
  }

  // Anything past the last band falls back to the flat overage price.
  if (remaining > 0) {
    const unit = toNumber(fallbackUnitPrice);
    total += remaining * unit;
    bands.push({ from: previousCeiling, to: null, quantity: remaining, unitPrice: unit });
  }

  return { amount: total, bands };
}

/**
 * Resolve a subscription's negotiated discount against a subtotal.
 *
 * @param {Object} discount  the subscription's discount sub-document
 * @param {Number} subtotal
 * @returns {{ amount, label, type, value }}  amount is POSITIVE money to deduct
 */
function computeDiscount(discount, subtotal) {
  const type = discount?.type || "none";
  const value = toNumber(discount?.value ?? 0);
  const none = { amount: 0, label: null, type: "none", value: 0 };

  if (type === "none" || value <= 0 || subtotal <= 0) return none;

  if (type === "percentage") {
    // Guard the range here as well as in the controller: this function is also
    // reached by the renewal job, which does not go through request validation.
    const pct = Math.min(100, value);
    return {
      amount: +((subtotal * pct) / 100).toFixed(2),
      label: `Discount — ${pct}%${discount.reason ? ` (${discount.reason})` : ""}`,
      type,
      value: pct,
    };
  }

  // Fixed: capped at the subtotal so an invoice can never go negative. A
  // standing A$500 credit against a A$300 month must not produce a A$200
  // liability to the customer — that is a credit note, a different document.
  const amount = Math.min(value, subtotal);
  return {
    amount: +amount.toFixed(2),
    label: `Discount${discount.reason ? ` — ${discount.reason}` : ""}`,
    type,
    value,
  };
}

/**
 * Assemble the line items and totals for one subscription's period.
 *
 * Pure: reads usage, returns a plain object. Persisting and numbering are the
 * controller's job, so this can be dry-run for a preview without writing.
 *
 * @param {Object} subscription  a Subscription document
 * @param {String} periodKey     '2026-07'
 * @param {Object} opts          { taxRatePercent }
 */
async function buildInvoiceDraft(subscription, periodKey, { taxRatePercent = 0 } = {}) {
  const snap = subscription.priceSnapshot;

  // Entitled usage for this period that no invoice has claimed yet. Unentitled
  // usage is fetched separately below and priced by a different rule.
  const records = await UsageRecord.find({
    subscription: subscription._id,
    periodKey,
    status: "recorded",
    invoice: null,
  }).lean();

  // Late arrivals from ALREADY-CLOSED periods ride along on this invoice as
  // adjustments, rather than being rejected at ingest (§15.4).
  // Both statuses: an unentitled late arrival is chargeable like any other
  // unentitled usage, and matching only `recorded` would let it escape billing
  // entirely — the current-period sweep below is keyed to one periodKey and
  // would never see it.
  const lateRecords = await UsageRecord.find({
    subscription: subscription._id,
    periodKey: { $lt: periodKey },
    status: { $in: ["recorded", "excluded"] },
    invoice: null,
    isLate: true,
  }).lean();

  // Usage of products the plan does not entitle — CHARGED, at list price.
  //
  // These products each cost dooit real money to serve (DVS is a government
  // API, screening is a vendor), so leaving them free bills nothing for a call
  // that was actually paid for. They are pay-as-you-go instead: the customer is
  // never blocked mid-onboarding, and the charge appears as its own line.
  //
  // `status: 'excluded'` means "outside the plan, not yet invoiced" — the
  // unentitled counterpart of `recorded`. Once claimed below it becomes
  // `billed` like any other record; `exclusionReason` is what durably marks it
  // as having been outside the agreement, and it survives that transition.
  const excludedRecords = await UsageRecord.find({
    subscription: subscription._id,
    periodKey,
    status: "excluded",
    invoice: null,
  }).lean();

  const lines = [];
  let order = 0;
  const push = (l) => lines.push({ ...l, order: order++ });

  // ── 1. Base fee ──────────────────────────────────────────────────────────
  const basePrice = toNumber(snap.basePrice);
  if (basePrice > 0) {
    push({
      lineType: "base",
      description: `${snap.planName} plan — base fee`,
      quantity: 1,
      unitPrice: snap.basePrice,
      amount: money2(basePrice),
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
    });
  }

  // ── 2. Entitled usage — shown, but INCLUDED (Model B) ────────────────────
  const entitledCodes = new Set(
    (snap.products || []).filter((p) => p.enabled).map((p) => p.code)
  );

  /** Roll a record set up per product, keeping the first record's display fields. */
  const groupByProduct = (rows) => {
    const out = new Map();
    for (const r of rows) {
      const k = r.productCode;
      if (!out.has(k)) out.set(k, { ...r, quantity: 0, events: 0, amount: 0 });
      const agg = out.get(k);
      agg.quantity += r.quantity;
      agg.events += 1;
      agg.amount += toNumber(r.amount);
    }
    return out;
  };

  const byProduct = groupByProduct(records);

  for (const [code, agg] of byProduct) {
    const included = entitledCodes.has(code);
    push({
      lineType: "usage",
      product: agg.product,
      productCode: code,
      description: included
        ? `${agg.productName} — ${agg.quantity.toLocaleString("en-AU")} ${agg.unit}s (included)`
        : `${agg.productName} — ${agg.quantity.toLocaleString("en-AU")} ${agg.unit}s`,
      quantity: agg.quantity,
      unitPrice: agg.unitPrice,
      // Included usage is already paid for by the base fee.
      amount: included ? money2(0) : money2(agg.amount),
      isIncluded: included,
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
    });
  }

  // ── 2b. Non-entitled usage — CHARGED at list price ───────────────────────
  // The mirror image of the included lines above: same lineType, opposite
  // treatment. Included usage is shown at zero because the base fee bought it;
  // this is shown at its real cost because nothing bought it. `isExcluded` is
  // what lets the document say which of the two a zero-priced line is.
  for (const [code, agg] of groupByProduct(excludedRecords)) {
    push({
      lineType: "usage",
      product: agg.product,
      productCode: code,
      description:
        `${agg.productName} — ${agg.quantity.toLocaleString("en-AU")} ${agg.unit}s ` +
        `(Excluded)`,
      quantity: agg.quantity,
      unitPrice: agg.unitPrice,
      amount: money2(agg.amount),
      isExcluded: true,
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
    });
  }

  // ── 3. Applicant overage ─────────────────────────────────────────────────
  // The allowance is denominated in DISTINCT applicants: one applicant running
  // several checks consumes it once (§15.1).
  const applicantKeys = await UsageRecord.distinct("applicantKey", {
    subscription: subscription._id,
    periodKey,
    status: { $in: ["recorded", "billed"] },
    applicantKey: { $ne: null },
  });

  const used = applicantKeys.length;
  const included = snap.includedUsage ?? null;
  const overage = included == null ? 0 : Math.max(0, used - included);

  if (overage > 0) {
    const { amount, bands } = priceThroughTiers(overage, snap.tiers, snap.overagePrice);
    push({
      lineType: "overage",
      description:
        `${overage.toLocaleString("en-AU")} ${snap.includedUnit}s over the ` +
        `${included.toLocaleString("en-AU")} included` +
        (bands.length > 1 ? ` (${bands.length} tier bands)` : ""),
      quantity: overage,
      unitPrice: snap.overagePrice,
      amount: money2(amount),
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
    });
  }

  // ── 4. Late usage from closed periods ────────────────────────────────────
  if (lateRecords.length) {
    // Only the unentitled ones carry money. An entitled late arrival was
    // already paid for by the base fee of the period it belongs to, so it is
    // reported but not charged — same rule as the current period.
    const lateTotal = lateRecords
      .filter((r) => !entitledCodes.has(r.productCode))
      .reduce((s, r) => s + toNumber(r.amount), 0);
    const periods = [...new Set(lateRecords.map((r) => r.periodKey))].sort();
    push({
      lineType: "adjustment",
      description: `Late usage from ${periods.join(", ")} — ${lateRecords.length} record(s)`,
      quantity: lateRecords.length,
      amount: money2(lateTotal),
    });
  }

  // ── 5. Totals ────────────────────────────────────────────────────────────
  // Subtotal is the sum of ALREADY-ROUNDED line totals, so the invoice always
  // foots against its own lines.
  const subtotal = lines
    .filter((l) => !["discount", "tax"].includes(l.lineType))
    .reduce((s, l) => s + toNumber(l.amount), 0);

  // ── 6. Negotiated discount ───────────────────────────────────────────────
  // Read from the SUBSCRIPTION, not the snapshot — it is a renegotiable term
  // (see DISCOUNT_TYPES). It is copied onto this invoice as a line, so editing
  // the subscription later cannot rewrite what was already billed.
  //
  // Applied to the whole subtotal rather than the base fee alone: a customer
  // told "15% off" reasonably expects it against what they are charged, and
  // discounting only the base would quietly exclude their overage.
  //
  // Tier "discountPercent" is a different thing entirely — that is display for
  // a ladder whose band prices are already discounted, and it is not summed here.
  const discountInfo = computeDiscount(subscription.discount, subtotal);
  const discount = discountInfo.amount;

  if (discount > 0) {
    push({
      lineType: "discount",
      description: discountInfo.label,
      quantity: null,
      unitPrice: null,
      // POSITIVE, like every other line. The sign lives in the arithmetic
      // below and in how a `discount` line is rendered — storing it negative
      // would break the nonNegative validator on Invoice.discount and make the
      // line-vs-total reconciliation depend on remembering which lines subtract.
      amount: money2(discount),
    });
  }

  const tax = +(((subtotal - discount) * taxRatePercent) / 100).toFixed(2);
  const total = +(subtotal - discount + tax).toFixed(2);

  return {
    lineItems: lines,
    subtotal: money2(subtotal),
    discount: money2(discount),
    taxRatePercent,
    tax: money2(tax),
    total: money2(total),
    amountPaid: money2(0),
    amountDue: money2(total),
    allowance: {
      unit: snap.includedUnit,
      included,
      used,
      overage,
      overageUnitPrice: snap.overagePrice,
    },
    // Copied onto the invoice so the concession that produced this total is
    // legible from the document alone, years after the subscription's discount
    // has been changed or removed.
    discountApplied: {
      type: discountInfo.type,
      value: discountInfo.value,
      reason: subscription.discount?.reason || null,
    },
    planSnapshot: {
      plan: subscription.plan,
      planCode: snap.planCode,
      planName: snap.planName,
      planVersion: snap.planVersion,
    },
    // ids the caller must stamp once the invoice is persisted.
    // Excluded records are claimed too, now that they are charged — leaving
    // them unstamped would re-bill the same events on every subsequent close.
    _usageIds: [...records, ...lateRecords, ...excludedRecords].map((r) => r._id),
  };
}

/** Period bounds for a '2026-07' key, in the account's timezone. */
function periodBounds(periodKey) {
  const [y, m] = periodKey.split("-").map(Number);
  return {
    periodStart: new Date(Date.UTC(y, m - 1, 1)),
    periodEnd: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)),
  };
}

/** INV-2026-0072 — year-scoped, allocated only at issue time. */
async function allocateInvoiceNumber(date = new Date()) {
  const year = date.getFullYear();
  const seq = await nextSequence(`invoice_${year}`);
  return `INV-${year}-${String(seq).padStart(4, "0")}`;
}

/**
 * Close a period: persist the draft invoice and stamp the usage it consumed.
 *
 * Lives here rather than in the controller because BOTH the manual
 * `POST /invoice/close` and the renewal job must close a period the same way.
 * Two implementations of "what did this period bill" is precisely how an
 * invoice and its own line items end up disagreeing.
 *
 * Idempotent by construction. The unique index on {subscription, periodKey}
 * (excluding voided) is the real guard — a retried job racing the endpoint
 * loses the insert with E11000 rather than issuing a second invoice, and that
 * is reported back as `alreadyClosed` instead of thrown. Checking first and
 * inserting after would leave a window between the two.
 *
 * @param {Object} subscription  a Subscription document
 * @param {String} periodKey     '2026-07'
 * @param {Object} opts          { taxRatePercent, closedBy }
 * @returns {{ invoice, usageBilled, alreadyClosed }}
 */
async function closeSubscriptionPeriod(
  subscription,
  periodKey,
  { taxRatePercent = 0, closedBy = null } = {}
) {
  const existing = await Invoice.findOne({
    subscription: subscription._id,
    periodKey,
    status: { $ne: "void" },
  });
  if (existing) return { invoice: existing, usageBilled: 0, alreadyClosed: true };

  const draft = await buildInvoiceDraft(subscription, periodKey, {
    taxRatePercent: Number(taxRatePercent) || 0,
  });
  const { _usageIds, ...fields } = draft;

  let invoice;
  try {
    invoice = await Invoice.create({
      user: subscription.user,
      client: subscription.client,
      subscription: subscription._id,
      status: "draft",
      periodKey,
      ...periodBounds(periodKey),
      currency: subscription.priceSnapshot?.currency || "AUD",
      ...fields,
      closedBy,
    });
  } catch (err) {
    // Lost the race against a concurrent close — the other writer's invoice is
    // authoritative and has already claimed this period's usage.
    if (err?.code === 11000) {
      const winner = await Invoice.findOne({
        subscription: subscription._id,
        periodKey,
        status: { $ne: "void" },
      });
      return { invoice: winner, usageBilled: 0, alreadyClosed: true };
    }
    throw err;
  }

  // Stamp the usage this invoice consumed. Done AFTER the invoice exists so a
  // failure leaves usage unbilled (recoverable) rather than orphaned.
  if (_usageIds.length) {
    await UsageRecord.updateMany(
      { _id: { $in: _usageIds } },
      { $set: { status: "billed", invoice: invoice._id, billedAt: new Date() } }
    );
  }

  return { invoice, usageBilled: _usageIds.length, alreadyClosed: false };
}

/**
 * Issue a draft — allocates the invoice number and sets the due date.
 *
 * Shared by the endpoint and the job for the same reason as the close step.
 * Mutates and saves the document it is given.
 */
async function issueInvoiceDoc(invoice, { dueDays = 14 } = {}) {
  if (invoice.status !== "draft") {
    const err = new Error(`A ${invoice.status} invoice cannot be issued`);
    err.statusCode = 409;
    throw err;
  }

  const issuedAt = new Date();
  invoice.invoiceNumber = await allocateInvoiceNumber(issuedAt);
  invoice.status = "open";
  invoice.issuedAt = issuedAt;
  invoice.dueAt = new Date(issuedAt.getTime() + (Number(dueDays) || 14) * 86400000);
  await invoice.save();

  return invoice;
}

/** Flag open invoices past their due date. Returns the count changed. */
async function sweepOverdueInvoices(now = new Date()) {
  const result = await Invoice.updateMany(
    { status: "open", dueAt: { $lt: now } },
    { $set: { status: "overdue" } }
  );
  return result.modifiedCount ?? 0;
}

module.exports = {
  buildInvoiceDraft,
  priceThroughTiers,
  computeDiscount,
  periodBounds,
  periodKeysFor,
  allocateInvoiceNumber,
  closeSubscriptionPeriod,
  issueInvoiceDoc,
  sweepOverdueInvoices,
};
