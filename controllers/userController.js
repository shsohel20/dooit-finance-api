const asyncHandler = require("../middleware/async");
const User = require("../models/User");
const UserType = require("../models/UserType");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const Customer = require("../models/Customer");
const Staff = require("../models/Staff");
const Case = require("../models/Case");
const Alert = require("../models/Alert");
const Role = require("../models/Role");
const ErrorResponse = require("../utils/errorResponse");
const { initialPassword, convertQueryString } = require("../utils");
const sendEmail = require("../utils/sendEmail");
const { getRawEmail } = require("../utils/rawUserFields");
const { runInBackground } = require("../utils/backgroundJob");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");
const { userWelcomeHtml } = require("../utils/email-template/userEmailTemplate");

// Derives a unique userName from an email's local part (e.g. "jane.doe@x.com" -> "jane.doe"),
// falling back to numeric suffixes on collision. Lets the UI skip asking for a username.
async function uniqueUserName(base) {
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 30) || "user";

  if (!(await User.exists({ userName: sanitized }))) return sanitized;

  for (let i = 2; i <= 10; i++) {
    const candidate = `${sanitized}_${i}`;
    if (!(await User.exists({ userName: candidate }))) return candidate;
  }

  const suffix = Math.random().toString(16).slice(2, 6);
  return `${sanitized}_${suffix}`;
}

/** True when a membership sits in the caller's tenant (a null caller scope matches all). */
const membershipMatchesTenant = (m, client, branch) =>
  (!client || String(m.clientBelongs ?? "") === String(client)) &&
  (!branch || String(m.branchBelongs ?? "") === String(branch));

// User is identity-only — role/userType live on UserType, not User — so list/detail
// responses need this to surface a `role` at all.
//
// Every active membership is fetched and the best one chosen in memory: the
// caller's own tenant wins, otherwise the most recent. Filtering by tenant in the
// query instead would return NO role for users whose membership predates tenant
// scoping (clientBelongs: null) — the role column and the edit form's role select
// would both render blank.
async function attachRoleToUsers(users, req) {
  const list = Array.isArray(users) ? users : [users];
  const ids = list.filter(Boolean).map((u) => u._id).filter(Boolean);
  if (!ids.length) return users;

  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;
  const branch = req.user?.branch?._id ?? req.user?.branchBelongs ?? null;

  const memberships = await UserType.find({ user: { $in: ids }, isActive: true })
    .sort({ createdAt: -1 })
    .select("user role userType clientBelongs branchBelongs")
    .lean();

  const roleByUser = new Map();
  memberships.forEach((m) => {
    const key = String(m.user);
    const current = roleByUser.get(key);
    // Sorted newest-first, so the first seen is the most recent fallback.
    // Replace it only when a later row actually matches the caller's tenant.
    if (!current) {
      roleByUser.set(key, m);
    } else if (
      !membershipMatchesTenant(current, client, branch) &&
      membershipMatchesTenant(m, client, branch)
    ) {
      roleByUser.set(key, m);
    }
  });

  const enriched = list.map((u) => {
    if (!u) return u;
    const obj = typeof u.toObject === "function" ? u.toObject({ virtuals: true }) : u;
    const membership = roleByUser.get(String(obj._id));
    obj.role = membership?.role ?? null;
    obj.userType = membership?.userType ?? null;
    return obj;
  });

  return Array.isArray(users) ? enriched : enriched[0];
}

// Records that make a user undeletable. Two kinds are checked:
//   • identity ownership — the user IS the login behind a business entity, so
//     deleting them strands a customer / client / branch / staff record.
//   • live workload — the user still owns open work that would be left unowned.
//
// Audit and authorship references (createdBy, updatedBy, changedBy, actor,
// assignedBy, reviewedBy, …) are deliberately NOT checked. Nearly every action
// in the system leaves one behind, so blocking on those would make any active
// user permanently undeletable. Those refs stay pointing at the deleted id,
// which is the normal trade-off for an audit trail.
//
// To block on another relationship, add a row here — nothing else changes.
const DELETE_BLOCKERS = [
  { model: Staff,    filter: (id) => ({ user: id }), one: "staff record", many: "staff records" },
  { model: Client,   filter: (id) => ({ user: id }), one: "client",       many: "clients" },
  { model: Branch,   filter: (id) => ({ user: id }), one: "branch",       many: "branches" },
  { model: Customer, filter: (id) => ({ user: id }), one: "customer",     many: "customers" },
  {
    model: Case,
    filter: (id) => ({
      $or: [{ assignedTo: id }, { reviewer: id }],
      status: { $ne: "closed" },
      isDeleted: { $ne: true },
    }),
    one: "open case",
    many: "open cases",
  },
  {
    model: Alert,
    filter: (id) => ({
      analyst: id,
      status: { $nin: ["dismissed", "false_positive", "escalated_to_case"] },
      isDeleted: { $ne: true },
    }),
    one: "open alert",
    many: "open alerts",
  },
];

/**
 * Count every blocking relationship for a user, in parallel.
 * Returns a "2 customers, 1 open case"-style summary, or "" when safe to delete.
 */
async function describeDeleteBlockers(userId) {
  const counts = await Promise.all(
    DELETE_BLOCKERS.map((b) => b.model.countDocuments(b.filter(userId)))
  );

  return DELETE_BLOCKERS.map((b, i) => ({ ...b, count: counts[i] }))
    .filter((b) => b.count > 0)
    .map((b) => `${b.count} ${b.count === 1 ? b.one : b.many}`)
    .join(", ");
}

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
  const data = await attachRoleToUsers(res.advancedResults.data, req);
  res.status(200).json({ ...res.advancedResults, data });
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
  const data = await attachRoleToUsers(res.advancedResults.data, req);
  res.status(200).json({ ...res.advancedResults, data });
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
  // Match scopeUserListByTenant / attachRoleToUsers, which both fall back to the
  // token's clientBelongs/branchBelongs. Without this a client admin whose token
  // carries only clientBelongs would create untenanted users invisible to their
  // own list.
  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;
  const branch = req.user?.branch?._id ?? req.user?.branchBelongs ?? null;

  // Active hat from req.user (overlaid from the token by protect middleware).
  const userType     = req.user?.userType ?? "user";
  const role         = req.body.role ?? "user";
  const clientBelongs = client;
  const branchBelongs = branch;

  const userName =
    req.body.userName || (await uniqueUserName(String(req.body.email).split("@")[0]));
  const password = req.body.password || initialPassword;

  const user = await User.create({ ...req.body, userName, password });

  // Seed UserType membership (idempotent — unique index handles duplicates).
  const membership = await UserType.findOneAndUpdate(
    { user: user._id, userType, role, clientBelongs, branchBelongs },
    { $setOnInsert: { isActive: true, assignedBy: req.user?.id ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  logEvent({
    req,
    service: "auth",
    action: "user_created",
    user: user._id,
    target: String(user._id),
    details: `Created user "${user.name}" with role "${role}"`,
    afterValue: { userType, role, clientBelongs },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(201).json({
    succeed: true,
    data: user,
    id: user._id,
    membership,
  });

  // ── Welcome + credentials email ────────────────────────────────────────────
  // Sent after the response is returned; any failure is logged, never surfaced
  // to the user-creation request (mirrors clientController.createClient).
  runInBackground(`userWelcomeEmail:${user._id}`, async () => {
    const base = String(req.body.clientUrl || process.env.FRONTEND_URL || "")
      .replace(/\/+$/, "");
    const loginUrl = `${base}/auth/login`;
    const forgotPasswordUrl = `${base}/auth/forgot-password`;

    // 24h set-password token. User.updateOne (not user.save) so the password
    // pre-save hook doesn't re-hash the already-hashed password.
    let setPasswordUrl = "";
    try {
      const resetToken = user.getResetPasswordToken();
      await User.updateOne(
        { _id: user._id },
        {
          resetPasswordToken: user.resetPasswordToken,
          resetPasswordExpire: Date.now() + 24 * 60 * 60 * 1000,
        }
      );
      setPasswordUrl = `${base}/auth/reset-password?${convertQueryString({ resetToken })}`;
    } catch (err) {
      console.error("[createUser] reset-token generation failed:", err.message);
    }

    // Co-branding + role copy. Both are best-effort — a missing client or role
    // record just falls back to plain Dooit branding / a generic role profile.
    let clientName = "";
    let clientLogoUrl = "";
    if (clientBelongs) {
      try {
        const clientDoc = await Client.findById(clientBelongs)
          .select("name settings metadata")
          .lean();
        clientName = clientDoc?.name || "";
        // No dedicated logo field on Client — read the conventional Mixed keys.
        clientLogoUrl =
          clientDoc?.settings?.logoUrl || clientDoc?.metadata?.logoUrl || "";
      } catch (err) {
        console.error("[createUser] client lookup failed:", err.message);
      }
    }

    let roleDescription = "";
    try {
      const roleDoc = await Role.findOne({ name: new RegExp(`^${role}$`, "i") })
        .select("description")
        .lean();
      roleDescription = roleDoc?.description || "";
    } catch (err) {
      console.error("[createUser] role lookup failed:", err.message);
    }

    try {
      const rawEmail = await getRawEmail(user._id);
      await sendEmail({
        email: rawEmail,
        subject: clientName
          ? `Your ${clientName} account on Dooit`
          : "Your Dooit Account Details",
        message: userWelcomeHtml({
          name: req.body.name,
          email: rawEmail,
          tempPassword: password,
          userType,
          role,
          roleDescription,
          clientName,
          clientLogoUrl,
          setPasswordUrl,
          forgotPasswordUrl,
          loginUrl,
        }),
      });
    } catch (err) {
      console.error("[createUser] welcome email failed:", err.message);
    }
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
  const data = await attachRoleToUsers(user, req);
  res.status(200).json({ success: true, data });
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
  #swagger.responses[403] = { description: 'Cannot deactivate your own account' }
  #swagger.responses[404] = { description: 'User not found' }
*/
  const updates = {};
  const allowedFields = ["name", "email", "phone", "photoUrl", "isActive"];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  // Same foot-gun as self-delete: deactivating your own account locks you out on
  // the next request. Re-activating yourself is harmless, so only false is blocked.
  const callerId = req.user?.id ?? req.user?._id ?? null;
  if (
    updates.isActive === false &&
    callerId &&
    String(callerId) === String(req.params.id)
  ) {
    return next(
      new ErrorResponse(
        "You cannot deactivate your own account. Ask another administrator to do it.",
        403
      )
    );
  }

  // Snapshot the pre-update values of the fields being changed, for the audit trail.
  const beforeUser = Object.keys(updates).length
    ? await User.findById(req.params.id)
    : null;

  const user = await User.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });

  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }

  const changedBefore = {};
  const changedAfter = {};
  Object.keys(updates).forEach((field) => {
    changedBefore[field] = beforeUser ? beforeUser[field] : undefined;
    changedAfter[field] = user[field];
  });
  logEvent({
    req,
    service: "auth",
    action: "user_updated",
    user: user._id,
    target: String(user._id),
    details: Object.keys(updates).length
      ? `Updated user fields: ${Object.keys(updates).join(", ")}`
      : "User update requested (no profile fields changed)",
    beforeValue: changedBefore,
    afterValue: changedAfter,
  });

  // Role lives on UserType, not User — sync the membership row.
  if (req.body.role) {
    const newRole = String(req.body.role).trim();
    const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;
    const branch = req.user?.branch?._id ?? req.user?.branchBelongs ?? null;

    // roleId has to move with the name. UserType's pre-save hook can't do it: it
    // only runs on .save() and only fills roleId when it is *empty*, so any
    // rename would leave roleId pointing at the previous role — and UserType
    // treats roleId as the eventual source of truth.
    const escaped = newRole.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const roleDoc = await Role.findOne({ name: new RegExp(`^${escaped}$`, "i") })
      .select("_id")
      .lean();

    // Prefer the membership in the caller's tenant, but fall back to any active
    // one. A tenant-only filter finds nothing for users whose membership predates
    // tenant scoping (clientBelongs: null), which made the role change a silent
    // no-op that still returned success.
    const scoped = { user: user._id, isActive: true };
    if (client) scoped.clientBelongs = client;
    if (branch) scoped.branchBelongs = branch;

    const membership =
      (await UserType.findOne(scoped).sort({ createdAt: -1 })) ||
      (await UserType.findOne({ user: user._id, isActive: true }).sort({
        createdAt: -1,
      }));

    // Changing your own role is privilege escalation — an admin could demote
    // themselves out of a mistake, or a lesser role could promote itself.
    // Compared against the *current* role rather than rejecting outright,
    // because the edit form always submits `role`, so editing your own name
    // would otherwise 403 even though the role never moved.
    const isSelf = callerId && String(callerId) === String(req.params.id);
    const roleChanged =
      String(membership?.role ?? "").toLowerCase() !== newRole.toLowerCase();
    if (isSelf && roleChanged) {
      return next(
        new ErrorResponse(
          "You cannot change your own role. Ask another administrator to do it.",
          403
        )
      );
    }

    const prevRole = membership?.role ?? null;
    const prevRoleId = membership?.roleId ?? null;

    try {
      if (membership) {
        membership.role = newRole;
        membership.roleId = roleDoc?._id ?? null;
        await membership.save();
      } else {
        // No active membership at all — create/reactivate one so the role
        // actually takes effect instead of reporting success against nothing.
        await UserType.findOneAndUpdate(
          {
            user: user._id,
            userType: req.user?.userType ?? "user",
            role: newRole,
            clientBelongs: client,
            branchBelongs: branch,
          },
          {
            $set: { roleId: roleDoc?._id ?? null, isActive: true },
            $setOnInsert: { assignedBy: req.user?.id ?? null },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }
    } catch (err) {
      // The user already holds this exact (userType, role, tenant) membership.
      if (err.code === 11000) {
        return next(
          new ErrorResponse(`This user already has the "${newRole}" role`, 409)
        );
      }
      throw err;
    }

    logEvent({
      req,
      service: "auth",
      action: "user_role_changed",
      user: user._id,
      target: String(user._id),
      details: `Role changed from "${prevRole ?? "none"}" to "${newRole}"`,
      beforeValue: { role: prevRole, roleId: prevRoleId },
      afterValue: { role: newRole, roleId: roleDoc?._id ?? null },
    });
  }

  const data = await attachRoleToUsers(user, req);
  res.status(200).json({ success: true, data });
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
  #swagger.responses[200] = { description: 'User deleted', schema: { success: true, data: '...', membershipsRemoved: 0 } }
  #swagger.responses[403] = { description: 'Cannot delete your own account' }
  #swagger.responses[404] = { description: 'User not found' }
  #swagger.responses[409] = { description: 'User is still linked to other records' }
*/
  // Self-delete guard — an admin removing their own account locks themselves out
  // immediately, and if they are the tenant's only admin it locks out the tenant.
  const callerId = req.user?.id ?? req.user?._id ?? null;
  if (callerId && String(callerId) === String(req.params.id)) {
    return next(
      new ErrorResponse(
        "You cannot delete your own account. Ask another administrator to remove it for you.",
        403
      )
    );
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }

  // Referential guard — refuse to strand records that point at this user.
  const blockedBy = await describeDeleteBlockers(user._id);
  if (blockedBy) {
    return next(
      new ErrorResponse(
        `This user cannot be deleted — they are still linked to ${blockedBy}. ` +
          `Reassign or remove those records first, or deactivate the user instead.`,
        409
      )
    );
  }

  // Cascade the user's UserType memberships. Unlike deleteMembership — which
  // soft-deactivates a single row so the audit trail survives — these rows point
  // at a user that is about to stop existing, so keeping them serves no audit
  // purpose and actively breaks things: scopeUserListByTenant would resolve IDs
  // with no matching User, and the unique (user, userType, role, client, branch)
  // index would stay occupied.
  //
  // Children before parent: if this throws, the user is left intact and the
  // delete can simply be retried.
  // Snapshot before the delete — the doc stops existing after this point.
  const beforeValue = {
    name: user.name ?? null,
    email: user.email ?? null,
    memberships: await UserType.countDocuments({ user: user._id }),
  };

  const { deletedCount } = await UserType.deleteMany({ user: user._id });

  await user.deleteOne();

  logEvent({
    req,
    service: "auth",
    action: "user_deleted",
    user: user._id,
    target: String(user._id),
    details: `Deleted user "${beforeValue.name}" (${deletedCount} membership(s) removed)`,
    beforeValue,
  });

  res.status(200).json({
    success: true,
    data: req.params.id,
    membershipsRemoved: deletedCount,
  });
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

  logEvent({
    req,
    service: "auth",
    action: "password_reset_by_admin",
    user: user._id,
    target: String(user._id),
    details: "Password reset by administrator",
  });
  recordDevice({ req, purpose: "password_reset" });

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

  logEvent({
    req,
    service: "auth",
    action: "password_changed",
    details: "User changed their own password",
  });
  recordDevice({ req, purpose: "password_reset" });

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

    logEvent({
      req,
      service: "auth",
      action: "membership_granted",
      user: req.params.id,
      target: String(membership._id),
      details: `Membership granted: ${userType}/${role}`,
      afterValue: {
        userType,
        role,
        clientBelongs: clientBelongs ?? null,
        branchBelongs: branchBelongs ?? null,
      },
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

  // Snapshot the pre-update row so the audit event can carry a before/after diff.
  const beforeMembership = await UserType.findOne({
    _id: req.params.userTypeId,
    user: req.params.id,
  }).lean();

  const membership = await UserType.findOneAndUpdate(
    { _id: req.params.userTypeId, user: req.params.id },
    updates,
    { new: true, runValidators: true }
  );

  if (!membership) {
    return next(new ErrorResponse("Membership not found", 404));
  }

  const beforeValue = {};
  const afterValue = {};
  Object.keys(updates).forEach((f) => {
    beforeValue[f] = beforeMembership ? beforeMembership[f] : undefined;
    afterValue[f] = membership[f];
  });
  logEvent({
    req,
    service: "auth",
    action: "membership_updated",
    user: req.params.id,
    target: String(membership._id),
    details: `Membership updated: ${Object.keys(updates).join(", ") || "no fields"}`,
    beforeValue,
    afterValue,
  });

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

  // Snapshot the row being revoked before it is deactivated.
  const beforeValue = {
    userType: membership.userType,
    role: membership.role,
    clientBelongs: membership.clientBelongs ?? null,
    branchBelongs: membership.branchBelongs ?? null,
    isActive: membership.isActive,
  };

  // Soft-deactivate rather than hard-delete for audit trail.
  membership.isActive = false;
  await membership.save();

  logEvent({
    req,
    service: "auth",
    action: "membership_revoked",
    user: req.params.id,
    target: String(membership._id),
    details: `Membership revoked: ${beforeValue.userType}/${beforeValue.role}`,
    beforeValue,
  });

  res.status(200).json({ success: true, data: req.params.userTypeId });
});
