const mongoose = require("mongoose");
const { Schema } = mongoose;

const UserTypeSchema = new Schema(
  {
    // The login this membership belongs to.
    user: { type: Schema.Types.ObjectId, ref: "Users", default: null, index: true },

    // What kind of actor this membership represents.
    // user, customer, client, branch, dooit
    userType: {
      type: String,
      trim: true,
      required: [true, "userType is required"],
      default: "user",
      // Optional hardening: enum: ["user", "customer", "client", "branch", "dooit"],
    },

    // Role NAME (case-insensitive), matched to Role.name exactly like the legacy
    // top-level `role`. Kept for backward-compat with auth.js and attachUserRoleId.
    // `roleId` is the eventual source of truth.
    role: { type: String, default: "user" },

    // Role reference — populate this and prefer it going forward.
    roleId: { type: Schema.Types.ObjectId, ref: "Roles", default: null, index: true },

    // Tenant scope for THIS membership.
    clientBelongs: { type: Schema.Types.ObjectId, ref: "Client", default: null, index: true },
    branchBelongs: { type: Schema.Types.ObjectId, ref: "Branch", default: null, index: true },

    isActive: { type: Boolean, default: true },

    // GRC/AML audit — who assigned this membership.
    assignedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
  }
);

// A user cannot hold the same (userType, role, client, branch) twice.
// Mongo indexes null as a value, so memberships differing only by userType stay distinct.
UserTypeSchema.index(
  { user: 1, userType: 1, role: 1, clientBelongs: 1, branchBelongs: 1 },
  { unique: true }
);

// Helps login resolve "this user's row for the requested userType" fast.
UserTypeSchema.index({ user: 1, userType: 1, isActive: 1 });

// Keep the role name and roleId in sync (name → id when only the name is supplied).
UserTypeSchema.pre("save", async function (next) {
  if (this.isModified("role") && !this.roleId && this.role) {
    const Role = mongoose.model("Roles");
    const doc = await Role.findOne({ name: new RegExp(`^${this.role}$`, "i") }).select("_id name").lean();
    if (doc) this.roleId = doc._id;
  }
  next();
});

module.exports = mongoose.model("UserType", UserTypeSchema);