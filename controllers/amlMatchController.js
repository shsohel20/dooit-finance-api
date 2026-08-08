/**
 * controllers/amlMatchController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Compliance-analyst review of AML matches (AmlMatch collection).
 *
 *   GET   /api/v1/sumsub/aml-matches/:customerId   — list matches + summary
 *   PATCH /api/v1/sumsub/aml-matches/:id           — disposition a single match
 *
 * The GET endpoint lazily back-fills AmlMatch rows from the legacy
 * Customer.amlHits blob the first time a pre-existing customer is opened, so
 * historical screenings surface without needing a re-screen.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const AmlMatch = require("../models/AmlMatch");
const Customer = require("../models/Customer");
const AuditLog = require("../models/AuditLog");
const { auditContext } = require("../utils/auditContext");
const {
  upsertMatchesForCustomer,
  recomputeCustomerAmlStatus,
} = require("../services/amlMatchService");

// ─────────────────────────────────────────────────────────────────────────────
// GET  /aml-matches/:customerId
// ─────────────────────────────────────────────────────────────────────────────
exports.getAmlMatches = asyncHandler(async (req, res, next) => {
  const { customerId } = req.params;

  const customer = await Customer.findById(customerId).select(
    "amlStatus amlRiskLabels amlVendor amlCheckedAt amlHits sumsubApplicantId isPep sanction",
  );
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  let matches = await AmlMatch.find({ customer: customerId })
    .populate({ path: "reviewedBy", select: "name" })
    .sort({ matchStatus: 1, createdAt: 1 })
    .lean();

  // Lazy backfill from the legacy blob for customers screened before AmlMatch existed.
  if (matches.length === 0 && customer.amlHits?.length > 0) {
    await upsertMatchesForCustomer(customer, customer.amlHits);
    await recomputeCustomerAmlStatus(customer._id);
    matches = await AmlMatch.find({ customer: customerId })
      .populate({ path: "reviewedBy", select: "name" })
      .sort({ matchStatus: 1, createdAt: 1 })
      .lean();
  }

  const byStatus = matches.reduce((acc, m) => {
    acc[m.matchStatus] = (acc[m.matchStatus] || 0) + 1;
    return acc;
  }, {});

  return res.status(200).json({
    success: true,
    summary: {
      amlStatus: customer.amlStatus,
      riskLabels: customer.amlRiskLabels || [],
      vendor: customer.amlVendor,
      checkedAt: customer.amlCheckedAt,
      isPep: customer.isPep,
      sanction: customer.sanction,
      total: matches.length,
      reviewed: matches.filter((m) => m.reviewStatus === "reviewed").length,
      byStatus,
    },
    data: matches,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH  /aml-matches/:id
// Body: { matchStatus?, whitelisted?, riskLevel?, reviewStatus?, reviewNote? }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateAmlMatch = asyncHandler(async (req, res, next) => {
  const match = await AmlMatch.findById(req.params.id);
  if (!match) return next(new ErrorResponse("AML match not found", 404));

  const { matchStatus, whitelisted, riskLevel, reviewStatus, reviewNote } = req.body || {};

  // ── Validate against the model's enums ────────────────────────────────────
  if (matchStatus !== undefined && !AmlMatch.MATCH_STATUS.includes(matchStatus)) {
    return next(new ErrorResponse(`Invalid matchStatus: ${matchStatus}`, 400));
  }
  if (riskLevel !== undefined && !AmlMatch.RISK_LEVEL.includes(riskLevel)) {
    return next(new ErrorResponse(`Invalid riskLevel: ${riskLevel}`, 400));
  }
  if (reviewStatus !== undefined && !AmlMatch.REVIEW_STATUS.includes(reviewStatus)) {
    return next(new ErrorResponse(`Invalid reviewStatus: ${reviewStatus}`, 400));
  }

  const before = {
    matchStatus: match.matchStatus,
    whitelisted: match.whitelisted,
    riskLevel: match.riskLevel,
    reviewStatus: match.reviewStatus,
  };

  let touched = false;
  if (matchStatus !== undefined) { match.matchStatus = matchStatus; touched = true; }
  if (whitelisted !== undefined) { match.whitelisted = !!whitelisted; touched = true; }
  if (riskLevel !== undefined) { match.riskLevel = riskLevel; touched = true; }
  if (reviewNote !== undefined) { match.reviewNote = String(reviewNote); touched = true; }

  if (!touched && reviewStatus === undefined) {
    return next(new ErrorResponse("No updatable fields supplied", 400));
  }

  // Any disposition marks the match reviewed (unless the caller set it explicitly).
  match.reviewStatus = reviewStatus !== undefined ? reviewStatus : "reviewed";
  match.reviewedBy = req.user?.id || req.user?._id || null;
  match.reviewedAt = new Date();
  await match.save();

  // Customer-level status reflects the new disposition.
  const amlStatus = await recomputeCustomerAmlStatus(match.customer);

  // ── Audit trail ────────────────────────────────────────────────────────────
  AuditLog.create({
    service: "sumsub",
    action: "aml_match_review",
    externalId: match.sumsubApplicantId || undefined,
    customer: match.customer,
    target: match.matchId,
    status: "success",
    actor: req.user?.id || req.user?._id || undefined,
    actorName: req.user?.name || undefined,
    actorRole: req.user?.role || undefined,
    ...auditContext(req),
    beforeValue: before,
    afterValue: {
      matchStatus: match.matchStatus,
      whitelisted: match.whitelisted,
      riskLevel: match.riskLevel,
      reviewStatus: match.reviewStatus,
    },
  }).catch((err) => console.error("[AmlMatch] audit write failed:", err.message));

  const populated = await AmlMatch.findById(match._id)
    .populate({ path: "reviewedBy", select: "name" })
    .lean();

  return res.status(200).json({
    success: true,
    data: populated,
    amlStatus, // recomputed customer-level status so the UI can refresh the badge
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH  /aml-matches/bulk
// Body: { ids: [String], matchStatus?, whitelisted?, riskLevel?, reviewStatus?, reviewNote? }
//
// Apply the same disposition to many matches in one call. Each match is marked
// reviewed (unless reviewStatus is set explicitly). Customer AML status is
// recomputed ONCE per distinct customer — not per match.
// ─────────────────────────────────────────────────────────────────────────────
exports.bulkUpdateAmlMatches = asyncHandler(async (req, res, next) => {
  const { ids, matchStatus, whitelisted, riskLevel, reviewStatus, reviewNote } =
    req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return next(new ErrorResponse("ids array is required", 400));
  }

  // ── Validate against the model's enums (once for the whole batch) ──────────
  if (matchStatus !== undefined && !AmlMatch.MATCH_STATUS.includes(matchStatus)) {
    return next(new ErrorResponse(`Invalid matchStatus: ${matchStatus}`, 400));
  }
  if (riskLevel !== undefined && !AmlMatch.RISK_LEVEL.includes(riskLevel)) {
    return next(new ErrorResponse(`Invalid riskLevel: ${riskLevel}`, 400));
  }
  if (reviewStatus !== undefined && !AmlMatch.REVIEW_STATUS.includes(reviewStatus)) {
    return next(new ErrorResponse(`Invalid reviewStatus: ${reviewStatus}`, 400));
  }

  const hasFieldUpdate =
    matchStatus !== undefined ||
    whitelisted !== undefined ||
    riskLevel !== undefined ||
    reviewNote !== undefined;

  if (!hasFieldUpdate && reviewStatus === undefined) {
    return next(new ErrorResponse("No updatable fields supplied", 400));
  }

  const matches = await AmlMatch.find({ _id: { $in: ids } });
  if (matches.length === 0) {
    return next(new ErrorResponse("No AML matches found for the supplied ids", 404));
  }

  const actorId = req.user?.id || req.user?._id || null;
  const now = new Date();
  const auditDocs = [];

  for (const match of matches) {
    const before = {
      matchStatus: match.matchStatus,
      whitelisted: match.whitelisted,
      riskLevel: match.riskLevel,
      reviewStatus: match.reviewStatus,
    };

    if (matchStatus !== undefined) match.matchStatus = matchStatus;
    if (whitelisted !== undefined) match.whitelisted = !!whitelisted;
    if (riskLevel !== undefined) match.riskLevel = riskLevel;
    if (reviewNote !== undefined) match.reviewNote = String(reviewNote);

    match.reviewStatus = reviewStatus !== undefined ? reviewStatus : "reviewed";
    match.reviewedBy = actorId;
    match.reviewedAt = now;
    await match.save();

    auditDocs.push({
      service: "sumsub",
      action: "aml_match_review",
      externalId: match.sumsubApplicantId || undefined,
      customer: match.customer,
      target: match.matchId,
      status: "success",
      actor: actorId || undefined,
      actorName: req.user?.name || undefined,
      actorRole: req.user?.role || undefined,
      ...auditContext(req),
      beforeValue: before,
      afterValue: {
        matchStatus: match.matchStatus,
        whitelisted: match.whitelisted,
        riskLevel: match.riskLevel,
        reviewStatus: match.reviewStatus,
      },
    });
  }

  AuditLog.insertMany(auditDocs).catch((err) =>
    console.error("[AmlMatch] bulk audit write failed:", err.message),
  );

  // Recompute customer-level status once per distinct customer (usually one).
  const customerIds = [...new Set(matches.map((m) => String(m.customer)))];
  const amlStatusByCustomer = {};
  for (const cid of customerIds) {
    amlStatusByCustomer[cid] = await recomputeCustomerAmlStatus(cid);
  }

  const populated = await AmlMatch.find({ _id: { $in: matches.map((m) => m._id) } })
    .populate({ path: "reviewedBy", select: "name" })
    .lean();

  return res.status(200).json({
    success: true,
    data: populated,
    updated: populated.length,
    // Convenience scalar for the single-customer table; full map for callers
    // that bulk-update across customers.
    amlStatus: amlStatusByCustomer[customerIds[0]],
    amlStatusByCustomer,
  });
});
