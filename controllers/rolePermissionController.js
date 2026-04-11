const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const RolePermission = require("../models/RolePermission");
const Role = require("../models/Role");

const populate = (q) =>
  q
    .populate("role", "name description")
    .populate("grantedBy", "name email uid")
    .populate("restrictedUserIds", "name email uid");

// @desc   Create a role permission
// @route  POST /api/v1/role-permissions
// @access Admin
exports.createRolePermission = asyncHandler(async (req, res, next) => {
  const { role, permissions, restrictedUserIds, expiresAt } = req.body;

  if (!role) {
    return next(new ErrorResponse("role (Role ObjectId) is required", 400));
  }

  // Verify the role exists
  const roleDoc = await Role.findById(role).lean();
  if (!roleDoc) {
    return next(new ErrorResponse("Role not found", 404));
  }

  // Duplicate check — one RolePermission per role per client+branch scope
  const clientId = req.user.client?._id ?? null;
  const branchId = req.user.branch?._id ?? null;

  const existing = await RolePermission.findOne({
    role,
    client: clientId,
    branch: branchId,
  }).lean();

  if (existing) {
    return next(
      new ErrorResponse(
        `A permission document already exists for this role. Use PUT /role-permissions/${role} to update it.`,
        409
      )
    );
  }

  const rolePermission = await RolePermission.create({
    role,
    permissions: permissions ?? [],
    restrictedUserIds: restrictedUserIds ?? [],
    expiresAt: expiresAt ?? null,
    grantedBy: req.user.id,
    client: clientId,
    branch: branchId,
  });

  res.status(201).json({ success: true, data: rolePermission });
});

// @desc   Get all role permissions
// @route  GET /api/v1/role-permissions
// @access Admin
exports.getRolePermissions = asyncHandler(async (req, res) => {
  const filter = {};

  if (req.query.isActive !== undefined) {
    filter.isActive = req.query.isActive === "true";
  }
  if (req.query.role) {
    filter.role = req.query.role;
  }

  const rolePermissions = await populate(
    RolePermission.find(filter).sort({ createdAt: -1 })
  );

  res.status(200).json({
    success: true,
    count: rolePermissions.length,
    data: rolePermissions,
  });
});

// @desc   Get a single role permission by roleId
// @route  GET /api/v1/role-permissions/:roleId
// @access Admin
exports.getRolePermission = asyncHandler(async (req, res, next) => {
  const rolePermission = await populate(
    RolePermission.findOne({ role: req.params.roleId })
  );

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Update a role permission by roleId
// @route  PUT /api/v1/role-permissions/:roleId
// @access Admin
exports.updateRolePermission = asyncHandler(async (req, res, next) => {
  const allowed = [
    "permissions",
    "restrictedUserIds",
    "isActive",
    "expiresAt",
    "client",
    "branch",
  ];
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse("No valid fields provided to update", 400));
  }

  const rolePermission = await populate(
    RolePermission.findOneAndUpdate(
      { role: req.params.roleId },
      updates,
      { new: true, runValidators: true }
    )
  );

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Delete a role permission by roleId
// @route  DELETE /api/v1/role-permissions/:roleId
// @access Admin
exports.deleteRolePermission = asyncHandler(async (req, res, next) => {
  const rolePermission = await RolePermission.findOneAndDelete({
    role: req.params.roleId,
  });

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  res.status(200).json({ success: true, data: {} });
});

// @desc   Add permission strings to a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/permissions/add
// @access Admin
exports.addPermissions = asyncHandler(async (req, res, next) => {
  const { permissions } = req.body;

  if (!Array.isArray(permissions) || permissions.length === 0) {
    return next(new ErrorResponse("permissions must be a non-empty array of strings", 400));
  }

  const rolePermission = await populate(
    RolePermission.findOneAndUpdate(
      { role: req.params.roleId },
      { $addToSet: { permissions: { $each: permissions } } },
      { new: true }
    )
  );

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Remove permission strings from a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/permissions/remove
// @access Admin
exports.removePermissions = asyncHandler(async (req, res, next) => {
  const { permissions } = req.body;

  if (!Array.isArray(permissions) || permissions.length === 0) {
    return next(new ErrorResponse("permissions must be a non-empty array of strings", 400));
  }

  const rolePermission = await populate(
    RolePermission.findOneAndUpdate(
      { role: req.params.roleId },
      { $pull: { permissions: { $in: permissions } } },
      { new: true }
    )
  );

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Add restricted users to a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/restrict
// @access Admin
exports.addRestrictedUsers = asyncHandler(async (req, res, next) => {
  const { userIds } = req.body;

  if (!Array.isArray(userIds) || userIds.length === 0) {
    return next(new ErrorResponse("userIds must be a non-empty array", 400));
  }

  const rolePermission = await populate(
    RolePermission.findOneAndUpdate(
      { role: req.params.roleId },
      { $addToSet: { restrictedUserIds: { $each: userIds } } },
      { new: true }
    )
  );

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Remove restricted users from a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/unrestrict
// @access Admin
exports.removeRestrictedUsers = asyncHandler(async (req, res, next) => {
  const { userIds } = req.body;

  if (!Array.isArray(userIds) || userIds.length === 0) {
    return next(new ErrorResponse("userIds must be a non-empty array", 400));
  }

  const rolePermission = await populate(
    RolePermission.findOneAndUpdate(
      { role: req.params.roleId },
      { $pull: { restrictedUserIds: { $in: userIds } } },
      { new: true }
    )
  );

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  res.status(200).json({ success: true, data: rolePermission });
});
