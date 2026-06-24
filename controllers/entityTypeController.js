const asyncHandler = require("../middleware/async");
const EntityType = require("../models/EntityType");
const ErrorResponse = require("../utils/errorResponse");
const { invalidateCache } = require("../utils/entityTypeResolver");

// @desc   Get all entity types
// @route  GET /api/v1/entity-type
// @access Protected
exports.getEntityTypes = asyncHandler(async (req, res) => {
  const filter = { active: true };
  if (req.query.category) filter.category = req.query.category;

  const types = await EntityType.find(filter).sort({ category: 1, name: 1 });

  res.status(200).json({ success: true, count: types.length, data: types });
});

// @desc   Get single entity type
// @route  GET /api/v1/entity-type/:id
// @access Protected
exports.getEntityType = asyncHandler(async (req, res, next) => {
  const type = await EntityType.findById(req.params.id);
  if (!type) return next(new ErrorResponse("Entity type not found", 404));
  res.status(200).json({ success: true, data: type });
});

// @desc   Create entity type
// @route  POST /api/v1/entity-type
// @access Protected
exports.createEntityType = asyncHandler(async (req, res) => {
  const type = await EntityType.create(req.body);
  invalidateCache();
  res.status(201).json({ success: true, data: type });
});

// @desc   Update entity type
// @route  PUT /api/v1/entity-type/:id
// @access Protected
exports.updateEntityType = asyncHandler(async (req, res, next) => {
  const type = await EntityType.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!type) return next(new ErrorResponse("Entity type not found", 404));
  invalidateCache();
  res.status(200).json({ success: true, data: type });
});

// @desc   Delete entity type
// @route  DELETE /api/v1/entity-type/:id
// @access Protected
exports.deleteEntityType = asyncHandler(async (req, res, next) => {
  const type = await EntityType.findByIdAndDelete(req.params.id);
  if (!type) return next(new ErrorResponse("Entity type not found", 404));
  invalidateCache();
  res.status(200).json({ success: true, data: {} });
});
