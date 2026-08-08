const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const RolePermission = require("../models/RolePermission");
const Role = require("../models/Role");
const permissionList = require("../_data/permissionjson.json");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");

const populate = (q) =>
  q
    .populate("role", "name description")
    .populate("grantedBy", "name email uid")
    .populate("restrictedUsers.user", "name email uid");



// @desc   Get all available permission definitions
// @route  GET /api/v1/role-permissions/permissions
// @access Admin
exports.getAllPermission = asyncHandler(async (_req, res) => {
  res.status(200).json({
    success: true,
    count: permissionList.length,
    data: permissionList
  });
});

// @desc   Create a role permission
// @route  POST /api/v1/role-permissions
// @access Admin
exports.createRolePermission = asyncHandler(async (req, res, next) => {
  const { role, permissions, restrictedUsers, expiresAt } = req.body;

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
    restrictedUsers: restrictedUsers ?? [],
    expiresAt: expiresAt ?? null,
    grantedBy: req.user.id,
    client: clientId,
    branch: branchId,
  });

  logEvent({
    req,
    service: "auth",
    action: "role_permission_created",
    target: String(role),
    details: `Role permission created for role "${roleDoc.name}" (${rolePermission.permissions.length} permission(s))`,
    afterValue: {
      permissions: rolePermission.toObject().permissions,
      restrictedUsers: rolePermission.toObject().restrictedUsers,
    },
  });
  recordDevice({ req, purpose: "admin_action" });

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
    "restrictedUsers",
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

  // Snapshot the pre-update doc so the audit event carries a before/after diff
  // (including client/branch re-tenanting).
  const beforeDoc = await RolePermission.findOne({ role: req.params.roleId }).lean();

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

  const beforeValue = {};
  const afterValue = {};
  Object.keys(updates).forEach((k) => {
    beforeValue[k] = beforeDoc ? beforeDoc[k] : undefined;
    afterValue[k] = updates[k];
  });
  logEvent({
    req,
    service: "auth",
    action: "role_permission_updated",
    target: String(req.params.roleId),
    details: `Role permission updated: ${Object.keys(updates).join(", ")}`,
    beforeValue,
    afterValue,
  });
  recordDevice({ req, purpose: "admin_action" });

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

  // findOneAndDelete returns the deleted doc — that is the before snapshot.
  const snapshot = rolePermission.toObject();
  logEvent({
    req,
    service: "auth",
    action: "role_permission_deleted",
    target: String(req.params.roleId),
    details: "Role permission document deleted",
    beforeValue: {
      permissions: snapshot.permissions,
      restrictedUsers: snapshot.restrictedUsers,
      isActive: snapshot.isActive,
      client: snapshot.client,
      branch: snapshot.branch,
    },
  });
  recordDevice({ req, purpose: "admin_action" });

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

  logEvent({
    req,
    service: "auth",
    action: "permissions_granted",
    target: String(req.params.roleId),
    details: `Granted permission(s): ${permissions.join(", ")}`,
    afterValue: { added: permissions },
  });
  recordDevice({ req, purpose: "admin_action" });

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

  logEvent({
    req,
    service: "auth",
    action: "permissions_revoked",
    target: String(req.params.roleId),
    details: `Revoked permission(s): ${permissions.join(", ")}`,
    afterValue: { removed: permissions },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Add or update restricted users on a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/restrict
// @access Admin
//
// Body: { user: ObjectId, modules: [String], options: [String] }
//   modules: [], options: []          → blocked from ALL permissions in this role
//   modules: ["USER","RFI"]           → blocked from all USER.* and RFI.* permissions
//   options: ["USER.ADD","PRIVACY.ENCRYPTVIEW"] → blocked from specific permission strings only
//
// If the user already exists in restrictedUsers their entry is replaced.
exports.addRestrictedUsers = asyncHandler(async (req, res, next) => {
  const { user, modules, options } = req.body;

  if (!user) {
    return next(new ErrorResponse("user (ObjectId) is required", 400));
  }
  if (!Array.isArray(modules)) {
    return next(new ErrorResponse("modules must be an array (can be empty to block all)", 400));
  }
  if (!Array.isArray(options)) {
    return next(new ErrorResponse("options must be an array of specific permission strings", 400));
  }

  // Remove existing entry for this user then push the new one (upsert behaviour)
  const rolePermission = await populate(
    RolePermission.findOneAndUpdate(
      { role: req.params.roleId },
      {
        $pull: { restrictedUsers: { user } },
      },
      { new: true }
    )
  );

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  // Push the new/updated entry
  rolePermission.restrictedUsers.push({ user, modules, options });
  await rolePermission.save();

  // Re-populate after save
  await rolePermission.populate("restrictedUsers.user", "name email uid");

  logEvent({
    req,
    service: "auth",
    action: "user_restricted",
    user,
    target: String(user),
    details: `User restricted on role permission (modules: ${modules.length ? modules.join(", ") : "all"})`,
    afterValue: { user, modules, options },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: rolePermission });
});

// @desc   Remove a restricted user from a role permission
// @route  PATCH /api/v1/role-permissions/:roleId/unrestrict
// @access Admin
//
// Body: { user: ObjectId }
exports.removeRestrictedUsers = asyncHandler(async (req, res, next) => {
  const { user } = req.body;

  if (!user) {
    return next(new ErrorResponse("user (ObjectId) is required", 400));
  }

  const rolePermission = await populate(
    RolePermission.findOneAndUpdate(
      { role: req.params.roleId },
      { $pull: { restrictedUsers: { user } } },
      { new: true }
    )
  );

  if (!rolePermission) {
    return next(new ErrorResponse("Role permission not found", 404));
  }

  logEvent({
    req,
    service: "auth",
    action: "user_unrestricted",
    user,
    target: String(user),
    details: "User restriction removed from role permission",
    afterValue: { user },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(200).json({ success: true, data: rolePermission });
});
