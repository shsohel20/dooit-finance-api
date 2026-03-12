const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const ModuleAssignment = require("../models/ModuleAssignment");
const LearnerProgress = require("../models/LearnerProgress");
const TrainingModule = require("../models/TrainingModule");

function isValidId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

// ─── POST /:moduleId/assign ──────────────────────────────────────────────────
// @desc  Assign module to one or more learners
// @route POST /api/v1/assignments/:moduleId/assign
exports.assignModule = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;
    const { learnerIds, dueDate, maxAttempts } = req.body;

    if (!isValidId(moduleId))
        return next(new ErrorResponse("Invalid module id", 400));
    if (!Array.isArray(learnerIds) || learnerIds.length === 0)
        return next(new ErrorResponse("learnerIds must be a non-empty array", 400));

    const mod = await TrainingModule.findById(moduleId);
    if (!mod) return next(new ErrorResponse("Module not found", 404));
    if (mod.status !== "published")
        return next(new ErrorResponse("Only published modules can be assigned", 400));

    const docs = learnerIds.map((uid) => ({
        module: moduleId,
        learner: uid,
        assignedBy: req.user._id,
        dueDate: dueDate || undefined,
        maxAttempts: maxAttempts || 0,
        status: "pending",
    }));

    // ordered:false skips duplicate-key errors (already assigned)
    const result = await ModuleAssignment.insertMany(docs, {
        ordered: false,
        rawResult: true,
    });

    const insertedCount = result.insertedCount || 0;

    await TrainingModule.findByIdAndUpdate(moduleId, {
        $inc: { "stats.assignedCount": insertedCount },
    });

    res.status(201).json({
        success: true,
        inserted: insertedCount,
        skipped: learnerIds.length - insertedCount,
        message: `Module assigned to ${insertedCount} learner(s).`,
    });
});

// ─── GET /assignments/mine ────────────────────────────────────────────────────
// @desc  Learner: get all modules assigned to me, with my progress
// @route GET /api/v1/assignments/mine
exports.getMyAssignments = asyncHandler(async (req, res, next) => {
    const assignments = await ModuleAssignment.find({ learner: req.user._id })
        .populate("module", "title uid description status partsCount questionsCount")
        .populate("assignedBy", "name email")
        .lean();

    // Enrich with progress snapshot
    const enriched = await Promise.all(
        assignments.map(async (a) => {
            const progress = await LearnerProgress.findOne({
                learner: req.user._id,
                module: a.module?._id,
            }).lean();

            return {
                ...a,
                progress: progress
                    ? {
                        score: progress.score,
                        isPassed: progress.isPassed,
                        completedAt: progress.completedAt,
                        currentPartIndex: progress.currentPartIndex,
                        attemptRound: progress.attemptRound,
                        status: progress.isPassed
                            ? "passed"
                            : progress.completedAt
                                ? "failed"
                                : progress.attempts?.length > 0
                                    ? "in-progress"
                                    : "not-started",
                    }
                    : null,
            };
        })
    );

    res.status(200).json({ success: true, count: enriched.length, data: enriched });
});

// ─── GET /assignments/by-me ───────────────────────────────────────────────────
// @desc  Manager: see all assignments they created, with per-learner breakdown
// @route GET /api/v1/assignments/by-me
exports.getAssignedByMe = asyncHandler(async (req, res, next) => {
    const assignments = await ModuleAssignment.find({ assignedBy: req.user._id })
        .populate("module", "title uid status stats")
        .populate("learner", "name email")
        .lean();

    // Enrich each record with live progress
    const enriched = await Promise.all(
        assignments.map(async (a) => {
            const progress = await LearnerProgress.findOne({
                learner: a.learner?._id,
                module: a.module?._id,
            })
                .select("score isPassed completedAt currentPartIndex attemptRound attempts")
                .lean();

            const status = progress
                ? progress.isPassed
                    ? "passed"
                    : progress.completedAt
                        ? "failed"
                        : progress.attempts?.length > 0
                            ? "in-progress"
                            : "not-started"
                : "not-started";

            return {
                ...a,
                progress: progress
                    ? {
                        score: progress.score,
                        isPassed: progress.isPassed,
                        completedAt: progress.completedAt,
                        attemptRound: progress.attemptRound,
                        status,
                    }
                    : null,
            };
        })
    );

    res.status(200).json({ success: true, count: enriched.length, data: enriched });
});

// ─── GET /assignments/:id ─────────────────────────────────────────────────────
// @desc  Get single assignment detail (manager or the assigned learner)
// @route GET /api/v1/assignments/:id
exports.getAssignment = asyncHandler(async (req, res, next) => {
    if (!isValidId(req.params.id))
        return next(new ErrorResponse("Invalid assignment id", 400));

    const assignment = await ModuleAssignment.findById(req.params.id);
    if (!assignment) return next(new ErrorResponse("Assignment not found", 404));

    // Access check: only the learner or the assigner
    const isOwner =
        String(assignment.learner) === String(req.user._id) ||
        String(assignment.assignedBy) === String(req.user._id) ||
        req.user.role === "admin";

    if (!isOwner)
        return next(new ErrorResponse("Not authorised to view this assignment", 403));

    res.status(200).json({ success: true, data: assignment });
});

// ─── DELETE /assignments/:id ──────────────────────────────────────────────────
// @desc  Unassign / revoke an assignment (manager or admin only)
// @route DELETE /api/v1/assignments/:id
exports.deleteAssignment = asyncHandler(async (req, res, next) => {
    if (!isValidId(req.params.id))
        return next(new ErrorResponse("Invalid assignment id", 400));

    const assignment = await ModuleAssignment.findById(req.params.id);
    if (!assignment) return next(new ErrorResponse("Assignment not found", 404));

    // Only the assigner or an admin can revoke
    if (
        String(assignment.assignedBy) !== String(req.user._id) &&
        req.user.role !== "admin"
    ) {
        return next(new ErrorResponse("Not authorised to revoke this assignment", 403));
    }

    await assignment.deleteOne();

    // Decrement module assigned count
    await TrainingModule.findByIdAndUpdate(assignment.module, {
        $inc: { "stats.assignedCount": -1 },
    });

    res.status(200).json({ success: true, data: {} });
});

// ─── GET /assignments ─────────────────────────────────────────────────────────
// @desc  Admin: all assignments across the system (with filters)
// @route GET /api/v1/assignments
exports.getAllAssignments = asyncHandler(async (req, res, next) => {
    // Only admins/managers
    const { moduleId, learnerId, status } = req.query;

    const filter = {};
    if (moduleId && isValidId(moduleId)) filter.module = moduleId;
    if (learnerId && isValidId(learnerId)) filter.learner = learnerId;
    if (status) filter.status = status;

    // Managers can only see their own
    if (req.user.role === "manager") filter.assignedBy = req.user._id;

    const assignments = await ModuleAssignment.find(filter)
        .populate("module", "title uid")
        .populate("learner", "name email")
        .populate("assignedBy", "name email")
        .lean();

    res.status(200).json({ success: true, count: assignments.length, data: assignments });
});

// ─── PATCH /assignments/:id/status ───────────────────────────────────────────
// @desc  Update assignment status (e.g., mark overdue via cron) — admin only
// @route PATCH /api/v1/assignments/:id/status
exports.updateAssignmentStatus = asyncHandler(async (req, res, next) => {
    const { status } = req.body;
    const allowed = ["pending", "in-progress", "completed", "overdue"];

    if (!allowed.includes(status))
        return next(new ErrorResponse(`status must be one of: ${allowed.join(", ")}`, 400));

    const assignment = await ModuleAssignment.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true }
    );
    if (!assignment) return next(new ErrorResponse("Assignment not found", 404));

    res.status(200).json({ success: true, data: assignment });
});