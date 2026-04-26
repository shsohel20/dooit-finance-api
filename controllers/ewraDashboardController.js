/**
 * EWRA Dashboard Controller
 * All endpoints scoped to a specific entityId (EntityProfile._id)
 * GET /api/v1/ewra-dashboard/:entityId/<metric>
 */
const asyncHandler           = require("../middleware/async");
const ErrorResponse          = require("../utils/errorResponse");
const mongoose               = require("mongoose");
const EntityProfile          = require("../models/EntityProfile");
const EntityObligation       = require("../models/EntityObligation");
const EwraAssessment         = require("../models/EwraAssessment");
const EwraRiskFactor         = require("../models/EwraRiskFactor");
const EwraControlAssessment  = require("../models/EwraControlAssessment");
const TestSchedule           = require("../models/TestSchedule");
const IssueRegister          = require("../models/IssueRegister");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const SmrReport              = require("../models/SmrReport");
const Customer               = require("../models/Customer");

/* ─── helper: resolve entityId → latest approved EWRA assessment ───────────── */
async function resolveAssessment(entityId, client) {
  const assessment = await EwraAssessment.findOne({
    entityProfile: entityId,
    client,
    status: { $in: ["Approved", "In Review", "Draft"] },
  })
    .sort({ updatedAt: -1 })
    .lean();
  return assessment;
}

/* ─── 1. GET /risk-summary ───────────────────────────────────────────────────
   Count of risk factors by residualRating (Critical/High/Medium/Low/Extreme)
   also includes inherent vs residual breakdown                               */
exports.getRiskSummary = asyncHandler(async (req, res, next) => {
  const { entityId } = req.params;
  const client = req.user?.client?._id;

  const assessment = await resolveAssessment(entityId, client);
  if (!assessment) return res.json({ success: true, data: { byRating: {}, inherentByRating: {}, total: 0, assessment: null } });

  const factors = await EwraRiskFactor.aggregate([
    { $match: { assessmentId: assessment._id } },
    { $group: {
        _id: null,
        total: { $sum: 1 },
        byResidual: { $push: "$residualRating" },
        byInherent: { $push: "$inherentRating" },
        avgResidual: { $avg: "$residualScore" },
        avgInherent: { $avg: "$inherentScore" },
    }},
  ]);

  const row = factors[0] || { total: 0, byResidual: [], byInherent: [], avgResidual: null, avgInherent: null };

  const tally = (arr) => arr.filter(Boolean).reduce((acc, r) => {
    acc[r] = (acc[r] || 0) + 1; return acc;
  }, {});

  res.json({
    success: true,
    data: {
      assessmentId:    assessment._id,
      assessmentName:  assessment.assessmentName,
      assessmentStatus: assessment.status,
      residualRating:  assessment.residualRiskRating,
      inherentRating:  assessment.inherentRiskRating,
      total:           row.total,
      avgResidualScore: row.avgResidual ? +row.avgResidual.toFixed(2) : null,
      avgInherentScore: row.avgInherent ? +row.avgInherent.toFixed(2) : null,
      byRating:        tally(row.byResidual),
      inherentByRating: tally(row.byInherent),
    },
  });
});

/* ─── 2. GET /compliance-health ──────────────────────────────────────────────
   % obligations compliant (testResult=Pass), open issues count               */
exports.getComplianceHealth = asyncHandler(async (req, res, next) => {
  const { entityId } = req.params;
  const client = req.user?.client?._id;

  const [obligationStats, issueStats] = await Promise.all([
    EntityObligation.aggregate([
      { $match: { entityProfileId: new mongoose.Types.ObjectId(entityId), client } },
      { $group: {
          _id: "$testResult",
          count: { $sum: 1 },
      }},
    ]),
    IssueRegister.aggregate([
      { $match: { client, status: { $in: ["Open", "In Progress", "Under Review"] } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const oblMap    = Object.fromEntries(obligationStats.map((o) => [o._id, o.count]));
  const issMap    = Object.fromEntries(issueStats.map((i) => [i._id, i.count]));
  const totalObligations = Object.values(oblMap).reduce((s, v) => s + v, 0);
  const passCount = oblMap["Pass"] || 0;
  const failCount = oblMap["Fail"] || 0;
  const notTested = oblMap["Not Tested"] || oblMap[""] || 0;
  const compliantPct = totalObligations > 0 ? +(( passCount / totalObligations) * 100).toFixed(1) : null;

  const totalOpenIssues = Object.values(issMap).reduce((s, v) => s + v, 0);

  res.json({
    success: true,
    data: {
      obligations: {
        total:        totalObligations,
        pass:         passCount,
        fail:         failCount,
        partial:      oblMap["Partial"] || 0,
        notTested,
        compliantPct,
      },
      issues: {
        open:        issMap["Open"]        || 0,
        inProgress:  issMap["In Progress"] || 0,
        underReview: issMap["Under Review"] || 0,
        totalOpen:   totalOpenIssues,
      },
    },
  });
});

/* ─── 3. GET /control-effectiveness ─────────────────────────────────────────
   Avg design + performance rating per domain from EWRA control assessments    */
exports.getControlEffectiveness = asyncHandler(async (req, res, next) => {
  const { entityId } = req.params;
  const client = req.user?.client?._id;

  const assessment = await resolveAssessment(entityId, client);
  if (!assessment) return res.json({ success: true, data: { byDomain: [], overall: null } });

  const [byDomain, overall] = await Promise.all([
    EwraControlAssessment.aggregate([
      { $match: { assessmentId: assessment._id, domain: { $ne: null } } },
      { $group: {
          _id: "$domain",
          avgDesign:       { $avg: "$designRating" },
          avgPerformance:  { $avg: "$performanceRating" },
          avgEffectiveness:{ $avg: "$effectivenessScore" },
          count:           { $sum: 1 },
          highly:  { $sum: { $cond: [{ $eq: ["$effectivenessLabel", "Highly Effective"] }, 1, 0] } },
          effective: { $sum: { $cond: [{ $eq: ["$effectivenessLabel", "Effective"] }, 1, 0] } },
          partial:   { $sum: { $cond: [{ $eq: ["$effectivenessLabel", "Partially Effective"] }, 1, 0] } },
          ineffective: { $sum: { $cond: [{ $eq: ["$effectivenessLabel", "Ineffective"] }, 1, 0] } },
      }},
      { $sort: { avgEffectiveness: 1 } },
    ]),
    EwraControlAssessment.aggregate([
      { $match: { assessmentId: assessment._id } },
      { $group: {
          _id: null,
          avgDesign:        { $avg: "$designRating" },
          avgPerformance:   { $avg: "$performanceRating" },
          avgEffectiveness: { $avg: "$effectivenessScore" },
          total:            { $sum: 1 },
          complete:         { $sum: { $cond: [{ $eq: ["$status", "Complete"] }, 1, 0] } },
      }},
    ]),
  ]);

  const ov = overall[0] || {};
  res.json({
    success: true,
    data: {
      overall: {
        avgDesign:        ov.avgDesign        ? +ov.avgDesign.toFixed(2)        : null,
        avgPerformance:   ov.avgPerformance   ? +ov.avgPerformance.toFixed(2)   : null,
        avgEffectiveness: ov.avgEffectiveness ? +ov.avgEffectiveness.toFixed(2) : null,
        total:            ov.total || 0,
        complete:         ov.complete || 0,
        completePct:      ov.total > 0 ? +(( ov.complete / ov.total) * 100).toFixed(1) : null,
      },
      byDomain: byDomain.map((d) => ({
        domain:           d._id,
        avgDesign:        d.avgDesign        ? +d.avgDesign.toFixed(2)        : null,
        avgPerformance:   d.avgPerformance   ? +d.avgPerformance.toFixed(2)   : null,
        avgEffectiveness: d.avgEffectiveness ? +d.avgEffectiveness.toFixed(2) : null,
        count:            d.count,
        highly:           d.highly,
        effective:        d.effective,
        partial:          d.partial,
        ineffective:      d.ineffective,
      })),
    },
  });
});

/* ─── 4. GET /regulatory-deadlines ──────────────────────────────────────────
   Upcoming obligation nextReviewDate deadlines (next 90 days, sorted asc)    */
exports.getRegulatoryDeadlines = asyncHandler(async (req, res, next) => {
  const { entityId } = req.params;
  const client = req.user?.client?._id;
  const days   = parseInt(req.query.days) || 90;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  const obligations = await EntityObligation.find({
    entityProfileId: entityId,
    client,
    status: { $in: ["Active", "Pending"] },
    nextReviewDate: { $gte: new Date(), $lte: cutoff },
  })
    .select("obligationId obligationCategory obligationDescription nextReviewDate testResult riskRating monitoringFrequency")
    .sort({ nextReviewDate: 1 })
    .lean();

  const overdue = await EntityObligation.find({
    entityProfileId: entityId,
    client,
    status: { $in: ["Active", "Pending"] },
    nextReviewDate: { $lt: new Date() },
    testResult: { $nin: ["Pass"] },
  })
    .select("obligationId obligationCategory obligationDescription nextReviewDate testResult riskRating")
    .sort({ nextReviewDate: 1 })
    .lean();

  res.json({
    success: true,
    data: {
      upcoming: obligations,
      overdue,
      upcomingCount: obligations.length,
      overdueCount:  overdue.length,
      windowDays:    days,
    },
  });
});

/* ─── 5. GET /top-risks ──────────────────────────────────────────────────────
   Top 5 risk factors by residualScore (highest = worst)                      */
exports.getTopRisks = asyncHandler(async (req, res, next) => {
  const { entityId } = req.params;
  const client = req.user?.client?._id;
  const limit  = parseInt(req.query.limit) || 5;

  const assessment = await resolveAssessment(entityId, client);
  if (!assessment) return res.json({ success: true, data: [] });

  const risks = await EwraRiskFactor.find({
    assessmentId: assessment._id,
    residualScore: { $ne: null },
  })
    .select("factorName category likelihood impact inherentScore inherentRating residualScore residualRating controlEffectiveness rationale")
    .sort({ residualScore: -1 })
    .limit(limit)
    .lean();

  res.json({ success: true, data: risks });
});

/* ─── 6. GET /issues ─────────────────────────────────────────────────────────
   Open + overdue issues by severity for this client                          */
exports.getIssues = asyncHandler(async (req, res, next) => {
  const client = req.user?.client?._id;

  const [bySeverity, byStatus, recent] = await Promise.all([
    IssueRegister.aggregate([
      { $match: { client, status: { $nin: ["Closed", "Accepted Risk"] } } },
      { $group: { _id: "$severity", count: { $sum: 1 } } },
    ]),
    IssueRegister.aggregate([
      { $match: { client } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    IssueRegister.find({ client, status: { $in: ["Open", "In Progress"] } })
      .select("issueId title severity status domain dueDate source")
      .sort({ severity: 1, dueDate: 1 })
      .limit(10)
      .lean(),
  ]);

  // overdue: dueDate < today and still open
  const overdue = await IssueRegister.countDocuments({
    client,
    status: { $in: ["Open", "In Progress"] },
    dueDate: { $lt: new Date() },
  });

  const sevMap    = Object.fromEntries(bySeverity.map((s) => [s._id, s.count]));
  const statusMap = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));

  res.json({
    success: true,
    data: {
      bySeverity: {
        Critical: sevMap["Critical"] || 0,
        High:     sevMap["High"]     || 0,
        Medium:   sevMap["Medium"]   || 0,
        Low:      sevMap["Low"]      || 0,
      },
      byStatus: statusMap,
      overdueCount: overdue,
      recentOpen: recent,
    },
  });
});

/* ─── 7. GET /testing-status ─────────────────────────────────────────────────
   Pass rate, overdue tests, next scheduled test                              */
exports.getTestingStatus = asyncHandler(async (req, res, next) => {
  const client = req.user?.client?._id;

  const [statusCounts, passRateAgg, nextScheduled, overdue] = await Promise.all([
    TestSchedule.aggregate([
      { $match: { client } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    TestSchedule.aggregate([
      { $match: { client, status: "Completed" } },
      { $group: {
          _id: null,
          total:  { $sum: 1 },
          passed: { $sum: { $cond: [{ $eq: ["$result", "Pass"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$result", "Fail"] }, 1, 0] } },
          partial: { $sum: { $cond: [{ $eq: ["$result", "Partial"] }, 1, 0] } },
      }},
    ]),
    TestSchedule.findOne({
      client,
      status: "Scheduled",
      scheduledDate: { $gte: new Date() },
    })
      .select("name domain testType scheduledDate assignedTo")
      .populate("assignedTo", "name")
      .sort({ scheduledDate: 1 })
      .lean(),
    TestSchedule.countDocuments({ client, status: "Overdue" }),
  ]);

  const pr  = passRateAgg[0] || { total: 0, passed: 0, failed: 0, partial: 0 };
  const statusMap = Object.fromEntries(statusCounts.map((s) => [s._id, s.count]));
  const passRate  = pr.total > 0 ? +(( pr.passed / pr.total) * 100).toFixed(1) : null;

  res.json({
    success: true,
    data: {
      byStatus: statusMap,
      passRate,
      passRateRaw: pr,
      overdueCount: overdue,
      nextScheduled,
    },
  });
});

/* ─── 8. GET /audit-readiness ────────────────────────────────────────────────
   Composite readiness % score weighted across 4 dimensions:
     obligations 30% | control effectiveness 30% | test pass rate 25% | open issues 15%  */
exports.getAuditReadiness = asyncHandler(async (req, res, next) => {
  const { entityId } = req.params;
  const client = req.user?.client?._id;

  const [obligationStats, controlStats, testStats, issueCount] = await Promise.all([
    EntityObligation.aggregate([
      { $match: { entityProfileId: new mongoose.Types.ObjectId(entityId), client } },
      { $group: { _id: "$testResult", count: { $sum: 1 } } },
    ]),
    EwraControlAssessment.aggregate([
      { $match: { client } },
      { $group: {
          _id: null,
          avgEff: { $avg: "$effectivenessScore" },
          total:  { $sum: 1 },
      }},
    ]),
    TestSchedule.aggregate([
      { $match: { client, status: "Completed" } },
      { $group: {
          _id: null,
          total:  { $sum: 1 },
          passed: { $sum: { $cond: [{ $eq: ["$result", "Pass"] }, 1, 0] } },
      }},
    ]),
    IssueRegister.countDocuments({
      client,
      status: { $in: ["Open", "In Progress"] },
      severity: { $in: ["Critical", "High"] },
    }),
  ]);

  const oblMap  = Object.fromEntries(obligationStats.map((o) => [o._id, o.count]));
  const totalObl = Object.values(oblMap).reduce((s, v) => s + v, 0);
  const oblScore = totalObl > 0
    ? (((oblMap["Pass"] || 0) + (oblMap["Partial"] || 0) * 0.5) / totalObl) * 100
    : 0;

  const ctrlData  = controlStats[0] || { avgEff: null };
  const ctrlScore = ctrlData.avgEff != null ? (ctrlData.avgEff / 5) * 100 : 0;

  const testData  = testStats[0] || { total: 0, passed: 0 };
  const testScore = testData.total > 0 ? (testData.passed / testData.total) * 100 : 0;

  // issue penalty: deduct 5 per critical/high open issue, capped at 100% penalty
  const issuePenalty = Math.min(issueCount * 5, 100);
  const issueScore   = Math.max(100 - issuePenalty, 0);

  const compositeScore = +(
    oblScore  * 0.30 +
    ctrlScore * 0.30 +
    testScore * 0.25 +
    issueScore* 0.15
  ).toFixed(1);

  const readinessLabel =
    compositeScore >= 85 ? "High Readiness" :
    compositeScore >= 65 ? "Moderate Readiness" :
    compositeScore >= 40 ? "Low Readiness" : "Not Ready";

  res.json({
    success: true,
    data: {
      compositeScore,
      readinessLabel,
      breakdown: {
        obligations:   { score: +oblScore.toFixed(1),   weight: 30, label: "Obligation Compliance" },
        controls:      { score: +ctrlScore.toFixed(1),  weight: 30, label: "Control Effectiveness" },
        testing:       { score: +testScore.toFixed(1),  weight: 25, label: "Test Pass Rate" },
        issues:        { score: +issueScore.toFixed(1), weight: 15, label: "Issue Health (inverted)" },
      },
      openCriticalHighIssues: issueCount,
    },
  });
});

/* ─── 9. GET /heatmap ────────────────────────────────────────────────────────
   5×5 matrix data for all risk factors (likelihood × impact grid)            */
exports.getHeatmap = asyncHandler(async (req, res, next) => {
  const { entityId } = req.params;
  const client = req.user?.client?._id;

  const assessment = await resolveAssessment(entityId, client);
  if (!assessment) return res.json({ success: true, data: { cells: [], factors: [] } });

  const factors = await EwraRiskFactor.find({
    assessmentId: assessment._id,
    likelihood: { $ne: null },
    impact:     { $ne: null },
  })
    .select("factorName category likelihood impact inherentScore inherentRating residualScore residualRating controlEffectiveness")
    .lean();

  // Build 5×5 grid cell aggregation
  const cells = {};
  for (let l = 1; l <= 5; l++) {
    for (let i = 1; i <= 5; i++) {
      cells[`${l}_${i}`] = { likelihood: l, impact: i, count: 0, factors: [], avgResidual: null };
    }
  }
  for (const f of factors) {
    const key = `${f.likelihood}_${f.impact}`;
    if (cells[key]) {
      cells[key].count++;
      cells[key].factors.push({
        name:           f.factorName,
        category:       f.category,
        residualScore:  f.residualScore,
        residualRating: f.residualRating,
      });
    }
  }
  // compute avgResidual per cell
  Object.values(cells).forEach((cell) => {
    const scored = cell.factors.filter((f) => f.residualScore != null);
    cell.avgResidual = scored.length
      ? +(scored.reduce((s, f) => s + f.residualScore, 0) / scored.length).toFixed(2)
      : null;
  });

  res.json({
    success: true,
    data: {
      assessmentId:   assessment._id,
      assessmentName: assessment.assessmentName,
      cells:          Object.values(cells),
      factors,
      totalFactors:   factors.length,
    },
  });
});

/* ─── 10. GET /kri-metrics ───────────────────────────────────────────────────
   Key Risk Indicators: SMR count, CDD completion %, test pass rate           */
exports.getKriMetrics = asyncHandler(async (req, res, next) => {
  const client = req.user?.client?._id;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const [
    smrCount,
    smrThisMonth,
    cddStats,
    testPassRate,
    highRiskCra,
    overdueTests,
    openCriticalIssues,
  ] = await Promise.all([

    // Total SMRs submitted (all time for client)
    SmrReport.countDocuments({ client }),

    // SMRs in last 30 days
    SmrReport.countDocuments({ client, createdAt: { $gte: thirtyDaysAgo } }),

    // CDD completion — customers with complete KYC vs total
    Customer.aggregate([
      { $match: { client } },
      { $group: {
          _id: "$kycStatus",
          count: { $sum: 1 },
      }},
    ]),

    // Test pass rate (last 90 days)
    TestSchedule.aggregate([
      { $match: {
          client,
          status: "Completed",
          scheduledDate: { $gte: ninetyDaysAgo },
      }},
      { $group: {
          _id: null,
          total:  { $sum: 1 },
          passed: { $sum: { $cond: [{ $eq: ["$result", "Pass"] }, 1, 0] } },
      }},
    ]),

    // High/Unacceptable CRA customers
    IndividualRiskAssessment.countDocuments({
      client,
      riskLabel: { $in: ["High", "Unacceptable"] },
    }),

    // Overdue tests
    TestSchedule.countDocuments({ client, status: "Overdue" }),

    // Open critical issues
    IssueRegister.countDocuments({
      client,
      status: { $in: ["Open", "In Progress"] },
      severity: "Critical",
    }),
  ]);

  const cddMap = Object.fromEntries(cddStats.map((c) => [c._id, c.count]));
  const totalCustomers = Object.values(cddMap).reduce((s, v) => s + v, 0);
  // Treat "Approved" or "Verified" as CDD complete
  const cddComplete = (cddMap["Approved"] || 0) + (cddMap["Verified"] || 0) + (cddMap["Complete"] || 0);
  const cddCompletePct = totalCustomers > 0 ? +(( cddComplete / totalCustomers) * 100).toFixed(1) : null;

  const testPr = testPassRate[0] || { total: 0, passed: 0 };
  const testPassRatePct = testPr.total > 0 ? +(( testPr.passed / testPr.total) * 100).toFixed(1) : null;

  res.json({
    success: true,
    data: {
      smr: {
        totalSubmitted: smrCount,
        last30Days:     smrThisMonth,
      },
      cdd: {
        totalCustomers,
        cddComplete,
        cddCompletePct,
        byStatus: cddMap,
      },
      testing: {
        passRate90Days: testPassRatePct,
        completed90Days: testPr.total,
        overdueTests,
      },
      risk: {
        highRiskCustomers: highRiskCra,
        openCriticalIssues,
      },
    },
  });
});
