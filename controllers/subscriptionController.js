// controllers/subscriptionController.js
//
// Subscriptions — dooit builds plans, the CLIENT buys them.
//
// This is the one billing collection a client writes to. A client admin may:
//   subscribe to an eligible plan, change plan, cancel, resume
// scoped to their own subscriptions only. dooit may do all of that for any
// account, plus pause/provision.
//
// Reference: docs/billingmodule/mongoose-schema.md §7.5

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Subscription = require("../models/Subscription");
const BillingPlan = require("../models/BillingPlan");
const {
  assertUserType,
  assertActingAs,
  isDooit,
  actorId,
  actorClient,
  USER_TYPE_CLIENT,
  USER_TYPE_DOOIT,
} = require("../services/billing/assertUserType");
const { DISCOUNT_TYPES } = require("../models/constants/billing");
const { computeDiscount } = require("../services/billing/invoiceService");
const { logEvent } = require("../utils/audit");
const {
  buildPriceSnapshot,
  canSubscribe,
  periodEndFor,
} = require("../services/billing/subscriptionService");

/**
 * Whose subscriptions is the caller allowed to see or act on?
 * dooit → anyone (optionally narrowed by ?user=). A client → only their own,
 * taken from the JWT and never from the request body.
 */
const scopeFor = (req) => (isDooit(req) ? {} : { user: actorId(req) });

const loadOwned = async (req, id) => {
  const sub = await Subscription.findOne({ _id: id, ...scopeFor(req) });
  return sub;
};

/**
 * Validate and normalise a discount payload.
 *
 * The range check is per-type and not shared, because the two types fail in
 * opposite directions: a percentage over 100 would invert the invoice, while a
 * fixed amount legitimately exceeds a single period's subtotal (a standing
 * credit) and is capped at billing time instead of rejected here.
 *
 * @returns {Object} the discount sub-document
 * @throws  ErrorResponse(400) on anything unusable
 */
const normalizeDiscount = (raw, actor) => {
  if (raw == null) return null;

  const type = String(raw.type ?? "none").toLowerCase();
  if (!DISCOUNT_TYPES.includes(type)) {
    throw new ErrorResponse(
      `discount.type must be one of: ${DISCOUNT_TYPES.join(", ")}`,
      400
    );
  }

  // Clearing a discount is a legitimate edit, so 'none' is accepted and wipes
  // the value rather than being treated as a missing field.
  if (type === "none") {
    return { type: "none", value: 0, reason: null, appliedBy: actor, appliedAt: new Date() };
  }

  const value = Number(raw.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ErrorResponse("discount.value must be a number greater than zero", 400);
  }
  if (type === "percentage" && value > 100) {
    throw new ErrorResponse("A percentage discount cannot exceed 100", 400);
  }

  return {
    type,
    // 2dp: a discount is money (or a percentage of it), and the schema
    // validator rejects more scale than that anyway.
    value: Math.round(value * 100) / 100,
    reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : null,
    appliedBy: actor,
    appliedAt: new Date(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────

// @desc   List subscriptions
// @route  GET /api/v1/subscription
// @access dooit → all; client → own only
exports.getSubscriptions = asyncHandler(async (req, res) => {
  const { status, planCode, user, page = 1, limit = 50, sort = "-createdAt" } = req.query;

  const filter = { ...scopeFor(req) };
  if (status && status !== "all") filter.status = status;
  if (planCode) filter.planCode = String(planCode).toLowerCase();
  // Only dooit may filter by another user; for a client, scopeFor already pinned it.
  if (user && isDooit(req)) filter.user = user;

  const SORTS = {
    "-createdAt": { createdAt: -1 },
    createdAt: { createdAt: 1 },
    renewal: { currentPeriodEnd: 1 },
  };

  const result = await Subscription.paginate(filter, {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(200, Math.max(1, parseInt(limit, 10) || 50)),
    sort: SORTS[sort] || SORTS["-createdAt"],
    populate: [
      { path: "plan", select: "name code version accentColor status" },
      { path: "user", select: "name email" },
    ],
  });

  res.status(200).json({
    success: true,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.totalDocs,
      totalPages: result.totalPages,
    },
    data: result.docs,
  });
});

// @desc   The caller's current subscription
// @route  GET /api/v1/subscription/current
// @access client (own) — dooit may pass ?user=
exports.getCurrentSubscription = asyncHandler(async (req, res) => {
  const userId = isDooit(req) && req.query.user ? req.query.user : actorId(req);

  const sub = await Subscription.findOne({
    user: userId,
    status: { $in: ["active", "pending"] },
  })
    .sort({ createdAt: -1 })
    .populate("plan", "name code version accentColor status");

  res.status(200).json({ success: true, data: sub || null });
});

// @desc   Get one subscription
// @route  GET /api/v1/subscription/:id
// @access dooit → any; client → own only
exports.getSubscription = asyncHandler(async (req, res, next) => {
  const sub = await Subscription.findOne({ _id: req.params.id, ...scopeFor(req) })
    .populate("plan", "name code version accentColor status")
    .populate("user", "name email");
  // 404 rather than 403 — a client should not learn that someone else's
  // subscription exists.
  if (!sub) return next(new ErrorResponse("Subscription not found", 404));
  res.status(200).json({ success: true, data: sub });
});

// @desc   Subscribe to a plan
// @route  POST /api/v1/subscription
// @access client (self) or dooit (provisioning for a client user)
exports.createSubscription = asyncHandler(async (req, res, next) => {
  const { plan: planId } = req.body;
  if (!planId) return next(new ErrorResponse("plan is required", 400));

  // A discount may be attached at the moment dooit assigns the plan. Checked
  // FIRST, before any plan or eligibility work: a client attempting to discount
  // itself should be told that is not theirs to do, not handed whatever
  // unrelated complaint the plan lookup happens to raise. And rejected rather
  // than ignored — silently dropping it would let a client believe they had
  // bought at a discount they never received.
  let discount = null;
  if (req.body.discount != null) {
    if (!isDooit(req)) {
      return next(new ErrorResponse("Only dooit can apply a discount", 403));
    }
    try {
      discount = normalizeDiscount(req.body.discount, actorId(req));
    } catch (err) {
      return next(err);
    }
  }

  // dooit may provision on someone's behalf; a client always subscribes itself.
  const targetUser = isDooit(req) && req.body.user ? req.body.user : actorId(req);
  await assertUserType(targetUser, USER_TYPE_CLIENT, "user");

  const plan = await BillingPlan.findById(planId);
  if (!plan) return next(new ErrorResponse("Plan not found", 404));

  const eligible = await canSubscribe(plan, {
    userId: targetUser,
    isDooit: isDooit(req),
  });
  if (!eligible.ok) {
    // Quote-only plans are a 409 (a real plan, wrong route); an invisible plan
    // reports 404 so private plans stay undisclosed.
    const code = eligible.salesAssisted ? 409 : eligible.reason === "Plan not found" ? 404 : 400;
    return next(new ErrorResponse(eligible.reason, code));
  }

  // The DB partial unique index covers `active`; `pending` is not indexable with
  // plain equality, so guard both here.
  const existing = await Subscription.findOne({
    user: targetUser,
    status: { $in: ["active", "pending"] },
  }).select("_id uid planCode status");
  if (existing) {
    return next(
      new ErrorResponse(
        // Status is interpolated without an article — "a ${status}" reads
        // "a active" for the commonest case of all.
        `This account already has an existing subscription (${existing.uid}, ${existing.planCode}, ${existing.status}). Change it instead of creating a second one.`,
        409
      )
    );
  }

  const now = new Date();
  const snapshot = buildPriceSnapshot(plan);
  const periodEnd = periodEndFor(plan.billingCycle, now);

  const sub = await Subscription.create({
    user: targetUser,
    client: isDooit(req) ? req.body.client ?? null : actorClient(req),
    plan: plan._id,
    planCode: plan.code,
    planVersion: plan.version,
    // Created ACTIVE, deliberately.
    //
    // The design calls for a paid plan to sit in `pending` until its first
    // charge settles — but payments are step 6, so nothing can move it out of
    // `pending` yet. Shipping that now would strand every paid subscription in
    // a state with no exit: not billable, not pausable, not cancellable.
    // When payments land, gate this on the first successful charge.
    //
    // Note the DB's one-active-subscription index only covers `active`, so
    // this also keeps that guarantee actually engaged.
    status: "active",
    startDate: now,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    trialEndsAt: plan.trialDays
      ? new Date(now.getTime() + plan.trialDays * 86400000)
      : null,
    minimumTermEndsAt: plan.changePolicy?.minimumTermMonths
      ? periodEndFor("monthly", now, plan.changePolicy.minimumTermMonths)
      : null,
    nextInvoiceAt: periodEnd,
    priceSnapshot: snapshot,
    ...(discount ? { discount } : {}),
    changeType: "new",
    createdBy: actorId(req),
  });

  logEvent({
    req,
    service: "billing",
    action: "subscription_created",
    user: sub.user,
    ...(sub.client ? { client: sub.client } : {}),
    target: sub.uid ?? String(sub._id),
    afterValue: {
      planCode: sub.planCode,
      ...(discount ? { discount: { type: discount.type, value: discount.value } } : {}),
    },
  });

  res.status(201).json({ success: true, data: sub });
});

// @desc   Set, change or clear the negotiated discount
// @route  PATCH /api/v1/subscription/:id/discount
// @access dooit only
//
// Takes effect on the NEXT invoice close. Invoices already produced copied the
// discount they applied into their own lines, so nothing here rewrites a total
// the customer has already been shown — which is the whole reason the discount
// lives on the subscription rather than inside the frozen priceSnapshot.
exports.updateDiscount = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const sub = await Subscription.findById(req.params.id);
  if (!sub) return next(new ErrorResponse("Subscription not found", 404));

  // Cancelled and expired subscriptions will never close another period, so a
  // discount on one is a silent no-op — better to say so than to accept it.
  if (["cancelled", "expired"].includes(sub.status)) {
    return next(
      new ErrorResponse(
        `A ${sub.status} subscription will not be invoiced again, so a discount would have no effect`,
        409
      )
    );
  }

  if (req.body.discount == null && req.body.type == null) {
    return next(new ErrorResponse("discount is required", 400));
  }

  let discount;
  try {
    // Accept both { discount: {...} } and a bare { type, value, reason } body —
    // the flat form is what a PATCH of a single field naturally looks like.
    discount = normalizeDiscount(req.body.discount ?? req.body, actorId(req));
  } catch (err) {
    return next(err);
  }

  const previous = {
    type: sub.discount?.type || "none",
    value: sub.discount?.value != null ? Number(sub.discount.value) : 0,
  };

  sub.discount = discount;
  await sub.save();

  logEvent({
    req,
    service: "billing",
    action: "discount_changed",
    user: sub.user,
    ...(sub.client ? { client: sub.client } : {}),
    target: sub.uid ?? String(sub._id),
    beforeValue: previous,
    afterValue: { type: discount.type, value: discount.value },
  });

  // Show what this will do to the next invoice, so the effect of "15%" is not
  // left to be discovered at close time.
  const preview = computeDiscount(sub.discount, Number(sub.priceSnapshot?.basePrice) || 0);

  res.status(200).json({
    success: true,
    data: sub,
    meta: {
      previous,
      cleared: discount.type === "none",
      // Against the base fee alone — the real subtotal also carries overage,
      // which is not known until the period closes.
      estimatedOnBaseFee: preview.amount,
    },
  });
});

// @desc   Change plan (upgrade / downgrade) — supersedes, never mutates
// @route  POST /api/v1/subscription/:id/change-plan
// @access client (own) or dooit
exports.changePlan = asyncHandler(async (req, res, next) => {
  const { plan: newPlanId } = req.body;
  if (!newPlanId) return next(new ErrorResponse("plan is required", 400));

  const current = await loadOwned(req, req.params.id);
  if (!current) return next(new ErrorResponse("Subscription not found", 404));
  if (!["active", "pending"].includes(current.status)) {
    return next(
      new ErrorResponse(`A ${current.status} subscription cannot be changed`, 409)
    );
  }

  const newPlan = await BillingPlan.findById(newPlanId);
  if (!newPlan) return next(new ErrorResponse("Plan not found", 404));
  if (String(newPlan._id) === String(current.plan)) {
    return next(new ErrorResponse("Already on this plan", 409));
  }

  const eligible = await canSubscribe(newPlan, {
    userId: current.user,
    isDooit: isDooit(req),
  });
  if (!eligible.ok) {
    const code = eligible.salesAssisted ? 409 : eligible.reason === "Plan not found" ? 404 : 400;
    return next(new ErrorResponse(eligible.reason, code));
  }

  // Direction is decided on the SNAPSHOT's price, not the current catalogue —
  // the customer's own baseline is what an "upgrade" is relative to.
  const oldPrice = Number(current.priceSnapshot?.basePrice) || 0;
  const newPrice = Number(newPlan.basePrice) || 0;
  const direction =
    newPrice > oldPrice ? "upgrade" : newPrice < oldPrice ? "downgrade" : "lateral";

  // Rights come from the snapshot in force, not from today's catalogue.
  const policy = current.priceSnapshot?.changePolicy || {};
  if (direction === "upgrade" && policy.allowUpgrade === false) {
    return next(new ErrorResponse("This plan does not allow upgrades", 409));
  }
  if (direction === "downgrade" && policy.allowDowngrade === false) {
    return next(new ErrorResponse("This plan does not allow downgrades", 409));
  }
  if (current.minimumTermEndsAt && current.minimumTermEndsAt > new Date()) {
    return next(
      new ErrorResponse(
        `Minimum term runs until ${current.minimumTermEndsAt.toISOString().slice(0, 10)}`,
        409
      )
    );
  }

  const now = new Date();
  // Applied at the period boundary, which is what avoids mid-cycle proration —
  // and keeps the one-active-subscription index satisfied, because the old one
  // is closed in the same step.
  const effectiveAt = current.currentPeriodEnd;

  current.status = "cancelled";
  current.cancelAtPeriodEnd = true;
  current.cancelledAt = now;
  current.cancelledBy = actorId(req);
  current.cancelReason = `Changed to ${newPlan.code}`;
  current.endedAt = effectiveAt;
  await current.save();

  const next_ = await Subscription.create({
    user: current.user,
    client: current.client,
    plan: newPlan._id,
    planCode: newPlan.code,
    planVersion: newPlan.version,
    status: "active",
    startDate: effectiveAt,
    currentPeriodStart: effectiveAt,
    currentPeriodEnd: periodEndFor(newPlan.billingCycle, effectiveAt),
    nextInvoiceAt: periodEndFor(newPlan.billingCycle, effectiveAt),
    priceSnapshot: buildPriceSnapshot(newPlan),
    previousSubscription: current._id,
    changeType: direction === "lateral" ? "new" : direction,
    createdBy: actorId(req),
  });

  current.replacedBySubscription = next_._id;
  await current.save();

  logEvent({
    req,
    service: "billing",
    action: "plan_changed",
    user: current.user,
    ...(current.client ? { client: current.client } : {}),
    target: next_.uid ?? String(next_._id),
    beforeValue: { planCode: current.planCode },
    afterValue: { planCode: newPlan.code },
    details: `${direction} effective ${effectiveAt?.toISOString?.() ?? effectiveAt}`,
  });

  res.status(201).json({
    success: true,
    data: next_,
    meta: { direction, effectiveAt, previousSubscription: current._id },
  });
});

// @desc   Cancel
// @route  POST /api/v1/subscription/:id/cancel
// @access client (own) or dooit
exports.cancelSubscription = asyncHandler(async (req, res, next) => {
  const sub = await loadOwned(req, req.params.id);
  if (!sub) return next(new ErrorResponse("Subscription not found", 404));
  if (["cancelled", "expired"].includes(sub.status)) {
    return next(new ErrorResponse(`Already ${sub.status}`, 409));
  }

  const policy = sub.priceSnapshot?.changePolicy || {};
  if (policy.allowCancel === false && !isDooit(req)) {
    return next(new ErrorResponse("This plan does not allow self-service cancellation", 409));
  }
  if (sub.minimumTermEndsAt && sub.minimumTermEndsAt > new Date() && !isDooit(req)) {
    return next(
      new ErrorResponse(
        `Minimum term runs until ${sub.minimumTermEndsAt.toISOString().slice(0, 10)}`,
        409
      )
    );
  }

  // Immediate cancellation is a dooit override; a client cancels at period end
  // per the snapshot's policy. Either way the final period is still invoiced —
  // cancelling does not erase usage already incurred.
  const immediate = isDooit(req) && req.body.immediate === true;

  sub.cancelReason = req.body.reason || null;
  sub.cancelledBy = actorId(req);

  if (immediate) {
    sub.status = "cancelled";
    sub.cancelledAt = new Date();
    sub.endedAt = new Date();
  } else {
    sub.cancelAtPeriodEnd = true;
    sub.cancelledAt = new Date();
    // status stays 'active' until the period actually ends
  }
  await sub.save();

  logEvent({
    req,
    service: "billing",
    action: "subscription_cancelled",
    user: sub.user,
    ...(sub.client ? { client: sub.client } : {}),
    target: sub.uid ?? String(sub._id),
    details: immediate ? "Cancelled immediately" : "Cancelled at period end",
  });

  res.status(200).json({
    success: true,
    data: sub,
    meta: {
      immediate,
      effectiveAt: immediate ? sub.endedAt : sub.currentPeriodEnd,
      note: "Usage already incurred in this period is still invoiced.",
    },
  });
});

// @desc   Undo a pending cancellation
// @route  POST /api/v1/subscription/:id/resume
// @access client (own) or dooit
exports.resumeSubscription = asyncHandler(async (req, res, next) => {
  const sub = await loadOwned(req, req.params.id);
  if (!sub) return next(new ErrorResponse("Subscription not found", 404));

  if (sub.status === "paused") {
    sub.status = "active";
    sub.pausedAt = null;
    sub.resumedAt = new Date();
  } else if (sub.status === "active" && sub.cancelAtPeriodEnd) {
    sub.cancelAtPeriodEnd = false;
    sub.cancelledAt = null;
    sub.cancelledBy = null;
    sub.cancelReason = null;
  } else {
    return next(
      new ErrorResponse(
        `Nothing to resume — subscription is ${sub.status} and not scheduled to cancel`,
        409
      )
    );
  }

  await sub.save();

  logEvent({
    req,
    service: "billing",
    action: "subscription_resumed",
    user: sub.user,
    ...(sub.client ? { client: sub.client } : {}),
    target: sub.uid ?? String(sub._id),
  });

  res.status(200).json({ success: true, data: sub });
});

// @desc   Pause (dooit only — a client cannot suspend its own compliance cover)
// @route  POST /api/v1/subscription/:id/pause
// @access dooit only
exports.pauseSubscription = asyncHandler(async (req, res, next) => {
  const sub = await Subscription.findById(req.params.id);
  if (!sub) return next(new ErrorResponse("Subscription not found", 404));
  if (sub.status !== "active") {
    return next(new ErrorResponse(`Only an active subscription can be paused`, 409));
  }

  sub.status = "paused";
  sub.pausedAt = new Date();
  sub.metadata = { ...(sub.metadata || {}), pauseReason: req.body.reason || null };
  await sub.save();

  logEvent({
    req,
    service: "billing",
    action: "subscription_paused",
    user: sub.user,
    ...(sub.client ? { client: sub.client } : {}),
    target: sub.uid ?? String(sub._id),
    details: req.body.reason || null,
  });

  res.status(200).json({ success: true, data: sub });
});
