const mongoose = require("mongoose");
const { Schema } = mongoose;
const autopopulate = require("mongoose-autopopulate");

/**
 * ModuleAssignment
 * One document per (module, learner) pair — a manager assigns a module to one or more learners.
 * Each learner gets their own document (insertMany approach in the controller).
 */
const ModuleAssignmentSchema = new Schema(
  {
    uid: {
      type: String,
      unique: true,
      index: true,
      default: () => `MODASS_${new mongoose.Types.ObjectId()}`,
    },

    module: {
      type: Schema.Types.ObjectId,
      ref: "TrainingModule",
      required: true,
      index: true,
      autopopulate: { select: "title uid status stats" },
    },

    learner: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
      autopopulate: { select: "name email" },
    },

    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
      autopopulate: { select: "name email" },
    },

    dueDate: { type: Date },

    // 0 = unlimited
    maxAttempts: { type: Number, default: 0 },

    // Number of times the manager has granted a retake
    retakesGranted: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "in-progress", "completed", "overdue"],
      default: "pending",
      index: true,
    },

    // Role the learner held at assignment time (snapshot for audit/reports)
    roleId: {
      type: Schema.Types.ObjectId,
      ref: "Roles",
      index: true,
    },

    // Snapshot of final score when completed
    finalScore: { type: Number },
    isPassed: { type: Boolean },

    completedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Prevent duplicate assignments for the same (module, learner) pair
ModuleAssignmentSchema.index({ module: 1, learner: 1 }, { unique: true });

ModuleAssignmentSchema.plugin(autopopulate);
ModuleAssignmentSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `MODASS_${Date.now()}`;
  }

  next();
});
module.exports = mongoose.model("ModuleAssignment", ModuleAssignmentSchema);
