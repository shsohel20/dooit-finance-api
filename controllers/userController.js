const asyncHandler = require("../middleware/async");
const User = require("../models/User");
const UserType = require("../models/UserType");
const ErrorResponse = require("../utils/errorResponse");

exports.filterUserSection = (s, requestBody) => {
  return s.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all users (via advancedResults middleware)
// @route  GET  /api/v1/user
// @route  POST /api/v1/user
// @access Admin
exports.getUsers = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get all users'
  #swagger.description = 'Retrieve paginated / filtered users. Uses advancedResults middleware output.'
  #swagger.parameters['page'] = { in: 'query', type: 'integer', description: 'Page number (optional)' }
  #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Items per page (optional)' }
  #swagger.responses[200] = {
    description: 'Users list (from advancedResults middleware)',
    schema: { success: true, count: 10, pagination: {}, data: [ { $ref: '#/definitions/UserResponse' } ] }
  }
*/
  res.status(200).json(res.advancedResults);
});

exports.getUsersPost = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get all users (POST)'
  #swagger.description = 'Retrieve paginated / filtered users via POST body. Uses advancedResults middleware output.'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { } }
  #swagger.responses[200] = {
    description: 'Users list',
    schema: { success: true, count: 10, pagination: {}, data: [ { $ref: '#/definitions/UserResponse' } ] }
  }
*/
  res.status(200).json(res.advancedResults);
});

// @desc   Scope the user list to the caller's tenant before advancedResults runs.
//         User is identity-only (no client/branch), so we resolve the matching
//         user IDs from UserType and inject them as a base filter. dooit/platform
//         admins have no client/branch context and stay unscoped (see all users).
exports.scopeUserListByTenant = asyncHandler(async (req, res, next) => {
  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;
  const branch = req.user?.branch?._id ?? req.user?.branchBelongs ?? null;

  // No tenant context (dooit / platform admin) → unscoped: list every user.
  if (!client && !branch) return next();

  const membershipFilter = { isActive: true };
  if (client) membershipFilter.clientBelongs = client;
  if (branch) membershipFilter.branchBelongs = branch;

  const userIds = await UserType.distinct("user", membershipFilter);
  req.advancedFilter = { _id: { $in: userIds } };
  next();
});

// @desc   Create a new user + seed its first UserType membership
// @route  POST /api/v1/user/new
// @access Admin
exports.createUser = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Create a new user'
  #swagger.description = 'Create a user record and its initial UserType membership'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UserCreateBody' } }
  #swagger.responses[201] = { description: 'User created', schema: { succeed: true, data: { $ref: '#/definitions/UserResponse' }, id: '...' } }
  #swagger.responses[400] = { description: 'Validation error' }
*/
  const client = req.user?.client?._id ?? null;
  const branch = req.user?.branch?._id ?? null;

  // Active hat from req.user (overlaid from the token by protect middleware).
  const userType     = req.user?.userType ?? "user";
  const role         = req.body.role ?? "user";
  const clientBelongs = client;
  const branchBelongs = branch;

  const user = await User.create({ ...req.body });

  // Seed UserType membership (idempotent — unique index handles duplicates).
  const membership = await UserType.findOneAndUpdate(
    { user: user._id, userType, role, clientBelongs, branchBelongs },
    { $setOnInsert: { isActive: true, assignedBy: req.user?.id ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.status(201).json({
    succeed: true,
    data: user,
    id: user._id,
    membership,
  });
});

// @desc   Get users by role — queries UserType then loads User docs
// @route  GET /api/v1/user/role/:role
// @access Admin
exports.getUsersByRole = asyncHandler(async (req, res) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get users by role'
  #swagger.description = 'List users whose UserType membership matches the given role within the requester tenant'
  #swagger.parameters['role'] = { in: 'path', required: true, type: 'string', description: 'Role name' }
  #swagger.responses[200] = { description: 'Users', schema: { success: true, count: 0, data: [] } }
*/
  const roleFilter = { $regex: new RegExp(`^${req.params.role}$`, "i") };
  const tenantFilter = {
    clientBelongs: req.user?.client?._id ?? null,
    branchBelongs: req.user?.branch?._id ?? null,
  };

  // Resolve matching user IDs from UserType (Phase 4 migration of §5.10.B).
  const matchingUserIds = await UserType.distinct("user", {
    role: roleFilter,
    ...tenantFilter,
    isActive: true,
  });

  const users = await User.find({ _id: { $in: matchingUserIds } }).select("-password");

  res.status(200).json({ success: true, count: users.length, data: users });
});

// @desc   Get single user by ID
// @route  GET /api/v1/user/:id
// @access Admin
exports.getUser = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get user by ID'
  #swagger.description = 'Fetch a single user by MongoDB _id'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'User ID' }
  #swagger.responses[200] = { description: 'User found', schema: { $ref: '#/definitions/UserResponse' } }
  #swagger.responses[404] = { description: 'User not found' }
*/
  const user = await User.findById(req.params.id);
  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: user });
});

// @desc   Get single user by slug
// @route  GET /api/v1/user/slug/:slug
// @access Admin
exports.getUserBySlug = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get user by slug'
  #swagger.description = 'Fetch a single user by slug'
  #swagger.parameters['slug'] = { in: 'path', required: true, type: 'string', description: 'User slug' }
  #swagger.security = [{ "BearerAuth": [] }]
  #swagger.responses[200] = { description: 'User found', schema: { $ref: '#/definitions/UserResponse' } }
  #swagger.responses[404] = { description: 'User not found' }
*/
  const user = await User.findOne({ slug: req.params.slug });
  if (!user) {
    return next(new ErrorResponse(`User not found with slug ${req.params.slug}`, 404));
  }
  res.status(200).json({ success: true, data: user });
});

// @desc   Update a user
// @route  PUT /api/v1/user/:id
// @access Admin
exports.updateUser = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Update user'
  #swagger.description = 'Update a user by ID'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'User ID' }
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UserUpdateBody' } }
  #swagger.responses[200] = { description: 'Updated user', schema: { $ref: '#/definitions/UserResponse' } }
  #swagger.responses[404] = { description: 'User not found' }
*/
  const updates = {};
  const allowedFields = ["name", "email", "phone", "photoUrl", "isActive"];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  const user = await User.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });

  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: user });
});

// @desc   Delete a user
// @route  DELETE /api/v1/user/:id
// @access Admin
exports.deleteUser = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Delete user'
  #swagger.description = 'Delete a user by ID'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'User ID' }
  #swagger.responses[200] = { description: 'User deleted', schema: { success: true, data: '...' } }
  #swagger.responses[404] = { description: 'User not found' }
*/
  const user = await User.findById(req.params.id);
  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }
  await user.deleteOne();
  res.status(200).json({ success: true, data: req.params.id });
});

// @desc   Admin reset another user's password
// @route  PUT /api/v1/user/update-user-password/:id
// @access Admin
exports.updateUserPassword = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Update user password (admin)'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'User ID' }
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UpdatePasswordBody' } }
  #swagger.responses[200] = { description: 'Password updated', schema: { success: true, data: '...' } }
  #swagger.responses[404] = { description: 'User not found' }
*/
  const user = await User.findById(req.params.id).select("+password");
  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }
  user.password = req.body.password;
  await user.save();
  res.status(200).json({ success: true, data: req.params.id });
});

// @desc   User resets own password (within authenticated session)
// @route  PUT /api/v1/user/reset-password/:id
// @access Admin
exports.resetPassword = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id).select("+password");
  if (!(await user.mathPassword(req.body.currentPassword))) {
    return next(new ErrorResponse("Invalid current password", 401));
  }
  user.password = req.body.newPassword;
  await user.save();
  res.status(200).json({ success: true, message: "Password updated successfully" });
});

// ─── Membership Management ────────────────────────────────────────────────────
// These endpoints let admins list, add, edit, and remove a user's UserType rows.
// A user's last active membership is protected from deletion.

// @desc   List all memberships for a user
// @route  GET /api/v1/user/:id/memberships
// @access Admin
exports.getMemberships = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'List user memberships'
  #swagger.description = 'Return all UserType rows for the given user'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string' }
  #swagger.responses[200] = { description: 'Memberships list', schema: { success: true, count: 0, data: [] } }
*/
  const memberships = await UserType.find({ user: req.params.id })
    .populate("roleId", "name description")
    .lean();
  res.status(200).json({ success: true, count: memberships.length, data: memberships });
});

// @desc   Add a membership to a user
// @route  POST /api/v1/user/:id/memberships
// @access Admin
exports.addMembership = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Add user membership'
  #swagger.description = 'Create a new UserType row for the user. Duplicate-key → 409.'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string' }
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { userType: 'client', role: 'admin' } }
  #swagger.responses[201] = { description: 'Membership created', schema: { success: true, data: {} } }
  #swagger.responses[409] = { description: 'Membership already exists' }
*/
  const { userType, role, roleId, clientBelongs, branchBelongs } = req.body;

  try {
    const membership = await UserType.create({
      user: req.params.id,
      userType,
      role,
      roleId: roleId ?? null,
      clientBelongs: clientBelongs ?? null,
      branchBelongs: branchBelongs ?? null,
      isActive: true,
      assignedBy: req.user.id,
    });
    res.status(201).json({ success: true, data: membership });
  } catch (err) {
    if (err.code === 11000) {
      return next(new ErrorResponse("This membership already exists for the user", 409));
    }
    throw err;
  }
});

// @desc   Edit a membership
// @route  PUT /api/v1/user/:id/memberships/:userTypeId
// @access Admin
exports.updateMembership = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Update user membership'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string' }
  #swagger.parameters['userTypeId'] = { in: 'path', required: true, type: 'string' }
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { role: 'analyst', isActive: true } }
  #swagger.responses[200] = { description: 'Updated membership', schema: { success: true, data: {} } }
  #swagger.responses[404] = { description: 'Membership not found' }
*/
  const allowed = ["userType", "role", "roleId", "clientBelongs", "branchBelongs", "isActive"];
  const updates = {};
  allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  const membership = await UserType.findOneAndUpdate(
    { _id: req.params.userTypeId, user: req.params.id },
    updates,
    { new: true, runValidators: true }
  );

  if (!membership) {
    return next(new ErrorResponse("Membership not found", 404));
  }
  res.status(200).json({ success: true, data: membership });
});

// @desc   Remove (deactivate) a membership
// @route  DELETE /api/v1/user/:id/memberships/:userTypeId
// @access Admin
exports.deleteMembership = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Remove user membership'
  #swagger.description = 'Deactivates the membership. Blocked if it is the user\'s only active one.'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string' }
  #swagger.parameters['userTypeId'] = { in: 'path', required: true, type: 'string' }
  #swagger.responses[200] = { description: 'Membership deactivated' }
  #swagger.responses[400] = { description: 'Cannot remove last active membership' }
  #swagger.responses[404] = { description: 'Membership not found' }
*/
  const membership = await UserType.findOne({
    _id: req.params.userTypeId,
    user: req.params.id,
  });

  if (!membership) {
    return next(new ErrorResponse("Membership not found", 404));
  }

  // Guard: cannot remove the user's last active membership.
  if (membership.isActive) {
    const activeCount = await UserType.countDocuments({
      user: req.params.id,
      isActive: true,
    });
    if (activeCount <= 1) {
      return next(
        new ErrorResponse(
          "Cannot remove the user's last active membership — they would be unable to log in",
          400
        )
      );
    }
  }

  // Soft-deactivate rather than hard-delete for audit trail.
  membership.isActive = false;
  await membership.save();

  res.status(200).json({ success: true, data: req.params.userTypeId });
});
