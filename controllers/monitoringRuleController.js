"use strict";

const asyncHandler  = require("../middleware/async");
const MonitoringRule = require("../models/MonitoringRule");
const ErrorResponse  = require("../utils/errorResponse");

const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// @desc  List monitoring rules
// @route GET /api/v1/monitoring-rule
exports.listRules = asyncHandler(async (req, res) => {
  const { category, severity, entityType, riskType, active } = req.query;

  const filter = {};
  if (category)   filter.ruleCategory = category;
  if (severity)   filter.severity     = severity;
  if (riskType)   filter.riskType     = riskType;
  if (entityType) filter.entityTypes  = entityType;
  if (active !== undefined) filter.active = active === "true";

  const rules = await MonitoringRule.find(filter).sort({ severity: 1, ruleId: 1 }).lean();
  res.status(200).json({ success: true, count: rules.length, data: rules });
});

// @desc  Get single monitoring rule
// @route GET /api/v1/monitoring-rule/:id
exports.getRule = asyncHandler(async (req, res, next) => {
  const rule = await MonitoringRule.findOne({ $or: [
    { _id: req.params.id.match(/^[a-f\d]{24}$/i) ? req.params.id : null },
    { ruleId: req.params.id },
  ]}).lean();
  if (!rule) return next(new ErrorResponse("Monitoring rule not found", 404));
  res.status(200).json({ success: true, data: rule });
});

// @desc  Toggle active status
// @route PATCH /api/v1/monitoring-rule/:id/toggle
exports.toggleActive = asyncHandler(async (req, res, next) => {
  const rule = await MonitoringRule.findOne({ $or: [
    { _id: req.params.id.match(/^[a-f\d]{24}$/i) ? req.params.id : null },
    { ruleId: req.params.id },
  ]});
  if (!rule) return next(new ErrorResponse("Monitoring rule not found", 404));
  rule.active = !rule.active;
  await rule.save();
  res.status(200).json({ success: true, data: rule });
});

// @desc  Update rule thresholds / metadata
// @route PUT /api/v1/monitoring-rule/:id
exports.updateRule = asyncHandler(async (req, res, next) => {
  const allowed = ["threshold", "lookbackDays", "actionRequired", "active", "severity"];
  const update  = {};
  allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

  const rule = await MonitoringRule.findOneAndUpdate(
    { $or: [
      { _id: req.params.id.match(/^[a-f\d]{24}$/i) ? req.params.id : null },
      { ruleId: req.params.id },
    ]},
    update,
    { new: true, runValidators: true }
  );
  if (!rule) return next(new ErrorResponse("Monitoring rule not found", 404));
  res.status(200).json({ success: true, data: rule });
});
