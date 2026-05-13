const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

// A single planned + executed test instance
const TestScheduleSchema = new mongoose.Schema(
  {
    client:        { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },

    // Refs
    template:      { type: mongoose.Schema.Types.ObjectId, ref: "TestTemplate", default: null },
    control:       { type: mongoose.Schema.Types.ObjectId, ref: "Control", default: null },
    entityProfile: { type: mongoose.Schema.Types.ObjectId, ref: "EntityProfile", default: null },
    ewraAssessment:{ type: mongoose.Schema.Types.ObjectId, ref: "EwraAssessment", default: null },

    // Description (copied from template or entered manually)
    name:             { type: String, required: true, trim: true },
    testType:         { type: String, enum: ["Design","Performance","Walkthrough","Substantive","Analytical"], default: "Performance" },
    domain:           { type: String },
    testingProcedure: { type: String },

    // Schedule
    scheduledDate: { type: Date, required: true },
    dueDate:       { type: Date },
    assignedTo:    { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },

    status: {
      type: String,
      enum: ["Scheduled", "In Progress", "Completed", "Overdue", "Cancelled"],
      default: "Scheduled",
      index: true,
    },

    // Result (filled when Completed)
    result: {
      type: String,
      enum: ["Pass", "Fail", "Partial", "Not Applicable", null],
      default: null,
    },

    // Ratings (1–5)
    designRating:      { type: Number, min: 1, max: 5, default: null },
    performanceRating: { type: Number, min: 1, max: 5, default: null },
    effectivenessScore:{ type: Number, min: 1, max: 5, default: null },
    effectivenessLabel:{
      type: String,
      enum: ["Ineffective","Partially Effective","Effective","Highly Effective", null],
      default: null,
    },

    findings:        { type: String },
    recommendations: { type: String },
    evidence:        [String],                   // list of evidence references

    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
  },
  { timestamps: true }
);

// Auto-compute effectivenessScore when design + performance ratings set
TestScheduleSchema.pre("save", function (next) {
  if (this.designRating && this.performanceRating) {
    const avg = (this.designRating + this.performanceRating) / 2;
    this.effectivenessScore = Math.round(avg * 10) / 10;
    if      (avg <= 2) this.effectivenessLabel = "Ineffective";
    else if (avg <= 3) this.effectivenessLabel = "Partially Effective";
    else if (avg <= 4) this.effectivenessLabel = "Effective";
    else               this.effectivenessLabel = "Highly Effective";
  }
  next();
});

TestScheduleSchema.index({ client: 1, status: 1, scheduledDate: 1 });
TestScheduleSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("TestSchedule", TestScheduleSchema);
