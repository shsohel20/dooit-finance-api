// services/billing/subscriptionService.js
//
// The two pieces of subscription logic that must exist in exactly one place:
//
//   buildPriceSnapshot()  — freezes a plan's commercials onto a subscription
//   canSubscribe()        — decides whether an account may buy a given plan
//
// Both are called from the controller AND will be called by the renewal cron, so
// duplicating either would eventually produce two different answers to
// "what does this customer pay".
//
// Reference: docs/billingmodule/mongoose-schema.md §7.5

const PlanEligibility = require("../../models/PlanEligibility");

/**
 * Copy a plan's commercials into the frozen snapshot the subscription bills from.
 *
 * Everything here is a COPY, not a reference. After this runs, the plan document
 * can be edited, versioned or archived without changing what this subscriber pays.
 *
 * @param {Object} plan  a BillingPlan document (or lean object)
 * @returns {Object} priceSnapshot
 */
function buildPriceSnapshot(plan) {
  return {
    planCode: plan.code,
    planName: plan.name,
    planVersion: plan.version,

    pricingModel: plan.pricingModel,
    billingCycle: plan.billingCycle,
    currency: plan.currency,

    basePrice: plan.basePrice,
    isCustomPriced: !!plan.isCustomPriced,

    includedUsage: plan.includedUsage ?? null,
    includedUnit: plan.includedUnit || "applicant",
    overagePrice: plan.overagePrice,
    annualDiscountPercent: plan.annualDiscountPercent || 0,

    // Deep-copied so a later mutation of the plan's arrays cannot reach in here.
    tiers: (plan.tiers || []).map((t) => ({
      from: t.from,
      to: t.to ?? null,
      unitPrice: t.unitPrice,
      discountPercent: t.discountPercent || 0,
    })),
    products: (plan.products || []).map((p) => ({
      productId: p.productId,
      code: p.code,
      name: p.name,
      unit: p.unit,
      enabled: p.enabled,
      includedQuantity: p.includedQuantity || 0,
      unitPrice: p.unitPrice ?? null,
      overagePrice: p.overagePrice ?? null,
      tiers: (p.tiers || []).map((t) => ({
        from: t.from,
        to: t.to ?? null,
        unitPrice: t.unitPrice,
        discountPercent: t.discountPercent || 0,
      })),
    })),

    seatsLabel: plan.seatsLabel ?? null,
    slaTarget: plan.slaTarget || "none",
    supportLevel: plan.supportLevel || "email",

    changePolicy: {
      allowUpgrade: plan.changePolicy?.allowUpgrade ?? true,
      allowDowngrade: plan.changePolicy?.allowDowngrade ?? true,
      allowCancel: plan.changePolicy?.allowCancel ?? true,
      cancelAtPeriodEnd: plan.changePolicy?.cancelAtPeriodEnd ?? true,
      minimumTermMonths: plan.changePolicy?.minimumTermMonths ?? 0,
    },

    snapshotAt: new Date(),
  };
}

/**
 * May this user buy this plan?
 *
 * Returns { ok: true } or { ok: false, reason } — a reason string rather than a
 * boolean, because the UI needs to say WHY the Subscribe button is unavailable.
 *
 * @param {Object} plan   BillingPlan document
 * @param {Object} opts   { userId, isDooit }
 */
async function canSubscribe(plan, { userId, isDooit = false } = {}) {
  if (!plan || plan.isDeleted) return { ok: false, reason: "Plan not found" };

  if (plan.status !== "published") {
    return { ok: false, reason: `A ${plan.status} plan cannot be subscribed to` };
  }

  // dooit may provision on a client's behalf, bypassing BOTH the quote-only
  // gate below and the visibility check — it is the party that grants access in
  // the first place, and it is the "sales" that a quote-only plan routes to.
  //
  // This check must stay ABOVE the quote-only gate. `selfServe` is defined on
  // the plan as "can a client subscribe unaided, or must dooit/sales provision
  // it?" (BillingPlan.js:161), so a plan marked selfServe:false is one that only
  // dooit can ever put someone on. Gating dooit on it too made every Enterprise
  // plan unsellable by anybody: the client is told to contact sales, and sales
  // then gets the same refusal.
  //
  // Note an assigned custom-priced plan snapshots basePrice 0 — the model zeroes
  // it because there is no list price to publish. The negotiated amount is not
  // modelled yet, so such a subscription bills usage and overage but no base
  // fee until one is recorded. The UI says so before assigning.
  if (isDooit) return { ok: true };

  // For a client, a custom-priced plan has no price to charge, so it routes to
  // sales. The model forces selfServe=false whenever isCustomPriced, but check
  // both so a hand-edited document cannot slip through.
  if (plan.isCustomPriced || plan.selfServe === false) {
    return {
      ok: false,
      reason: `“${plan.name}” is quote-only — ${plan.salesCta || "contact sales"}`,
      salesAssisted: true,
    };
  }

  if (plan.visibility === "private") {
    const granted = await PlanEligibility.exists({
      planId: plan._id,
      user: userId,
      status: "active",
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
    if (!granted) return { ok: false, reason: "Plan not found" }; // do not disclose
  }

  return { ok: true };
}

/**
 * Period end for a billing cycle, starting from `from`.
 * Uses calendar months so a 31 Jan start lands on 28/29 Feb, not 3 Mar.
 *
 * `months` overrides the cycle when a specific span is wanted rather than one
 * billing period — the minimum-term end date is the only such caller today.
 * It exists because the call site was already passing a third argument that the
 * signature silently ignored, so a 12-month minimum term resolved to one month.
 *
 * @param {String} cycle   'monthly' | 'quarterly' | 'yearly' | 'custom'
 * @param {Date}   from
 * @param {Number} [months] explicit month count; overrides `cycle` when > 0
 */
function periodEndFor(cycle, from = new Date(), months = null) {
  const d = new Date(from);
  const add = (n) => {
    const day = d.getDate();
    const target = new Date(d);
    target.setDate(1);
    target.setMonth(target.getMonth() + n);
    // clamp to the last day of the target month
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, lastDay));
    return target;
  };

  if (Number(months) > 0) return add(Number(months));

  switch (cycle) {
    case "quarterly":
      return add(3);
    case "yearly":
      return add(12);
    case "custom":
      return add(1); // no defined cycle — treat as monthly until contracted
    case "monthly":
    default:
      return add(1);
  }
}

module.exports = { buildPriceSnapshot, canSubscribe, periodEndFor };
