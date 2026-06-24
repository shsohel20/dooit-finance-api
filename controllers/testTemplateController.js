const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const TestTemplate = require("../models/TestTemplate");

// GET /test-template
exports.getTemplates = asyncHandler(async (req, res) => {
  const { domain, testType, search, page = 1, limit = 50 } = req.query;
  const client = req.user?.client?._id;

  const filter = { client, active: true };
  if (domain)   filter.domain   = domain;
  if (testType) filter.testType = testType;
  if (search)   filter.$or = [
    { name:        { $regex: search, $options: "i" } },
    { description: { $regex: search, $options: "i" } },
  ];

  const options = {
    page:     parseInt(page),
    limit:    parseInt(limit),
    sort:     { domain: 1, name: 1 },
    populate: [{ path: "controlRef", select: "controlId title domain" }],
  };

  const result = await TestTemplate.paginate(filter, options);
  res.json({
    success: true,
    pagination: { page: result.page, total: result.totalDocs, totalPages: result.totalPages },
    data: result.docs,
  });
});

// GET /test-template/:id
exports.getTemplate = asyncHandler(async (req, res, next) => {
  const doc = await TestTemplate.findById(req.params.id)
    .populate("controlRef", "controlId title domain")
    .populate("createdBy",  "name email");
  if (!doc) return next(new ErrorResponse("Template not found", 404));
  res.json({ success: true, data: doc });
});

// POST /test-template
exports.createTemplate = asyncHandler(async (req, res) => {
  console.log(req.body)
  const doc = await TestTemplate.create({
    ...req.body,
    client:    req.user?.client?._id,
    createdBy: req.user?._id,
  });
  res.status(201).json({ success: true, data: doc });
});

// PUT /test-template/:id
exports.updateTemplate = asyncHandler(async (req, res, next) => {
  const doc = await TestTemplate.findByIdAndUpdate(req.params.id, req.body, {
    new: true, runValidators: true,
  });
  if (!doc) return next(new ErrorResponse("Template not found", 404));
  res.json({ success: true, data: doc });
});

// DELETE /test-template/:id
exports.deleteTemplate = asyncHandler(async (req, res, next) => {
  const doc = await TestTemplate.findByIdAndUpdate(
    req.params.id, { active: false }, { new: true }
  );
  if (!doc) return next(new ErrorResponse("Template not found", 404));
  res.json({ success: true, data: doc._id });
});
