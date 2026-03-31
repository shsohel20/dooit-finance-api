const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const LearnerProgress = require("../models/LearnerProgress");
const ModuleAssignment = require("../models/ModuleAssignment");
const TrainingModule = require("../models/TrainingModule");
const TrainingModulePart = require("../models/TrainingModulePart");
const TrainingModuleQuestion = require("../models/TrainingModuleQuestion");

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Upsert progress doc — find or create for (learner, module)
 */
async function findOrCreateProgress(learnerId, moduleId, assignmentId) {
    let progress = await LearnerProgress.findOne({
        learner: learnerId,
        module: moduleId,
    });

    if (!progress) {
        progress = await LearnerProgress.create({
            learner: learnerId,
            module: moduleId,
            assignment: assignmentId || undefined,
            startedAt: new Date(),
            lastActivityAt: new Date(),
        });

        // Mark assignment in-progress
        if (assignmentId) {
            await ModuleAssignment.findByIdAndUpdate(assignmentId, {
                status: "in-progress",
            });
        }
    }

    return progress;
}

// ─── GET /progress/:moduleId ─────────────────────────────────────────────────
// @desc  Get my progress for a specific module (learner)
// @route GET /api/v1/progress/:moduleId
exports.getMyProgress = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;

    if (!isValidId(moduleId))
        return next(new ErrorResponse("Invalid module id", 400));

    const progress = await LearnerProgress.findOne({
        learner: req.user._id,
        module: moduleId,
    });

    if (!progress)
        return res.status(200).json({ success: true, data: null }); // not started yet

    res.status(200).json({ success: true, data: progress });
});

// ─── GET /progress ───────────────────────────────────────────────────────────
// @desc  Get all my progress records (learner dashboard)
// @route GET /api/v1/progress
exports.getAllMyProgress = asyncHandler(async (req, res, next) => {
    const records = await LearnerProgress.find({ learner: req.user._id })
        .populate("module", "title uid status stats partsCount")
        .lean();

    res.status(200).json({ success: true, count: records.length, data: records });
});

// ─── POST /progress/:moduleId/start ─────────────────────────────────────────
// @desc  Start (or resume) a module — creates the progress doc if needed
// @route POST /api/v1/progress/:moduleId/start
exports.startModule = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;

    if (!isValidId(moduleId))
        return next(new ErrorResponse("Invalid module id", 400));

    const mod = await TrainingModule.findById(moduleId);
    if (!mod) return next(new ErrorResponse("Module not found", 404));

    // Confirm learner has an active assignment
    const assignment = await ModuleAssignment.findOne({
        module: moduleId,
        learner: req.user._id,
        status: { $in: ["pending", "in-progress"] },
    });

    if (!assignment)
        return next(
            new ErrorResponse("You are not assigned to this module", 403)
        );

    const progress = await findOrCreateProgress(
        req.user._id,
        moduleId,
        assignment._id
    );

    res.status(200).json({ success: true, data: progress });
});

// ─── POST /progress/:moduleId/attempts ──────────────────────────────────────
// @desc  Submit answers for a part (bulk attempt submission)
//        Body: { partId, answers: [{ questionId, selectedAnswer }] }
// @route POST /api/v1/progress/:moduleId/attempts
exports.submitAttempts = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;
    const { partId, answers } = req.body; // answers: [{ questionId, selectedAnswer }]

    if (!isValidId(moduleId))
        return next(new ErrorResponse("Invalid module id", 400));
    if (!isValidId(partId))
        return next(new ErrorResponse("Invalid part id", 400));
    if (!Array.isArray(answers) || answers.length === 0)
        return next(new ErrorResponse("answers array is required", 400));

    // Load part with questions populated
    const part = await TrainingModulePart.findById(partId).populate("questions");
    if (!part) return next(new ErrorResponse("Part not found", 404));
    if (String(part.module) !== String(moduleId))
        return next(new ErrorResponse("Part does not belong to this module", 400));

    const assignment = await ModuleAssignment.findOne({
        module: moduleId,
        learner: req.user._id,
    });
    if (!assignment)
        return next(new ErrorResponse("You are not assigned to this module", 403));

    const progress = await findOrCreateProgress(
        req.user._id,
        moduleId,
        assignment._id
    );

    // Build a map of questionId -> question doc for quick lookup
    const questionMap = {};
    part.questions.forEach((q) => {
        questionMap[String(q._id)] = q;
    });

    const newAttempts = [];
    for (const { questionId, selectedAnswer } of answers) {
        if (!isValidId(questionId)) continue;

        const question = questionMap[questionId];
        if (!question) continue;

        // Determine correctness (correctAnswers is an array of keys)
        let isCorrect = false;
        if (question.type === "single" || question.type === "boolean") {
            isCorrect = question.correctAnswers.includes(String(selectedAnswer));
        } else if (question.type === "multiple") {
            // For multiple-select, selectedAnswer should be a comma-separated or array
            const selected = Array.isArray(selectedAnswer)
                ? selectedAnswer.map(String)
                : String(selectedAnswer)
                    .split(",")
                    .map((s) => s.trim());
            const correct = question.correctAnswers.map(String).sort();
            isCorrect =
                JSON.stringify(selected.sort()) === JSON.stringify(correct);
        }

        newAttempts.push({
            part: partId,
            question: questionId,
            selectedAnswer: Array.isArray(selectedAnswer)
                ? selectedAnswer.join(",")
                : String(selectedAnswer),
            isCorrect,
            pointsEarned: isCorrect ? question.points || 1 : 0,
            attemptRound: progress.attemptRound,
        });
    }

    // Add new attempts to the progress document
    progress.attempts.push(...newAttempts);

    // Advance currentPartIndex if this part is now complete
    const partIndex = (
        await TrainingModulePart.find({ module: moduleId }).sort("order").select("_id")
    ).findIndex((p) => String(p._id) === String(partId));

    if (partIndex >= 0 && partIndex >= progress.currentPartIndex) {
        progress.currentPartIndex = partIndex + 1;
    }

    progress.lastActivityAt = new Date();
    progress.recalculateScore();
    await progress.save();

    // Build per-question result for the response
    const results = newAttempts.map((a) => ({
        questionId: a.question,
        selectedAnswer: a.selectedAnswer,
        isCorrect: a.isCorrect,
        pointsEarned: a.pointsEarned,
    }));

    const partScore = newAttempts.length
        ? Math.round(
            (newAttempts.filter((a) => a.isCorrect).length / newAttempts.length) *
            100
        )
        : 0;

    res.status(201).json({
        success: true,
        data: {
            results,
            partScore,
            passed: partScore >= 70,
            overallScore: progress.score,
            currentPartIndex: progress.currentPartIndex,
        },
    });
});

// ─── PUT /progress/:moduleId/watch ──────────────────────────────────────────
// @desc  Update video watch record for a part
//        Body: { partId, watchedSeconds, durationSec }
// @route PUT /api/v1/progress/:moduleId/watch
exports.updateWatchProgress = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;
    const { partId, watchedSeconds, durationSec } = req.body;

    if (!isValidId(moduleId))
        return next(new ErrorResponse("Invalid module id", 400));
    if (!isValidId(partId))
        return next(new ErrorResponse("Invalid part id", 400));

    const part = await TrainingModulePart.findById(partId).select(
        "minWatchPercent module"
    );
    if (!part) return next(new ErrorResponse("Part not found", 404));

    const assignment = await ModuleAssignment.findOne({
        module: moduleId,
        learner: req.user._id,
    });
    if (!assignment)
        return next(new ErrorResponse("Not assigned to this module", 403));

    const progress = await findOrCreateProgress(
        req.user._id,
        moduleId,
        assignment._id
    );

    const effectiveDuration = durationSec || part.video?.durationSec || 0;
    const watchPercent =
        effectiveDuration > 0
            ? Math.min(100, Math.round((watchedSeconds / effectiveDuration) * 100))
            : 0;

    // Upsert watch record for this part
    const existingIdx = progress.watchRecords.findIndex(
        (w) => String(w.part) === String(partId)
    );

    const record = {
        part: partId,
        watchedSeconds: Math.max(
            watchedSeconds,
            existingIdx >= 0 ? progress.watchRecords[existingIdx].watchedSeconds : 0
        ),
        durationSec: effectiveDuration,
        watchPercent,
        completed: watchPercent >= (part.minWatchPercent || 80),
    };

    if (existingIdx >= 0) {
        progress.watchRecords[existingIdx] = record;
    } else {
        progress.watchRecords.push(record);
    }

    progress.lastActivityAt = new Date();
    await progress.save();

    res.status(200).json({ success: true, data: record });
});

// ─── POST /progress/:moduleId/complete ──────────────────────────────────────
// @desc  Mark module as completed, calculate final score & pass/fail
// @route POST /api/v1/progress/:moduleId/complete
exports.completeModule = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;

    if (!isValidId(moduleId))
        return next(new ErrorResponse("Invalid module id", 400));

    const progress = await LearnerProgress.findOne({
        learner: req.user._id,
        module: moduleId,
    });
    if (!progress)
        return next(new ErrorResponse("No progress record found", 404));

    if (progress.completedAt)
        return next(
            new ErrorResponse("Module already completed. Use retake to reset.", 400)
        );

    progress.recalculateScore();

    const isPassed = progress.score >= progress.passThreshold;
    progress.isPassed = isPassed;
    progress.completedAt = new Date();
    if (isPassed) progress.passedAt = new Date();
    progress.lastActivityAt = new Date();

    await progress.save();

    // Update assignment status + snapshot score
    const updatePayload = {
        finalScore: progress.score,
        isPassed,
        completedAt: progress.completedAt,
        status: "completed",
    };

    const assignment = await ModuleAssignment.findOneAndUpdate(
        { module: moduleId, learner: req.user._id },
        updatePayload,
        { new: true }
    );

    // Update module aggregate stats
    const statsUpdate = { $inc: {} };
    if (isPassed) {
        statsUpdate.$inc["stats.passedCount"] = 1;
    } else {
        statsUpdate.$inc["stats.failedCount"] = 1;
    }

    // Recalculate avgScore (simple running average stored in module stats)
    const module = await TrainingModule.findById(moduleId);
    if (module) {
        const completedCount =
            (module.stats.passedCount || 0) +
            (module.stats.failedCount || 0) +
            1; // include this new one
        statsUpdate.$set = {
            "stats.avgScore": Number(
                (
                    ((module.stats.avgScore || 0) * (completedCount - 1) +
                        progress.score) /
                    completedCount
                ).toFixed(2)
            ),
        };
    }

    await TrainingModule.findByIdAndUpdate(moduleId, statsUpdate);

    res.status(200).json({
        success: true,
        data: {
            score: progress.score,
            isPassed,
            passThreshold: progress.passThreshold,
            completedAt: progress.completedAt,
        },
    });
});

// ─── POST /progress/:moduleId/retake ────────────────────────────────────────
// @desc  Manager grants a retake — resets learner progress for one more attempt
// @route POST /api/v1/progress/:moduleId/retake   (manager role)
exports.grantRetake = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;
    const { learnerId } = req.body;

    if (!isValidId(moduleId))
        return next(new ErrorResponse("Invalid module id", 400));
    if (!learnerId || !isValidId(learnerId))
        return next(new ErrorResponse("learnerId is required", 400));

    const assignment = await ModuleAssignment.findOne({
        module: moduleId,
        learner: learnerId,
    });
    if (!assignment)
        return next(new ErrorResponse("Assignment not found", 404));

    // Check maxAttempts
    if (assignment.maxAttempts > 0) {
        const progress = await LearnerProgress.findOne({
            learner: learnerId,
            module: moduleId,
        });
        if (progress && progress.attemptRound >= assignment.maxAttempts) {
            return next(
                new ErrorResponse(
                    `Max attempts (${assignment.maxAttempts}) reached`,
                    400
                )
            );
        }
    }

    // Reset progress for new round
    await LearnerProgress.findOneAndUpdate(
        { learner: learnerId, module: moduleId },
        {
            $inc: { attemptRound: 1, "assignment.retakesGranted": 0 },
            $set: {
                currentPartIndex: 0,
                isPassed: false,
                score: 0,
                totalPoints: 0,
                maxPoints: 0,
                completedAt: null,
                passedAt: null,
                lastActivityAt: new Date(),
            },
        }
    );

    await ModuleAssignment.findByIdAndUpdate(assignment._id, {
        $inc: { retakesGranted: 1 },
        status: "in-progress",
        finalScore: null,
        isPassed: null,
        completedAt: null,
    });

    // Update module stats
    await TrainingModule.findByIdAndUpdate(moduleId, {
        $inc: { "stats.startedCount": 1 },
    });

    res.status(200).json({
        success: true,
        message: "Retake granted. Learner can now restart the module.",
    });
});

// ─── GET /progress/report ────────────────────────────────────────────────────
// @desc  Manager/admin: get all progress across assignments they manage
// @route GET /api/v1/progress/report
exports.getProgressReport = asyncHandler(async (req, res, next) => {
    const { moduleId, status, learnerId } = req.query;

    const filter = {};

    // Managers see only their assignments; admins see all
    if (req.user.role === "manager") {
        const myAssignments = await ModuleAssignment.find({
            assignedBy: req.user._id,
        }).select("_id");
        filter.assignment = { $in: myAssignments.map((a) => a._id) };
    }

    if (moduleId && isValidId(moduleId)) filter.module = moduleId;
    if (learnerId && isValidId(learnerId)) filter.learner = learnerId;
    if (status) {
        // status is a virtual — filter by stored fields
        if (status === "passed") filter.isPassed = true;
        else if (status === "failed")
            Object.assign(filter, { isPassed: false, completedAt: { $ne: null } });
        else if (status === "in-progress")
            Object.assign(filter, {
                completedAt: null,
                "attempts.0": { $exists: true },
            });
        else if (status === "not-started")
            Object.assign(filter, { attempts: { $size: 0 } });
    }

    const records = await LearnerProgress.find(filter)
        .populate("learner", "name email")
        .populate("module", "title uid")
        .populate("assignment", "dueDate maxAttempts status")
        .lean();

    // Attach virtual status manually since lean() strips virtuals
    const enriched = records.map((r) => ({
        ...r,
        status: r.isPassed
            ? "passed"
            : r.completedAt
                ? "failed"
                : r.attempts?.length > 0
                    ? "in-progress"
                    : "not-started",
    }));

    res.status(200).json({
        success: true,
        count: enriched.length,
        data: enriched,
    });
});

// ─── GET /progress/:moduleId/learners ────────────────────────────────────────
// @desc  Manager: get per-learner progress for a specific module
// @route GET /api/v1/progress/:moduleId/learners
exports.getModuleLearnerProgress = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;

    if (!isValidId(moduleId))
        return next(new ErrorResponse("Invalid module id", 400));

    const records = await LearnerProgress.find({ module: moduleId })
        .populate("learner", "name email")
        .lean();

    const enriched = records.map((r) => ({
        ...r,
        status: r.isPassed
            ? "passed"
            : r.completedAt
                ? "failed"
                : r.attempts?.length > 0
                    ? "in-progress"
                    : "not-started",
        correctCount: r.attempts?.filter((a) => a.isCorrect).length || 0,
        totalAttempts: r.attempts?.length || 0,
    }));

    res.status(200).json({ success: true, count: enriched.length, data: enriched });
});