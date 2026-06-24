const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const RemediationTaskSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },

    issue: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IssueRegister",
      required: true,
      index: true,
    },

    taskId: { type: String, uppercase: true, trim: true, index: true },

    title:       { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    priority: {
      type: String,
      enum: ["Critical", "High", "Medium", "Low"],
      default: "Medium",
    },

    status: {
      type: String,
      enum: ["Open", "In Progress", "Completed", "Overdue", "Cancelled"],
      default: "Open",
      index: true,
    },

    assignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },

    dueDate:     { type: Date },
    completedAt: { type: Date },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },

    notes: { type: String },
  },
  { timestamps: true }
);

// Auto-generate taskId scoped to the issue
RemediationTaskSchema.pre("save", async function (next) {
  if (this.taskId) return next();
  const count = await this.constructor.countDocuments({ issue: this.issue });
  this.taskId = `REM-${String(count + 1).padStart(4, "0")}`;
  next();
});

RemediationTaskSchema.index({ client: 1, issue: 1 });
RemediationTaskSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("RemediationTask", RemediationTaskSchema);
