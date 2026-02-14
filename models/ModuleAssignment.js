const mongoose = require("mongoose");
const { Schema } = mongoose;
const autopopulate = require("mongoose-autopopulate");

const ModuleAssignmentSchema = new Schema(
    {
        uid: { type: String, unique: true, index: true },

        module: {
            type: Schema.Types.ObjectId,
            ref: "TrainingModule",
            required: true,
            index: true,
        },

        learner: {
            type: Schema.Types.ObjectId,
            ref: "Users",
            required: true,
            index: true,
            autopopulate: true,

        },

        assignedBy: {
            type: Schema.Types.ObjectId,
            ref: "Users",
            required: true, // manager
        },

        dueDate: Date,

        maxAttempts: {
            type: Number,
            default: 0, // 0 = unlimited
        },

        attemptsUsed: {
            type: Number,
            default: 0,
        },

        status: {
            type: String,
            enum: [
                "assigned",
                "in_progress",
                "completed",
                "passed",
                "failed",
                "expired",
            ],
            default: "assigned",
            index: true,
        },

        score: Number,

        startedAt: Date,
        completedAt: Date,
    },
    {
        timestamps: true,
        virtuals: true,
        toObject: true,
        toJSON: true
    }
);

ModuleAssignmentSchema.index(
    { module: 1, learner: 1 },
    { unique: true } // prevent duplicate assignment
);

ModuleAssignmentSchema.pre("save", function (next) {
    if (!this.uid) this.uid = `ASSIGN_${Date.now()}`;
    next();
});

ModuleAssignmentSchema.plugin(autopopulate);

module.exports = mongoose.model("ModuleAssignment", ModuleAssignmentSchema);
