const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * RolePermission
 *
 * Central permission model that binds a Role to a set of allowed actions,
 * and optionally blocks specific users from that grant.
 *
 * Fields:
 *   - role             → The Role this document controls
 *   - permissions      → Action strings the role is allowed to perform
 *                        e.g. ["USER.ADD", "USER.EDIT", "USER.DELETE", "USER.GET"]
 *   - restrictedUserIds → Specific users blocked even if their role is granted
 *
 * Access check (isGranted):
 *   1. Find an active, non-expired document for the user's role
 *   2. Confirm the user is NOT in restrictedUserIds
 */
const RolePermissionSchema = new Schema(
  {
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      index: true,
      default: null,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      index: true,
      default: null,
    },

    // The role this permission document applies to
    role: {
      type: Schema.Types.ObjectId,
      ref: "Roles",
      index: true,
      default: null,
    },

    // Action strings this role is permitted to perform
    // e.g. ["USER.ADD", "USER.EDIT", "PRIVACY.ENCRYPT", "PRIVACY.DECRYPT", "PRIVACY.ENCRYPTVIEW"]
    //
    // PRIVACY.ENCRYPTVIEW — role can see encrypted fields as plaintext on every read.
    //                       Still blocked for users in restrictedUserIds.
    permissions: {
      type: [String],
      default: [],
    },

    // Specific users explicitly blocked from this permission,
    // even if their role is granted above.
    restrictedUserIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Users" }],
      default: [],
    },

    // Admin who created this permission
    grantedBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: [true, "grantedBy is required"],
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // null means the permission never expires
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
  }
);

// One permission document per role per client+branch scope.
// null client/branch values are treated as equal by MongoDB, so this correctly
// prevents duplicate global (client=null, branch=null) entries for the same role.
RolePermissionSchema.index({ role: 1, client: 1, branch: 1 }, { unique: true });
RolePermissionSchema.index({ restrictedUserIds: 1 });
RolePermissionSchema.index({ isActive: 1 });
RolePermissionSchema.index({ client: 1, branch: 1, isActive: 1 });

/**
 * Check whether a given user can read encrypted fields as plaintext.
 *
 * Returns true  → role has PRIVACY.ENCRYPTVIEW in permissions
 *                 AND user is NOT in restrictedUserIds
 * Returns false → no active permission, missing PRIVACY.ENCRYPTVIEW,
 *                 or user is explicitly restricted
 *
 * Usage (in protect middleware):
 *   const roleDoc = await Role.findOne({ name: u.role }).select('_id').lean();
 *   const canRead = await RolePermission.isGranted(userId, roleDoc?._id, { clientId, branchId });
 *
 * @param {ObjectId|string} userId   - The user attempting access
 * @param {ObjectId|string} roleId   - The user's role ObjectId
 * @param {object}          options
 * @param {ObjectId|string} [options.clientId]
 * @param {ObjectId|string} [options.branchId]
 */
RolePermissionSchema.statics.isGranted = async function (userId, roleId, { clientId, branchId } = {}) {
  if (!roleId) return false;

  const now = new Date();

  const query = {
    isActive: true,
    role: roleId,
    permissions: "PRIVACY.ENCRYPTVIEW",          // role must have this permission
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };

  if (clientId) query.client = clientId;
  if (branchId) query.branch = branchId;

  const permission = await this.findOne(query)
    .select("restrictedUserIds")
    .lean();

  if (!permission) return false;

  // Restricted users are blocked even if their role has PRIVACY.ENCRYPTVIEW
  const isRestricted = permission.restrictedUserIds.some(
    (id) => id.toString() === userId.toString()
  );

  return !isRestricted;
};

/**
 * Get all permission strings for a given role.
 * Useful for checking if a role can perform a specific action.
 *
 * @param {ObjectId|string} roleId
 * @returns {string[]}
 */
RolePermissionSchema.statics.getPermissions = async function (roleId) {
  if (!roleId) return [];

  const now = new Date();
  const doc = await this.findOne({
    isActive: true,
    role: roleId,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .select("permissions")
    .lean();

  return doc?.permissions ?? [];
};

module.exports = mongoose.model("RolePermission", RolePermissionSchema);
