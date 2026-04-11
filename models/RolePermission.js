const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * RolePermission
 *
 * Binds a Role to a set of allowed action strings, with per-user,
 * per-module and per-option restrictions.
 *
 * Fields:
 *   - role             → The Role this document controls
 *   - permissions      → Action strings the role is allowed to perform
 *                        e.g. ["USER.ADD", "USER.GET", "PRIVACY.ENCRYPTVIEW"]
 *   - restrictedUsers  → Per-user restrictions (module-level and option-level).
 *                        modules: [] + options: [] means blocked from ALL permissions.
 *                        modules: ["USER"]         blocks all USER.* permissions.
 *                        options: ["USER.ADD"]     blocks only the USER.ADD permission.
 *                        Both can be combined.
 *                        e.g. [{ user: <id>, modules: ["PRIVACY"], options: ["USER.ADD"] }]
 *
 * Access check (isGranted):
 *   1. Role has PRIVACY.ENCRYPTVIEW in permissions
 *   2. User is NOT restricted from "PRIVACY" module OR "PRIVACY.ENCRYPTVIEW" option
 *
 * Permission filtering (getPermissions):
 *   Returns the role's permissions minus any modules/options the user is restricted from.
 */

const RestrictedUserSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: true,
    },
    // Which modules this user is blocked from (blocks all MODULE.* permissions).
    // Empty array (with options also empty) means blocked from ALL modules.
    modules: {
      type: [String],
      default: [],
    },
    // Specific permission strings this user is blocked from.
    // e.g. ["USER.ADD", "PRIVACY.ENCRYPTVIEW"]
    // Applied in addition to (not instead of) module-level blocks.
    options: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

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
    // e.g. ["USER.ADD", "USER.EDIT", "PRIVACY.ENCRYPT", "PRIVACY.ENCRYPTVIEW"]
    //
    // PRIVACY.ENCRYPTVIEW — role can see encrypted fields as plaintext on read.
    //                       Blocked per-user via restrictedUsers[].modules.
    permissions: {
      type: [String],
      default: [],
    },

    // Per-user module restrictions.
    // Blocks a user from specific modules even if their role has those permissions.
    //   modules: []             → blocked from ALL permissions in this role
    //   modules: ["USER","RFI"] → blocked only from USER.* and RFI.* permissions
    restrictedUsers: {
      type: [RestrictedUserSchema],
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
RolePermissionSchema.index({ role: 1, client: 1, branch: 1 }, { unique: true });
RolePermissionSchema.index({ "restrictedUsers.user": 1 });
RolePermissionSchema.index({ isActive: 1 });
RolePermissionSchema.index({ client: 1, branch: 1, isActive: 1 });

/**
 * Check whether a given user can read encrypted fields as plaintext.
 *
 * Returns true  → role has PRIVACY.ENCRYPTVIEW AND user is not restricted from PRIVACY module
 * Returns false → missing PRIVACY.ENCRYPTVIEW, or user is restricted from PRIVACY (or all)
 *
 * @param {ObjectId|string} userId
 * @param {ObjectId|string} roleId
 * @param {object}          [options]
 * @param {ObjectId|string} [options.clientId]
 * @param {ObjectId|string} [options.branchId]
 */
RolePermissionSchema.statics.isGranted = async function (userId, roleId, { clientId, branchId } = {}) {
  if (!roleId) return false;

  const now = new Date();

  const query = {
    isActive: true,
    role: roleId,
    permissions: "PRIVACY.ENCRYPTVIEW",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };

  if (clientId) query.client = clientId;
  if (branchId) query.branch = branchId;

  const doc = await this.findOne(query).select("restrictedUsers").lean();
  if (!doc) return false;

  const entry = doc.restrictedUsers.find(
    (r) => r.user.toString() === userId.toString()
  );

  if (!entry) return true; // user not restricted at all

  // modules: [] + options: [] = blocked from everything
  // modules includes "PRIVACY"        = blocked from all PRIVACY.* permissions
  // options includes "PRIVACY.ENCRYPTVIEW" = blocked from that specific permission
  const blockedFromPrivacy =
    (entry.modules.length === 0 && entry.options.length === 0) ||
    entry.modules.includes("PRIVACY") ||
    entry.options.includes("PRIVACY.ENCRYPTVIEW");

  return !blockedFromPrivacy;
};

/**
 * Get effective permission strings for a given user+role combination.
 * Filters out any permissions belonging to modules the user is restricted from.
 *
 * @param {ObjectId|string} roleId
 * @param {ObjectId|string} [userId]  - if provided, applies per-user module restrictions
 * @returns {string[]}
 */
RolePermissionSchema.statics.getPermissions = async function (roleId, userId = null) {
  if (!roleId) return [];

  const now = new Date();
  const doc = await this.findOne({
    isActive: true,
    role: roleId,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  })
    .select("permissions restrictedUsers")
    .lean();

  if (!doc) return [];

  let perms = doc.permissions ?? [];

  if (userId) {
    const entry = doc.restrictedUsers.find(
      (r) => r.user.toString() === userId.toString()
    );

    if (entry) {
      if (entry.modules.length === 0 && entry.options.length === 0) {
        // Blocked from all permissions
        return [];
      }
      // Filter out permissions whose module prefix is in the blocked modules list,
      // or whose exact string is in the blocked options list
      perms = perms.filter((p) => {
        const module = p.split(".")[0]; // e.g. "USER" from "USER.ADD"
        return !entry.modules.includes(module) && !entry.options.includes(p);
      });
    }
  }

  return perms;
};

module.exports = mongoose.model("RolePermission", RolePermissionSchema);
