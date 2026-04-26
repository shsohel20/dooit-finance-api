const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const ModuleAssignment = require("../models/ModuleAssignment");
const TrainingLearnerProgress = require("../models/TrainingLearnerProgress");
const TrainingModule = require("../models/TrainingModule");
const TrainingModuleAccess = require("../models/TrainingModuleAccess");
const User = require("../models/User");
const Roles = require("../models/Role");

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

    // ── Role-gate: check TrainingModuleAccess rules ───────────────────────────
    const accessRules = await TrainingModuleAccess.find({ module: moduleId, status: "active" })
        .select("roles")
        .lean();

    // learner _id -> Roles ObjectId map (populated only when access rules exist)
    const learnerRoleIdMap = {};
    const roleBlocked = [];
    let eligibleIds = learnerIds;

    if (accessRules.length > 0) {
        const openToAll = accessRules.some((a) => a.roles.length === 0);

        if (!openToAll) {
            // Fetch learner role strings in one query
            const learnerUsers = await User.find({ _id: { $in: learnerIds } })
                .select("_id role")
                .lean();

            const uniqueRoleNames = [...new Set(learnerUsers.map((u) => u.role).filter(Boolean))];

            // Resolve role name -> ObjectId
            const roleDocs = await Roles.find({ name: { $in: uniqueRoleNames }, isActive: true })
                .select("_id name")
                .lean();

            const roleNameToId = {};
            for (const r of roleDocs) roleNameToId[r.name] = String(r._id);

            // Build learner -> roleId map
            for (const u of learnerUsers) {
                learnerRoleIdMap[String(u._id)] = roleNameToId[u.role] || null;
            }

            // Collect all allowed role ObjectIds across all access rules
            const allowedRoleIds = new Set(
                accessRules.flatMap((a) => a.roles.map((r) => String(r)))
            );

            // Split into eligible vs blocked
            eligibleIds = [];
            for (const uid of learnerIds) {
                const roleId = learnerRoleIdMap[String(uid)];
                if (roleId && allowedRoleIds.has(roleId)) {
                    eligibleIds.push(uid);
                } else {
                    roleBlocked.push(uid);
                }
            }

            if (eligibleIds.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: "None of the learners have a role permitted by this module's access rules.",
                    roleBlocked: roleBlocked.length,
                });
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const docs = eligibleIds.map((uid) => ({
        module: moduleId,
        learner: uid,
        assignedBy: req.user._id,
        dueDate: dueDate || undefined,
        maxAttempts: maxAttempts || 0,
        status: "pending",
        roleId: learnerRoleIdMap[String(uid)] || undefined,
    }));

    // ordered:false skips duplicate-key errors (already assigned)
    let insertedCount = 0;
    try {
      const result = await ModuleAssignment.insertMany(docs, {
        ordered: false,
        rawResult: true,
      });
      insertedCount = result.insertedCount ?? 0;
    } catch (err) {
      if (err.name === "MongoBulkWriteError" || err.result) {
        insertedCount = err.result?.insertedCount ?? err.insertedCount ?? 0;
      } else {
        return next(err);
      }
    }

    await TrainingModule.findByIdAndUpdate(moduleId, {
        $inc: { "stats.assignedCount": insertedCount },
    });

    res.status(201).json({
        success: true,
        inserted: insertedCount,
        skipped: eligibleIds.length - insertedCount,
        roleBlocked: roleBlocked.length,
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
            const progress = await TrainingLearnerProgress.findOne({
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
            const progress = await TrainingLearnerProgress.findOne({
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