"use strict";

const asyncHandler = require("../middleware/async");
const AuditLog = require("../models/AuditLog");

// ── GET /audit ────────────────────────────────────────────────────────────────
// Global activity feed over the AuditLog collection — who did what, from
// which IP and device. advancedResults auto-scopes on client/branch from
// req.user, so a client sees their tenant's activity and dooit sees all.
// Filters via the standard query language: ?service= ?action= ?status=
// ?user= ?actor= ?deviceId= ?case= ?customer= plus select/sort/page/limit
// and createdAt[gte]/createdAt[lte] date windows.
// @access AUDIT.GET
exports.getAuditActivity = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// ── GET /audit/summary ────────────────────────────────────────────────────────
// Small rollup for the activity dashboard: totals by service, failed logins
// in the last 24h, distinct devices and IPs seen in the last 7 days.
// Tenant-scoped the same way (client/branch from req.user; dooit unscoped).
// @access AUDIT.GET
exports.getAuditSummary = asyncHandler(async (req, res, next) => {
  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;
  const branch = req.user?.branch?._id ?? req.user?.branchBelongs ?? null;
  const tenant = {
    ...(client && { client }),
    ...(branch && { branch }),
  };

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [byService, failedLogins24h, devices7d, ips7d] = await Promise.all([
    AuditLog.aggregate([
      { $match: tenant },
      { $group: { _id: "$service", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    AuditLog.countDocuments({
      ...tenant,
      service: "auth",
      action: "login_failed",
      createdAt: { $gte: dayAgo },
    }),
    AuditLog.distinct("deviceId", {
      ...tenant,
      deviceId: { $ne: null },
      createdAt: { $gte: weekAgo },
    }),
    AuditLog.distinct("ip", {
      ...tenant,
      ip: { $ne: null },
      createdAt: { $gte: weekAgo },
    }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      byService: byService.map((s) => ({ service: s._id, count: s.count })),
      failedLogins24h,
      distinctDevices7d: devices7d.length,
      distinctIps7d: ips7d.length,
    },
  });
});
