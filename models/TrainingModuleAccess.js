const mongoose = require("mongoose");
const { Schema } = mongoose;
const autopopulate = require("mongoose-autopopulate");

/**
 * TrainingModuleAccess
 * Admin assigns a module to one or more (client / branch / role) scopes.
 * Each scope gets its own document so the same module can target many organisations.
 */
const TrainingModuleAccessSchema = new Schema(
  {
    module: {
      type: Schema.Types.ObjectId,
      ref: "TrainingModule",
      required: true,
      index: true,
      autopopulate: { select: "title uid status" },
    },

    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      index: true,
      autopopulate: { select: "name" },
    },

    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      index: true,
      autopopulate: { select: "name" },
    },

    // Optional role filters within the client/branch
    roles: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "Roles",
          autopopulate: { select: "name isActive" },
        },
      ],
      default: [],
      index: true,
    },

    // Dooit Admin who created this access rule
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
      autopopulate: { select: "name email" },
    },

    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Prevent duplicate scope per module+client+branch combination
TrainingModuleAccessSchema.index(
  { module: 1, client: 1, branch: 1 },
  { unique: true, sparse: true }
);

TrainingModuleAccessSchema.plugin(autopopulate);

module.exports = mongoose.model("TrainingModuleAccess", TrainingModuleAccessSchema);
