const mongoose = require("mongoose");
const { Schema } = mongoose;

const autopopulate = require("mongoose-autopopulate");

/**
 * Main Training Module Schema
 */
const TrainingModuleSchema = new Schema(
  {
    uid: { type: String, unique: true, index: true }, // MOD_xxx
    client: { type: Schema.Types.ObjectId, ref: "Client", index: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", index: true },

    title: { type: String, required: true, trim: true, index: true },

    slug: { type: String, trim: true, unique: true, sparse: true },

    description: { type: String, trim: true },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      index: true,
      autopopulate: { select: "name email" },
    },

    manager: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      index: true,
      autopopulate: { select: "name email" },
    },

    stats: {
      assignedCount: { type: Number, default: 0 },
      startedCount: { type: Number, default: 0 },
      passedCount: { type: Number, default: 0 },
      failedCount: { type: Number, default: 0 },
      avgScore: { type: Number, default: 0 },
    },

    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
      index: true,
    },

    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/**
 * Pre-save logic
 */
TrainingModuleSchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `MOD_${Date.now()}`;
  }

  if (this.title && !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  next();
});

/**
 * Indexes
 */
TrainingModuleSchema.index({
  title: "text",
  description: "text",
  tags: "text",
});

/**
 * Virtuals
 */

/**
 * Virtual populate parts
 */
TrainingModuleSchema.virtual("parts", {
  ref: "TrainingModulePart",
  localField: "_id",
  foreignField: "module",
  autopopulate: { select: " questions" },
});

/**
 * Count parts
 */
TrainingModuleSchema.virtual("partsCount", {
  ref: "TrainingModulePart",
  localField: "_id",
  foreignField: "module",
  count: true,
  autopopulate: true,
});
/**
 * Derived stats
 */
TrainingModuleSchema.virtual("questionsCount").get(function () {
  if (!this.parts) return 0;
  return this.parts.reduce((sum, p) => sum + (p.questions?.length || 0), 0);
});

TrainingModuleSchema.virtual("avgQuestionsPerPart").get(function () {
  if (!this.parts?.length) return 0;
  return Number((this.questionsCount / this.parts.length).toFixed(2));
});

TrainingModuleSchema.virtual("isPublished").get(function () {
  return this.status === "published";
});

TrainingModuleSchema.plugin(autopopulate);

module.exports = mongoose.model("TrainingModule", TrainingModuleSchema);
