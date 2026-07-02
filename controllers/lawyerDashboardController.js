const asyncHandler             = require("../middleware/async");
const Customer                 = require("../models/Customer");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const Alert                    = require("../models/Alert");
const Transaction              = require("../models/Transaction");
const OnboardingJourney        = require("../models/OnboardingJourney");
const SmrReport                = require("../models/SmrReport");
const TtrReport                = require("../models/TtrReport");

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// GET /lawyer-dashboard/summary
// Aggregated analytics for the Lawyers/Conveyancers entity dashboard.
// All figures are client-scoped except SMR/TTR counts — those collections
// carry no client ref yet, so they are global (same numbers the register
// list pages show today).
exports.getLawyerDashboardSummary = asyncHandler(async (req, res) => {
  const client = req.user?.client?._id;

  const now          = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const in30Days     = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [
    customerByKyc,
    customerFlags,
    craByLabel,
    ecddPendingCount,
    ecddQueue,
    reviewsDueSoon,
    reviewsOverdue,
    upcomingReviews,
    alertsByStatus,
    recentAlerts,
    txnTrend,
    txnThisMonth,
    txnByType,
    onboardingByStatus,
    smrByStatus,
    ttrByStatus,
  ] = await Promise.all([

    // ── Clients of the firm by KYC status ─────────────────────────────────────
    Customer.aggregate([
      { $match: { "relations.client": client } },
      { $group: { _id: "$kycStatus", count: { $sum: 1 } } },
    ]),

    // ── PEP / sanctions / new-this-month flags ────────────────────────────────
    Customer.aggregate([
      { $match: { "relations.client": client } },
      { $group: {
          _id: null,
          total:        { $sum: 1 },
          pep:          { $sum: { $cond: ["$isPep", 1, 0] } },
          sanctioned:   { $sum: { $cond: ["$sanction", 1, 0] } },
          newThisMonth: { $sum: { $cond: [{ $gte: ["$createdAt", startOfMonth] }, 1, 0] } },
      }},
    ]),

    // ── CRA distribution by risk label ────────────────────────────────────────
    IndividualRiskAssessment.aggregate([
      { $match: { client } },
      { $group: {
          _id: "$riskLabel",
          count: { $sum: 1 },
          avgScore: { $avg: "$riskScore" },
      }},
    ]),

    // ── ECDD queue (gate active, CO decision pending) ─────────────────────────
    IndividualRiskAssessment.countDocuments({ client, cddGate: true, ecddStatus: "Pending" }),
    IndividualRiskAssessment.find({ client, cddGate: true, ecddStatus: "Pending" })
      .select("uid riskScore riskLabel entityType createdAt customer")
      .populate("customer", "uid personalKyc.personal_form.customer_details.given_name personalKyc.personal_form.customer_details.surname")
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),

    // ── CRA reviews due in the next 30 days / overdue ─────────────────────────
    IndividualRiskAssessment.countDocuments({
      client, nextReviewDate: { $gte: now, $lte: in30Days },
    }),
    IndividualRiskAssessment.countDocuments({
      client, nextReviewDate: { $ne: null, $lt: now },
    }),
    IndividualRiskAssessment.find({ client, nextReviewDate: { $ne: null, $lte: in30Days } })
      .select("uid riskLabel riskScore nextReviewDate customer")
      .populate("customer", "uid personalKyc.personal_form.customer_details.given_name personalKyc.personal_form.customer_details.surname")
      .sort({ nextReviewDate: 1 })
      .limit(8)
      .lean(),

    // ── Cases / alerts ────────────────────────────────────────────────────────
    Alert.aggregate([
      { $match: { client } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Alert.find({ client })
      .select("uid caseType riskLabel status createdAt")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),

    // ── Trust account activity — monthly trend, last 6 months ─────────────────
    // Volume prefers convertedAmountAUD; falls back to raw amount when the
    // AUD conversion is absent (mixed-currency caveat).
    Transaction.aggregate([
      { $match: { client, timestamp: { $gte: sixMonthsAgo } } },
      { $group: {
          _id: { year: { $year: "$timestamp" }, month: { $month: "$timestamp" } },
          count:  { $sum: 1 },
          volume: { $sum: { $ifNull: ["$convertedAmountAUD", "$amount"] } },
      }},
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),
    Transaction.aggregate([
      { $match: { client, timestamp: { $gte: startOfMonth } } },
      { $group: {
          _id: null,
          count:  { $sum: 1 },
          volume: { $sum: { $ifNull: ["$convertedAmountAUD", "$amount"] } },
          flagged: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$riskFlags", []] } }, 0] }, 1, 0] } },
      }},
    ]),
    Transaction.aggregate([
      { $match: { client, timestamp: { $gte: sixMonthsAgo } } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    // ── Onboarding pipeline ───────────────────────────────────────────────────
    OnboardingJourney.aggregate([
      { $match: { client } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // ── Regulatory reports (global — no client ref on these collections) ──────
    SmrReport.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    TtrReport.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  // ── Shape the response ──────────────────────────────────────────────────────
  const toMap = (arr) => Object.fromEntries(arr.map((x) => [x._id, x.count]));

  const kycMap   = toMap(customerByKyc);
  const craMap   = toMap(craByLabel);
  const alertMap = toMap(alertsByStatus);
  const smrMap   = toMap(smrByStatus);
  const ttrMap   = toMap(ttrByStatus);

  const flags = customerFlags[0] || { total: 0, pep: 0, sanctioned: 0, newThisMonth: 0 };

  const totalCra = craByLabel.reduce((s, d) => s + d.count, 0);
  const craWeighted = craByLabel.reduce((s, d) => s + (d.avgScore || 0) * d.count, 0);
  const avgCraScore = totalCra > 0 ? Math.round((craWeighted / totalCra) * 100) / 100 : null;

  const kycVerified    = kycMap["verified"] || 0;
  const kycVerifiedPct = flags.total > 0 ? Math.round((kycVerified / flags.total) * 100) : null;

  const customerName = (c) => {
    const d = c?.personalKyc?.personal_form?.customer_details;
    const name = [d?.given_name, d?.surname].filter(Boolean).join(" ").trim();
    return name || c?.uid || "—";
  };
  const shapeAssessment = (a) => ({
    _id: a._id,
    uid: a.uid,
    riskScore: a.riskScore,
    riskLabel: a.riskLabel,
    entityType: a.entityType,
    nextReviewDate: a.nextReviewDate,
    createdAt: a.createdAt,
    customerUid: a.customer?.uid || null,
    customerName: customerName(a.customer),
  });

  const trustTrend = txnTrend.map((t) => ({
    month: `${MONTHS[t._id.month - 1]} ${t._id.year}`,
    count: t.count,
    volume: Math.round(t.volume || 0),
  }));
  const thisMonth = txnThisMonth[0] || { count: 0, volume: 0, flagged: 0 };

  res.json({
    success: true,
    data: {
      kpi: {
        totalClients:    flags.total,
        newThisMonth:    flags.newThisMonth,
        kycVerifiedPct,
        highRiskClients: (craMap["High"] || 0) + (craMap["Unacceptable"] || 0),
        pendingEcdd:     ecddPendingCount,
        openCases:       (alertMap["Pending"] || 0) + (alertMap["Active"] || 0),
        trustVolumeThisMonth: Math.round(thisMonth.volume || 0),
        trustTxnsThisMonth:   thisMonth.count,
        reviewsOverdue:  reviewsOverdue,
      },

      clients: {
        total: flags.total,
        byKycStatus: {
          pending:   kycMap["pending"]   || 0,
          in_review: kycMap["in_review"] || 0,
          verified:  kycVerified,
          rejected:  kycMap["rejected"]  || 0,
        },
        pep:          flags.pep,
        sanctioned:   flags.sanctioned,
        newThisMonth: flags.newThisMonth,
      },

      risk: {
        total: totalCra,
        avgScore: avgCraScore,
        byLabel: {
          Low:          craMap["Low"]          || 0,
          Medium:       craMap["Medium"]       || 0,
          High:         craMap["High"]         || 0,
          Unacceptable: craMap["Unacceptable"] || 0,
        },
      },

      ecdd: {
        pendingCount: ecddPendingCount,
        queue: ecddQueue.map(shapeAssessment),
      },

      reviews: {
        dueSoonCount: reviewsDueSoon,
        overdueCount: reviewsOverdue,
        upcoming: upcomingReviews.map(shapeAssessment),
      },

      cases: {
        byStatus: alertMap,
        open: (alertMap["Pending"] || 0) + (alertMap["Active"] || 0),
        recent: recentAlerts,
      },

      trust: {
        trend: trustTrend,
        byType: txnByType.map((t) => ({ type: t._id || "other", count: t.count })),
        thisMonth: {
          count:   thisMonth.count,
          volume:  Math.round(thisMonth.volume || 0),
          flagged: thisMonth.flagged,
        },
      },

      onboarding: {
        byStatus: toMap(onboardingByStatus),
      },

      reports: {
        scope: "global", // SmrReport / TtrReport have no client ref yet
        smr: {
          draft:    smrMap["draft"]    || 0,
          review:   smrMap["review"]   || 0,
          approved: smrMap["approved"] || 0,
          total:    smrByStatus.reduce((s, d) => s + d.count, 0),
        },
        ttr: {
          draft:     ttrMap["draft"]     || 0,
          submitted: ttrMap["submitted"] || 0,
          approved:  ttrMap["approved"]  || 0,
          total:     ttrByStatus.reduce((s, d) => s + d.count, 0),
        },
      },
    },
  });
});
