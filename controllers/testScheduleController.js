const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const TestSchedule = require("../models/TestSchedule");
const TestTemplate = require("../models/TestTemplate");

// GET /test-schedule
exports.getSchedules = asyncHandler(async (req, res) => {
  const { status, domain, assignedTo, page = 1, limit = 20 } = req.query;
  const client = req.user?.client?._id;

  const filter = { client };
  if (status)     filter.status     = status;
  if (domain)     filter.domain     = domain;
  if (assignedTo) filter.assignedTo = assignedTo;

  const options = {
    page:     parseInt(page),
    limit:    parseInt(limit),
    sort:     { scheduledDate: 1 },
    populate: [
      { path: "template",      select: "name domain testType" },
      { path: "control",       select: "controlId title domain" },
      { path: "assignedTo",    select: "name email" },
      { path: "entityProfile", select: "entityName" },
    ],
  };

  const result = await TestSchedule.paginate(filter, options);
  res.json({
    success: true,
    pagination: { page: result.page, total: result.totalDocs, totalPages: result.totalPages },
    data: result.docs,
  });
});

// GET /test-schedule/summary — counts by status
exports.getSummary = asyncHandler(async (req, res) => {
  const client = req.user?.client?._id;
  const summary = await TestSchedule.aggregate([
    { $match: { client } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(summary.map((s) => [s._id, s.count]));
  const passRate = await TestSchedule.aggregate([
    { $match: { client, status: "Completed", result: { $in: ["Pass", "Partial", "Fail"] } } },
    { $group: {
        _id: null,
        total: { $sum: 1 },
        passed: { $sum: { $cond: [{ $eq: ["$result", "Pass"] }, 1, 0] } },
      }},
  ]);
  res.json({ success: true, data: { counts, passRate: passRate[0] || null } });
});

// GET /test-schedule/:id
exports.getSchedule = asyncHandler(async (req, res, next) => {
  const doc = await TestSchedule.findById(req.params.id)
    .populate("template",       "name domain testType testingProcedure expectedEvidence")
    .populate("control",        "controlId title domain fatfRecommendations")
    .populate("assignedTo",     "name email")
    .populate("completedBy",    "name email")
    .populate("entityProfile",  "entityName entityType")
    .populate("ewraAssessment", "assessmentName");
  if (!doc) return next(new ErrorResponse("Test schedule not found", 404));
  res.json({ success: true, data: doc });
});

// POST /test-schedule
exports.createSchedule = asyncHandler(async (req, res) => {
  const client = req.user?.client?._id;

  // If template supplied, copy procedure + metadata
  let extra = {};
  if (req.body.template) {
    const tmpl = await TestTemplate.findById(req.body.template).lean();
    if (tmpl) extra = {
      testingProcedure: tmpl.testingProcedure,
      testType:         tmpl.testType,
      domain:           tmpl.domain,
    };
  }

  const doc = await TestSchedule.create({
    ...extra,
    ...req.body,
    client,
    createdBy: req.user?._id,
  });
  res.status(201).json({ success: true, data: doc });
});

// PUT /test-schedule/:id
exports.updateSchedule = asyncHandler(async (req, res, next) => {
  const updates = { ...req.body };

  // If marking complete, set completedAt + completedBy
  if (updates.status === "Completed" && !updates.completedAt) {
    updates.completedAt = new Date();
    updates.completedBy = req.user?._id;
  }

  const doc = await TestSchedule.findByIdAndUpdate(req.params.id, updates, {
    new: true, runValidators: true,
  });
  if (!doc) return next(new ErrorResponse("Test schedule not found", 404));
  res.json({ success: true, data: doc });
});

// DELETE /test-schedule/:id
exports.deleteSchedule = asyncHandler(async (req, res, next) => {
  const doc = await TestSchedule.findByIdAndUpdate(
    req.params.id, { status: "Cancelled" }, { new: true }
  );
  if (!doc) return next(new ErrorResponse("Test schedule not found", 404));
  res.json({ success: true, data: doc._id });
});
