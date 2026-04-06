const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const PrivacyPermission = require("../models/PrivacyPermission");

// @desc   Create a privacy permission
// @route  POST /api/v1/privacy/permissions
// @access Admin
exports.createPermission = asyncHandler(async (req, res, next) => {
  const { name, roleNames, restrictedUserIds, expiresAt } = req.body;

  if (!name) {
    return next(new ErrorResponse("name is required", 400));
  }
  if (!roleNames?.length) {
    return next(new ErrorResponse("roleNames must be a non-empty array", 400));
  }

  const permission = await PrivacyPermission.create({
    name,
    roleNames,
    restrictedUserIds: restrictedUserIds ?? [],
    expiresAt: expiresAt ?? null,
    grantedBy: req.user.id,
    client: req.user.client?._id ?? null,
    branch: req.user.branch?._id ?? null,
  });

  res.status(201).json({ success: true, data: permission });
});

// @desc   Get all privacy permissions
// @route  GET /api/v1/privacy/permissions
// @access Admin
exports.getPermissions = asyncHandler(async (req, res) => {
  const filter = {};

  if (req.query.isActive !== undefined) {
    filter.isActive = req.query.isActive === "true";
  }
  if (req.query.roleName) {
    filter.roleNames = req.query.roleName;
  }

  const permissions = await PrivacyPermission.find(filter)
    .populate("grantedBy", "name email uid")
    .populate("restrictedUserIds", "name email uid")
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, count: permissions.length, data: permissions });
});

// @desc   Get a single privacy permission
// @route  GET /api/v1/privacy/permissions/:id
// @access Admin
exports.getPermission = asyncHandler(async (req, res, next) => {
  const permission = await PrivacyPermission.findById(req.params.id)
    .populate("grantedBy", "name email uid")
    .populate("restrictedUserIds", "name email uid");

  if (!permission) {
    return next(new ErrorResponse("Permission not found", 404));
  }

  res.status(200).json({ success: true, data: permission });
});

// @desc   Update a privacy permission
// @route  PUT /api/v1/privacy/permissions/:id
// @access Admin
exports.updatePermission = asyncHandler(async (req, res, next) => {
  const allowed = ["name", "roleNames", "restrictedUserIds", "isActive", "expiresAt", "client", "branch"];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse("No valid fields provided to update", 400));
  }

  const permission = await PrivacyPermission.findByIdAndUpdate(
    req.params.id,
    updates,
    { new: true, runValidators: true }
  )
    .populate("grantedBy", "name email uid")
    .populate("restrictedUserIds", "name email uid");

  if (!permission) {
    return next(new ErrorResponse("Permission not found", 404));
  }

  res.status(200).json({ success: true, data: permission });
});

// @desc   Delete a privacy permission
// @route  DELETE /api/v1/privacy/permissions/:id
// @access Admin
exports.deletePermission = asyncHandler(async (req, res, next) => {
  const permission = await PrivacyPermission.findByIdAndDelete(req.params.id);

  if (!permission) {
    return next(new ErrorResponse("Permission not found", 404));
  }

  res.status(200).json({ success: true, data: {} });
});
