const mongoose = require("mongoose");
const { Schema } = mongoose;

const QuestionOptionSchema = new Schema(
  {
    key: { type: String, trim: true, required: true }, // A,B,C,D
    text: { type: String, trim: true, required: true },
  },
  { _id: false },
);

const TrainingModuleQuestionSchema = new Schema(
  {
    uid: { type: String, trim: true, index: true },

    text: { type: String, required: true, trim: true },

    type: {
      type: String,
      enum: ["single", "multiple", "boolean"],
      default: "single",
      index: true,
    },

    options: { type: [QuestionOptionSchema], default: [] },

    correctAnswers: [{ type: String, trim: true }],

    explanation: { type: String, trim: true },

    points: { type: Number, default: 1 },

    order: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);
TrainingModuleQuestionSchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `Q_${Date.now()}`;
  }

  next();
});

module.exports = mongoose.model(
  "TrainingModuleQuestion",
  TrainingModuleQuestionSchema,
);
