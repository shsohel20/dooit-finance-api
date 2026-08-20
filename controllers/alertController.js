// controllers/alertController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Alert = require("../models/Alert");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog");
const Customer = require("../models/Customer");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { linkTransactionsToCase } = require("../utils/transactionCaseLink");
const { auditContext } = require("../utils/auditContext");
const { logEvent } = require("../utils/audit");

// Maps Alert.riskLabel → Case.priority
const mapRiskToPriority = (riskLabel) => {
  const r = (riskLabel || "").toLowerCase();
  if (r === "critical") return "critical";
  if (r === "high") return "high";
  if (r === "medium") return "medium";
  if (r === "low") return "low";
  return "medium";
};

// Maps Alert.caseType → Case.type enum
const mapAlertTypeToCase = (caseType) => {
  const t = (caseType || "").toLowerCase().replace(/\s+/g, "_");
  if (t === "sar") return "SAR";
  if (t === "pep") return "PEP";
  if (t === "transaction_monitoring") return "transaction_monitoring";
  return "other";
};

const VALID_CASE_TYPES = ["Fraud", "AML", "Compliance", "TF"];
const sanitizeCaseType = (val) => (VALID_CASE_TYPES.includes(val) ? val : null);

// @desc   Get all alerts
// @route  GET /api/v1/alerts
// @access Private
exports.getAlerts = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Alert']
  #swagger.summary = 'Get All Alerts'
  */
  res.status(200).json(res.advancedResults);
});

// @desc   Get all alerts via POST
// @route  POST /api/v1/alerts/search
// @access Private
exports.getAlertsPost = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Search Alerts'
  */
  res.status(200).json(res.advancedResults);
});

// @desc   Create single alert
// @route  POST /api/v1/alerts
// @access Private
exports.createAlert = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Create Alert'
    #swagger.security = [{ "BearerAuth": [] }]
  */
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const user = req?.user?._id || null;

  const {
    customerId,
    transactionId,
    ruleRef,
    ruleId,
    ruleName,
    ruleVersion,
    ruleMeta,
    explanation,
    caseType,
    riskScore,
    riskLabel,
    priority,
    deduplicationKey,
    slaDeadline,
    activity = [],
    metadata,
    status,
  } = req.body;

  const customer = customerId ? await Customer.findById(customerId) : null;
  if (customerId && !customer) {
    return next(new ErrorResponse(`Customer not found with id ${customerId}`, 404));
  }

  let transaction = null;
  if (transactionId) {
    transaction = await Transaction.findById(transactionId).select("_id").lean();
    if (!transaction) {
      return next(new ErrorResponse(`Transaction not found with id ${transactionId}`, 404));
    }
  }

  const alert = await Alert.create({
    client,
    branch,
    customer: customer?._id || null,
    transaction: transaction?._id || null,
    ruleRef: ruleRef || null,
    ruleId: ruleId || null,
    ruleName: ruleName || null,
    ruleVersion: ruleVersion || null,
    ruleMeta: ruleMeta || {},
    explanation: explanation || null,
    caseType: caseType || null,
    riskScore: riskScore || 0,
    riskLabel: riskLabel || "Low",
    priority: priority || "medium",
    deduplicationKey: deduplicationKey || undefined,
    slaDeadline: slaDeadline || null,
    activity,
    metadata: metadata || {},
    createdBy: user,
    status: status || "new",
  });

  // Telemetry: if this alert was fired by a RuleEngine rule, bump its counters.
  // Best-effort — never block alert creation on a telemetry failure.
  if (ruleRef) {
    try {
      const RuleEngine = require("../models/RuleEngine");
      await RuleEngine.updateOne(
        { _id: ruleRef },
        { $set: { lastFiredAt: new Date() }, $inc: { hitCount: 1 } }
      );
    } catch (e) {
      console.error("[alert] rule telemetry update failed:", e.message);
    }
  }

  logEvent({
    req,
    service: "alert",
    action: "alert_created",
    alert: alert._id,
    customer: alert.customer || undefined,
    target: alert.uid,
  });

  res.status(201).json({ succeed: true, data: alert, id: alert._id });
});

// @desc   Create dummy alert (for testing / demo)
// @route  POST /api/v1/alerts/dummy
// @access Private
exports.createDummyAlert = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Create Dummy Alert'
  */
  const {
    customerName,
    analystName,
    transactionId,
    caseType,
    status = "new",
    riskScore = Math.floor(Math.random() * 100),
    riskLabel = "Medium",
    activity = [],
  } = req.body;

  const userDoc = customerName ? await User.findOne({ name: customerName }) : null;
  const customer = userDoc ? await Customer.findOne({ user: userDoc._id }) : null;
  const transaction = transactionId ? await Transaction.findOne({ uid: transactionId }) : null;
  const analyst = analystName ? await User.findOne({ name: analystName }) : null;

  if (!customer) return next(new ErrorResponse("Customer not found", 404));
  if (!transaction) return next(new ErrorResponse("Transaction not found", 404));

  const alert = await Alert.create({
    customer: customer._id,
    transaction: transaction._id,
    analyst: analyst?._id || null,
    caseType: caseType || "Default",
    riskScore,
    riskLabel,
    activity,
    status,
  });

  res.status(201).json({ succeed: true, data: alert, id: alert._id });
});

// @desc   Get single alert by id
// @route  GET /api/v1/alerts/:id
// @access Private
exports.getAlert = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .populate("customer")
    .populate("analyst")
    .populate("transaction")
    .populate("ruleRef", "name version caseType")
    .populate("linkedCase", "uid title status");

  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  res.status(200).json({ succeed: true, data: alert });
});

// @desc   Update single alert
// @route  PUT /api/v1/alerts/:id
// @access Private
exports.updateAlert = asyncHandler(async (req, res, next) => {
  const alertId = req.params.id;
  const alert = await Alert.findOne({ _id: alertId, isDeleted: { $ne: true } });

  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${alertId}`, 404));
  }

  const allowedFields = [
    "caseType",
    "riskScore",
    "riskLabel",
    "priority",
    "status",
    "statusReason",
    "analyst",
    "slaDeadline",
    "slaStatus",
    "explanation",
    "metadata",
  ];

  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse("No valid fields provided for update", 400));
  }

  const updated = await Alert.findByIdAndUpdate(alertId, updates, {
    new: true,
    runValidators: true,
  });

  const auditedKeys = ["status", "riskScore", "riskLabel", "priority", "analyst"];
  const beforeValue = {};
  const afterValue = {};
  auditedKeys.forEach((k) => {
    if (
      updates[k] !== undefined &&
      JSON.stringify(alert[k]) !== JSON.stringify(updated[k])
    ) {
      beforeValue[k] = alert[k];
      afterValue[k] = updated[k];
    }
  });
  if (Object.keys(afterValue).length) {
    logEvent({
      req,
      service: "alert",
      action: "alert_updated",
      alert: updated._id,
      customer: updated.customer || undefined,
      beforeValue,
      afterValue,
    });
  }

  res.status(200).json({ succeed: true, data: updated });
});

// @desc   Soft-delete an alert
// @route  DELETE /api/v1/alerts/:id
// @access Private
exports.deleteAlert = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  alert.isDeleted = true;
  alert.deletedAt = new Date();
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_deleted",
    alert: alert._id,
    customer: alert.customer || undefined,
    beforeValue: { uid: alert.uid, status: alert.status },
  });

  res.status(200).json({ succeed: true, data: req.params.id });
});

// @desc   Assign an analyst to an alert
// @route  PUT /api/v1/alerts/:id/assign-analyst
// @access Private
exports.assignAnalyst = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Assign Analyst to Alert'
  */
  const alertId = req.params.id;
  const { analystId } = req.body;

  if (!analystId) {
    return next(new ErrorResponse("analystId is required", 400));
  }

  const alert = await Alert.findOne({ _id: alertId, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${alertId}`, 404));
  }

  const analyst = await User.findById(analystId);
  if (!analyst) {
    return next(new ErrorResponse(`Analyst not found with id ${analystId}`, 404));
  }

  alert.analyst = analyst._id;
  alert.activity.push({
    type: "activity",
    title: "Analyst assigned",
    message: `${analyst.name} assigned by ${req.user.name || req.user._id}`,
    createdBy: req.user._id,
  });
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_assigned",
    alert: alert._id,
    customer: alert.customer || undefined,
    afterValue: { analyst: analyst.name || analyst._id },
  });

  res.status(200).json({
    succeed: true,
    message: `Analyst ${analyst.name} assigned to alert ${alert.uid}`,
    data: alert,
  });
});

// @desc   ECCD Dummy Data for Presentation
// @route  GET /api/v1/alerts/:caseNumber/eccd-dummy
// @access Private
exports.getDummyEccdData = asyncHandler(async (req, res, next) => {
  const { caseNumber } = req.params;

  const alert = await Alert.findOne({ uid: caseNumber, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with Case Number ${caseNumber}`, 404));
  }

  let eccdData = alert.metadata?.ecddReport || null;
  let usedFallback = false;
  let sourceUid = null;

  if (!eccdData) {
    const samples = await Alert.aggregate([
      {
        $match: {
          _id: { $ne: alert._id },
          isDeleted: { $ne: true },
          "metadata.ecddReport": { $ne: null },
        },
      },
      { $sample: { size: 1 } },
      { $project: { uid: 1, "metadata.ecddReport": 1 } },
    ]);

    if (samples.length > 0) {
      eccdData = samples[0].metadata.ecddReport;
      sourceUid = samples[0].uid;
      usedFallback = true;

      if (!alert.metadata) alert.metadata = {};
      alert.metadata.ecddReport = eccdData;
      alert.markModified("metadata");
      await alert.save();
    }
  }

  if (!eccdData) {
    return res.status(200).json({ succeed: false, data: null, message: "No ECCD data available." });
  }

  res.status(200).json({
    succeed: true,
    data: eccdData,
    message: usedFallback
      ? `ECCD copied from alert ${sourceUid} and saved to alert ${alert.uid}`
      : `ECCD returned from alert ${alert.uid}`,
  });
});

// @desc   Mark alert as under review (analyst picks it up)
// @route  PUT /api/v1/alerts/:id/review
// @access Private
exports.reviewAlert = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  if (alert.status !== "new") {
    return next(new ErrorResponse(`Alert is already in status "${alert.status}"`, 400));
  }

  alert.status = "under_review";
  if (!alert.analyst) alert.analyst = req.user._id;
  alert.activity.push({
    type: "activity",
    title: "Review started",
    message: `Picked up for review by ${req.user.name || req.user._id}`,
    createdBy: req.user._id,
  });
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_review_started",
    alert: alert._id,
    customer: alert.customer || undefined,
    afterValue: { analyst: alert.analyst },
  });

  res.status(200).json({ succeed: true, data: alert });
});

// @desc   Dismiss an alert
// @route  PUT /api/v1/alerts/:id/dismiss
// @access Private
exports.dismissAlert = asyncHandler(async (req, res, next) => {
  const { reason = "false_positive", note } = req.body;
  const validDismissals = ["dismissed", "false_positive"];

  if (!validDismissals.includes(reason)) {
    return next(new ErrorResponse(`reason must be one of: ${validDismissals.join(", ")}`, 400));
  }

  const alert = await Alert.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  if (alert.status === "escalated_to_case") {
    return next(new ErrorResponse("Cannot dismiss an alert that has been escalated to a case", 400));
  }

  const previousStatus = alert.status;
  alert.status = reason;
  alert.closedAt = new Date();
  if (note) alert.statusReason = note;
  if (!alert.analyst) alert.analyst = req.user._id;
  alert.activity.push({
    type: "activity",
    title: reason === "false_positive" ? "Marked false positive" : "Dismissed",
    message: `By ${req.user.name || req.user._id}${note ? `. Note: ${note}` : ""}`,
    createdBy: req.user._id,
  });
  await alert.save();

  logEvent({
    req,
    service: "alert",
    action: "alert_dismissed",
    alert: alert._id,
    customer: alert.customer || undefined,
    beforeValue: { status: previousStatus },
    afterValue: { status: alert.status, reason, note: note || undefined },
  });

  res.status(200).json({ succeed: true, data: alert });
});

// @desc   Escalate an alert to a new investigation case
// @route  POST /api/v1/alerts/:id/escalate
// @access Private — admin / compliance_officer
exports.escalateAlertToCase = asyncHandler(async (req, res, next) => {
  const tenant = {
    client: req?.user?.client?._id || null,
    branch: req?.user?.branch?._id || null,
  };

  const alertFilter = { _id: req.params.id, isDeleted: { $ne: true } };
  if (tenant.client) alertFilter.client = tenant.client;

  const alert = await Alert.findOne(alertFilter)
    .populate("customer", "name email")
    .populate("transaction", "uid amount type");

  if (!alert) {
    return next(new ErrorResponse(`Alert not found with id ${req.params.id}`, 404));
  }

  if (alert.linkedCase) {
    return next(
      new ErrorResponse(`Alert ${alert.uid} is already linked to case ${alert.linkedCase}`, 400)
    );
  }

  const {
    title = `Investigation — ${alert.uid}`,
    description,
    priority = mapRiskToPriority(alert.riskLabel),
    type = mapAlertTypeToCase(alert.caseType),
    assignedTo,
  } = req.body;

  const newCase = await Case.create({
    ...tenant,
    title,
    description,
    priority,
    type,
    caseType: sanitizeCaseType(alert.caseType),
    linkedAlerts: [alert._id],
    // Primary customer (POI) — the escalated alert's customer.
    customer: alert.customer ? alert.customer._id : null,
    linkedCustomers: alert.customer ? [alert.customer._id] : [],
    linkedTransactions: alert.transaction ? [alert.transaction._id] : [],
    riskScore: alert.riskScore || null,
    riskLabel: alert.riskLabel || null,
    assignedTo: assignedTo || null,
    createdBy: req.user._id,
  });

  // Sync the alert's transaction → Case (investigation.case + flagged)
  if (alert.transaction) {
    await linkTransactionsToCase([alert.transaction._id || alert.transaction], newCase);
  }

  alert.status = "escalated_to_case";
  alert.linkedCase = newCase._id;
  if (!alert.analyst) alert.analyst = req.user._id;
  alert.activity.push({
    type: "activity",
    title: "Escalated to case",
    message: `Case "${title}" created by ${req.user.name || req.user._id}`,
    createdBy: req.user._id,
  });
  await alert.save();

  await AuditLog.create({
    ...tenant,
    case: newCase._id,
    user: req.user._id,
    action: "case_created",
    details: `Case created by escalating alert ${alert.uid} (${alert.riskLabel || ""} ${alert.caseType || ""})`,
    ...auditContext(req),
  });

  logEvent({
    req,
    service: "alert",
    action: "alert_escalated",
    alert: alert._id,
    case: newCase._id,
    customer: alert.customer?._id || undefined,
    target: alert.uid,
  });

  const populated = await Case.findById(newCase._id)
    .populate("createdBy", "name email avatar")
    .populate("assignedTo", "name email avatar")
    .populate("linkedAlerts", "uid caseType riskScore riskLabel status")
    .lean();

  res.status(201).json({ succeed: true, data: populated });
});
