// services/billing/usageService.js
//
// Metering: period keys, price resolution and idempotency-key composition.
//
// All three exist here rather than in the controller because the invoice close
// job (step 5) and any internal meter producer will need exactly the same
// answers. Two implementations of "what does this event cost" is how an invoice
// and its own line items end up disagreeing.
//
// Reference: docs/billingmodule/schema-design.md §15.1–§15.3

const { toDecimal, toNumber } = require("../../utils/money");

// Until billing accounts exist (see schema-design.md §0.3), every account is
// billed on Australian eastern time — the tenant, the DVS integrations and the
// GST rules are all AU. Move this onto the account when that collection lands.
const BILLING_TIMEZONE = "Australia/Sydney";

/**
 * Local calendar keys for a moment, in the ACCOUNT's timezone.
 *
 * `occurredAt` is a UTC Date; deriving the keys from UTC is wrong for every
 * account in this system. Sydney is UTC+10, or +11 under daylight saving, so
 * 2026-07-31T23:30Z is 2026-08-01 locally — a different DAY and a different
 * MONTH. Derive from UTC and the July invoice quietly bills August usage while
 * the daily chart is offset by one at the boundary.
 *
 * Intl handles the DST transition; a hardcoded +10 would not.
 *
 * @returns {{ periodKey: string, dayKey: string }}  '2026-07', '2026-07-31'
 */
function periodKeysFor(date = new Date(), timeZone = BILLING_TIMEZONE) {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  return { periodKey: dayKey.slice(0, 7), dayKey };
}

/**
 * Compose an idempotency key.
 *
 * MUST include the product: one provider webhook (an applicant review) can be
 * billable under several products at once — ID document verification, liveness,
 * AML screening, DVS. Keyed on the bare provider id, the first insert wins and
 * every other product on that event is silently discarded as a duplicate.
 *
 * `ordinal` covers the legitimately repeated case: the same check run twice
 * within one provider event (a retried liveness capture, two documents in one
 * submission). Without it, a genuine second occurrence is swallowed by the same
 * guard that is meant to catch replays.
 */
function composeIdempotencyKey({ system = "internal", externalId, productCode, ordinal = 1 }) {
  if (!externalId) {
    throw new Error("externalId is required to compose an idempotency key");
  }
  if (!productCode) {
    throw new Error("productCode is required to compose an idempotency key");
  }
  return `${system}:${externalId}:${productCode}:${ordinal}`;
}

/**
 * What does this product cost for this subscriber, right now?
 *
 * Resolution order — the subscription's frozen snapshot first, the live product
 * only as a fallback. Reading the PLAN here would void the immutability
 * guarantee, which is why the plan is not a parameter.
 *
 *   1. priceSnapshot.products[].unitPrice   (the plan's override, frozen)
 *   2. product.defaultUnitPrice             (catalogue list price)
 *
 * A product the plan does not entitle is still metered — it is recorded and
 * priced, then flagged for exclusion by the caller (§6.2.2). Usage that was not
 * sold is a reconciliation question; deleting the evidence makes it
 * unanswerable.
 *
 * @returns {{ unitPrice, priceSource, entitled, entitlement }}
 */
function resolveUnitPrice(subscription, product) {
  const entitlement = (subscription?.priceSnapshot?.products || []).find(
    (p) => p.code === product.code
  );

  const entitled = !!entitlement && entitlement.enabled !== false;

  if (entitlement && entitlement.unitPrice != null) {
    return {
      unitPrice: entitlement.unitPrice,
      priceSource: "snapshot_override",
      entitled,
      entitlement,
    };
  }

  // billable:false products are metered and shown, charged at zero.
  if (product.billable === false) {
    return {
      unitPrice: toDecimal(0),
      priceSource: "zero_rated",
      entitled,
      entitlement,
    };
  }

  return {
    unitPrice: product.defaultUnitPrice,
    priceSource: "product_list",
    entitled,
    entitlement,
  };
}

/**
 * Line amount for a quantity at a unit price.
 *
 * Computed once, rounded once to 2dp. Rounding per-event and summing would
 * drift; the invoice line total is the rounding point (§15.6).
 */
function lineAmount(quantity, unitPrice) {
  const raw = Number(quantity || 0) * toNumber(unitPrice);
  return toDecimal(raw.toFixed(6));
}

/**
 * Is this event late — i.e. does it belong to a period already invoiced?
 *
 * A late arrival is never rejected (§15.4): webhook providers retry for hours,
 * and a redelivery after period close is normal operation. It is recorded with
 * its real usageDate and picked up on the NEXT invoice as an adjustment.
 */
function isLateArrival(periodKey, subscription) {
  const currentStart = subscription?.currentPeriodStart;
  if (!currentStart) return false;
  const { periodKey: currentPeriod } = periodKeysFor(currentStart);
  return periodKey < currentPeriod;
}

module.exports = {
  BILLING_TIMEZONE,
  periodKeysFor,
  composeIdempotencyKey,
  resolveUnitPrice,
  lineAmount,
  isLateArrival,
};
