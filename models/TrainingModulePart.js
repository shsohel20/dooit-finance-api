const mongoose = require("mongoose");
const { Schema } = mongoose;
const autopopulate = require("mongoose-autopopulate");

const TrainingModulePartSchema = new Schema(
  {
    uid: { type: String, trim: true, index: true },

    module: {
      type: Schema.Types.ObjectId,
      ref: "TrainingModule",
      index: true,
      //   autopopulate: { select: "title uid" },
    },

    title: { type: String, required: true, trim: true },

    description: { type: String, trim: true },

    video: {
      url: { type: String, trim: true, default: "" },
      provider: { type: String, trim: true, default: "" },
      durationSec: { type: Number, default: 0 },
    },

    questions: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "TrainingModuleQuestion",
          index: true,
          autopopulate: true,
        },
      ],
      default: [], //  prevents push crash
    },

    minWatchPercent: { type: Number, default: 80 },
    passAllRequired: { type: Boolean, default: true },
    maxRetries: { type: Number, default: 0 },
    estimatedTimeMin: { type: Number, default: 5 },
    order: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Title unique per module, not globally
TrainingModulePartSchema.index({ module: 1, title: 1 }, { unique: true });

TrainingModulePartSchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `PART_${Date.now()}`;
  }
  next();
});

TrainingModulePartSchema.virtual("questionsCounts").get(function () {
  if (!this.questions || !Array.isArray(this.questions)) return 0;
  return this.questions.length;
});

TrainingModulePartSchema.plugin(autopopulate);

module.exports = mongoose.model("TrainingModulePart", TrainingModulePartSchema);
