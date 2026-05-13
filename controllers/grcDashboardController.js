const asyncHandler          = require("../middleware/async");
const Control               = require("../models/Control");
const EwraAssessment        = require("../models/EwraAssessment");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const TestSchedule          = require("../models/TestSchedule");
const IssueRegister         = require("../models/IssueRegister");
const CountryRisk           = require("../models/CountryRisk");
const EntityProfile         = require("../models/EntityProfile");

// GET /dashboard/summary
exports.getDashboardSummary = asyncHandler(async (req, res) => {
  const client = req.user?.client?._id;

  const [
    controlStats,
    ewraStats,
    craStats,
    testStats,
    issueStats,
    entityCount,
    countryRiskDist,
    recentIssues,
    recentTests,
    testTrend,
    issueTrend,
    craByRisk,
    testByDomain,
    issueByDomain,
  ] = await Promise.all([

    // ── Controls ──────────────────────────────────────────────────────────────
    Control.aggregate([
      { $match: { active: true } },
      { $group: {
          _id: "$domain",
          count: { $sum: 1 },
      }},
      { $sort: { count: -1 } },
    ]),

    // ── EWRA Assessments ──────────────────────────────────────────────────────
    EwraAssessment.aggregate([
      { $match: { client } },
      { $group: {
          _id: "$status",
          count: { $sum: 1 },
          avgResidual: { $avg: "$residualRiskScore" },
      }},
    ]),

    // ── CRA by risk label ─────────────────────────────────────────────────────
    IndividualRiskAssessment.aggregate([
      { $match: { client } },
      { $group: {
          _id: "$riskLabel",
          count: { $sum: 1 },
          avgScore: { $avg: "$riskScore" },
      }},
    ]),

    // ── Test Schedule counts ──────────────────────────────────────────────────
    TestSchedule.aggregate([
      { $match: { client } },
      { $group: {
          _id: "$status",
          count: { $sum: 1 },
      }},
    ]),

    // ── Issues by severity ────────────────────────────────────────────────────
    IssueRegister.aggregate([
      { $match: { client } },
      { $group: {
          _id: "$severity",
          count: { $sum: 1 },
      }},
    ]),

    // ── Entity count ──────────────────────────────────────────────────────────
    EntityProfile.countDocuments({ client }),

    // ── Country Risk distribution ─────────────────────────────────────────────
    CountryRisk.aggregate([
      { $match: { active: true } },
      { $group: { _id: "$band", count: { $sum: 1 } } },
    ]),

    // ── Recent open issues ────────────────────────────────────────────────────
    IssueRegister.find({ client, status: { $in: ["Open", "In Progress"] } })
      .select("issueId title severity status dueDate domain")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),

    // ── Recent test schedules ─────────────────────────────────────────────────
    TestSchedule.find({ client })
      .select("name status result scheduledDate domain testType")
      .sort({ scheduledDate: -1 })
      .limit(5)
      .lean(),

    // ── Test pass-rate trend (last 6 months, completed tests) ─────────────────
    TestSchedule.aggregate([
      {
        $match: {
          client,
          status: "Completed",
          scheduledDate: { $gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) },
        },
      },
      {
        $group: {
          _id: {
            year:  { $year:  "$scheduledDate" },
            month: { $month: "$scheduledDate" },
          },
          total:  { $sum: 1 },
          passed: { $sum: { $cond: [{ $eq: ["$result", "Pass"] }, 1, 0] } },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    // ── Issues opened trend (last 6 months) ───────────────────────────────────
    IssueRegister.aggregate([
      {
        $match: {
          client,
          createdAt: { $gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) },
        },
      },
      {
        $group: {
          _id: {
            year:  { $year:  "$createdAt" },
            month: { $month: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    // ── CRA by risk label ─────────────────────────────────────────────────────
    IndividualRiskAssessment.aggregate([
      { $match: { client } },
      { $group: { _id: "$riskLabel", count: { $sum: 1 } } },
    ]),

    // ── Tests by domain ───────────────────────────────────────────────────────
    TestSchedule.aggregate([
      { $match: { client, domain: { $ne: null } } },
      { $group: {
          _id: "$domain",
          total:  { $sum: 1 },
          passed: { $sum: { $cond: [{ $eq: ["$result", "Pass"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$result", "Fail"] }, 1, 0] } },
      }},
      { $sort: { total: -1 } },
      { $limit: 10 },
    ]),

    // ── Issues by domain ──────────────────────────────────────────────────────
    IssueRegister.aggregate([
      { $match: { client, domain: { $ne: null }, status: { $nin: ["Closed"] } } },
      { $group: { _id: "$domain", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);

  // ── Shape the response ────────────────────────────────────────────────────
  const toMap = (arr) => Object.fromEntries(arr.map((x) => [x._id, x.count]));

  const totalControls = controlStats.reduce((s, d) => s + d.count, 0);
  const totalCra      = craStats.reduce((s, d) => s + d.count, 0);
  const ewraStatusMap = toMap(ewraStats.map((x) => ({ _id: x._id, count: x.count })));
  const testStatusMap = toMap(testStats);
  const issueMap      = toMap(issueStats);
  const craMap        = toMap(craByRisk);

  // pass-rate overall
  const completedTests = testStats.find((s) => s._id === "Completed")?.count || 0;
  const passRateAgg = await TestSchedule.aggregate([
    { $match: { client, status: "Completed" } },
    { $group: {
        _id: null,
        total:  { $sum: 1 },
        passed: { $sum: { $cond: [{ $eq: ["$result", "Pass"] }, 1, 0] } },
    }},
  ]);
  const passRateData = passRateAgg[0] || { total: 0, passed: 0 };
  const passRate = passRateData.total > 0
    ? Math.round((passRateData.passed / passRateData.total) * 100)
    : null;

  // month labels for trend
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const testTrendFormatted = testTrend.map((t) => ({
    month: `${MONTHS[t._id.month - 1]} ${t._id.year}`,
    total: t.total,
    passed: t.passed,
    rate: t.total > 0 ? Math.round((t.passed / t.total) * 100) : 0,
  }));
  const issueTrendFormatted = issueTrend.map((t) => ({
    month: `${MONTHS[t._id.month - 1]} ${t._id.year}`,
    count: t.count,
  }));

  res.json({
    success: true,
    data: {
      // Top KPIs
      kpi: {
        entities:      entityCount,
        totalControls,
        totalCra,
        openIssues:    (issueMap["Critical"] || 0) + (issueMap["High"] || 0) + (issueMap["Medium"] || 0) + (issueMap["Low"] || 0),
        criticalIssues: issueMap["Critical"] || 0,
        passRate,
        ewraApproved:  ewraStatusMap["Approved"] || 0,
        ewraDraft:     ewraStatusMap["Draft"] || 0,
      },

      // EWRA
      ewra: {
        byStatus: ewraStatusMap,
        avgResidual: ewraStats.find((s) => s._id === "Approved")?.avgResidual || null,
      },

      // CRA distribution
      cra: {
        byRisk: {
          Low:          craMap["Low"]          || 0,
          Medium:       craMap["Medium"]        || 0,
          High:         craMap["High"]          || 0,
          Unacceptable: craMap["Unacceptable"]  || 0,
        },
        total: totalCra,
      },

      // Testing
      testing: {
        byStatus: testStatusMap,
        passRate,
        passRateRaw: passRateData,
        byDomain: testByDomain,
        trend: testTrendFormatted,
      },

      // Issues
      issues: {
        bySeverity: {
          Critical: issueMap["Critical"] || 0,
          High:     issueMap["High"]     || 0,
          Medium:   issueMap["Medium"]   || 0,
          Low:      issueMap["Low"]      || 0,
        },
        byDomain: issueByDomain,
        trend: issueTrendFormatted,
        recent: recentIssues,
      },

      // Controls
      controls: {
        total: totalControls,
        byDomain: controlStats,
      },

      // Country Risk
      countryRisk: {
        distribution: toMap(countryRiskDist),
      },

      // Recent activity
      recentTests,
    },
  });
});
