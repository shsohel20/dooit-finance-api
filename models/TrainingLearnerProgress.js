const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * Individual question attempt within a part session
 */
const AttemptSchema = new Schema(
  {
    part: {
      type: Schema.Types.ObjectId,
      ref: "TrainingModulePart",
      required: true,
    },
    question: {
      type: Schema.Types.ObjectId,
      ref: "TrainingModuleQuestion",
      required: true,
    },
    selectedAnswer: { type: String, required: true }, // key value e.g. "A"
    isCorrect: { type: Boolean, required: true },
    pointsEarned: { type: Number, default: 0 },
    possiblePoints: { type: Number, default: 1 }, // max points this question could earn
    attemptRound: { type: Number, default: 1 }, // which retake round this belongs to
  },
  { timestamps: true, _id: true },
);

/**
 * Video watch record per part
 */
const WatchRecordSchema = new Schema(
  {
    part: { type: Schema.Types.ObjectId, ref: "TrainingModulePart" },
    watchedSeconds: { type: Number, default: 0 },
    durationSec: { type: Number, default: 0 },
    watchPercent: { type: Number, default: 0 },
    completed: { type: Boolean, default: false }, // watchPercent >= minWatchPercent
  },
  { _id: false },
);

/**
 * TrainingLearnerProgress — one document per (learner, module) pair
 * Tracks all attempts, watch records, scores, and completion state.
 */
const TrainingLearnerProgressSchema = new Schema(
  {
    uid: { type: String, unique: true, index: true },

    learner: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },

    module: {
      type: Schema.Types.ObjectId,
      ref: "TrainingModule",
      required: true,
      index: true,
    },

    assignment: {
      type: Schema.Types.ObjectId,
      ref: "ModuleAssignment",
      index: true,
    },

    // Current retake round (starts at 1, incremented on each retake)
    attemptRound: { type: Number, default: 1 },

    // Index of the part the learner is currently on (0-based)
    currentPartIndex: { type: Number, default: 0 },

    // All question attempts across all rounds
    attempts: { type: [AttemptSchema], default: [] },

    // Per-part video watch data
    watchRecords: { type: [WatchRecordSchema], default: [] },

    // Aggregate scoring (calculated and stored on completion)
    totalPoints: { type: Number, default: 0 },
    maxPoints: { type: Number, default: 0 },
    score: { type: Number, default: 0 }, // 0–100 percentage

    isPassed: { type: Boolean, default: false },
    passThreshold: { type: Number, default: 70 }, // configurable per assignment

    // Timestamps
    startedAt: { type: Date },
    completedAt: { type: Date },
    passedAt: { type: Date },
    lastActivityAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Compound unique index — one progress doc per learner+module
TrainingLearnerProgressSchema.index(
  { learner: 1, module: 1 },
  { unique: true },
);
TrainingLearnerProgressSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `TMA-PCSS_${Date.now()}`;
  }

  next();
});
/**
 * Virtual: progress status string
 */
TrainingLearnerProgressSchema.virtual("status").get(function () {
  if (this.isPassed) return "passed";
  if (this.completedAt) return "failed";
  if (this.attempts?.length > 0) return "in-progress";
  if (this.startedAt) return "started";
  return "not-started";
});

/**
 * Virtual: current-round attempts only
 */
TrainingLearnerProgressSchema.virtual("currentAttempts").get(function () {
  return this.attempts.filter((a) => a.attemptRound === this.attemptRound);
});

/**
 * Helper: recalculate score from current-round attempts
 * Call this after bulk-inserting attempts, before saving.
 */
TrainingLearnerProgressSchema.methods.recalculateScore = function () {
  const current = this.attempts.filter(
    (a) => a.attemptRound === this.attemptRound,
  );
  const totalPoints = current.reduce(
    (sum, a) => sum + (a.pointsEarned || 0),
    0,
  );
  const maxPoints = current.reduce(
    (sum, a) => sum + (a.possiblePoints || 1),
    0,
  );
  this.totalPoints = totalPoints;
  this.maxPoints = maxPoints;
  this.score = maxPoints > 0 ? Math.round((totalPoints / maxPoints) * 100) : 0;
};

module.exports = mongoose.model(
  "TrainingLearnerProgress",
  TrainingLearnerProgressSchema,
);
