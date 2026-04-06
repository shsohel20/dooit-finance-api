const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * PrivacyPermission
 *
 * Controls WHO can read encrypted fields. WHAT fields are encrypted on which
 * model is a developer concern — defined via fieldMeta() in each schema and
 * maintained in the privacy config (config/privacyFields.js).
 *
 * Grant logic:
 *   - roleNames         → roles that are allowed to see decrypted data
 *   - restrictedUserIds → specific users blocked even if their role is granted
 */
const PrivacyPermissionSchema = new Schema(
  {
    client: { type: Schema.Types.ObjectId, ref: "Client", index: true, default: null },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", index: true, default: null },
    // Human-readable label, e.g. "Analyst team read access"
    name: {
      type: String,
      trim: true,
      required: [true, "Permission name is required"],
    },

    // One or more roles granted read access to decrypted fields
    roleNames: {
      type: [String],
      default: [],
    },

    // Specific users explicitly blocked from this permission,
    // even if their role is in roleNames above.
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

PrivacyPermissionSchema.index({ roleNames: 1 });
PrivacyPermissionSchema.index({ restrictedUserIds: 1 });
PrivacyPermissionSchema.index({ isActive: 1 });

/**
 * Check whether a given user is granted read access to decrypted fields.
 *
 * Returns true  → user can see plaintext for all fields their role covers
 * Returns false → user gets "***" (no active permission, or explicitly restricted)
 *
 * Usage (in protect middleware):
 *   const canRead = await PrivacyPermission.isGranted(userId, roleName);
 */
PrivacyPermissionSchema.statics.isGranted = async function (userId, roleName, { clientId, branchId } = {}) {
  const now = new Date();

  const query = {
    isActive: true,
    roleNames: roleName,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };

  if (clientId) query.client = clientId;
  if (branchId) query.branch = branchId;

  const permission = await this.findOne(query)
    .select("restrictedUserIds")
    .lean();

  if (!permission) return false;

  const isRestricted = permission.restrictedUserIds.some(
    (id) => id.toString() === userId.toString()
  );

  return !isRestricted;
};

module.exports = mongoose.model("PrivacyPermission", PrivacyPermissionSchema);
