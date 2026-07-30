// models/OnboardingStep.js
const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

const StepSchema = new Schema(
  {
    step: { type: String, required: true, trim: true },
    order: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "skipped", "failed"],
      default: "pending",
    },
    required: { type: Boolean, default: true },
    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    notes: { type: String, default: null },
    data: { type: Schema.Types.Mixed, default: {} },
    dueDate: { type: Date, default: null },
  },
  { _id: false }
);

const OnboardingStepSchema = new Schema(
  {
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      default: null,
      // index defined below via schema.index({ client: 1 }, { unique, sparse })
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      // index defined below via schema.index({ branch: 1 }, { unique, sparse })
    },
    steps: { type: [StepSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One onboarding record per client or branch
OnboardingStepSchema.index({ client: 1 }, { unique: true, sparse: true });
OnboardingStepSchema.index({ branch: 1 }, { unique: true, sparse: true });

OnboardingStepSchema.pre("validate", function (next) {
  if (!this.client && !this.branch) {
    return next(new Error("OnboardingStep requires either a client or a branch."));
  }
  next();
});

OnboardingStepSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("OnboardingStep", OnboardingStepSchema);
