const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const TrainingModule = require("../models/TrainingModule");
const ModuleAssignment = require("../models/ModuleAssignment");
const TrainingLearnerProgress = require("../models/TrainingLearnerProgress");

// ─── GET /reports/overview ────────────────────────────────────────────────────
// @desc  High-level KPI snapshot for the dashboard
// @route GET /api/v1/reports/overview
exports.getOverview = asyncHandler(async (req, res, next) => {
    const isAdmin = req.user.role?.toLowerCase() === "admin";
    const managerId = req.user._id;

    // Scoped assignment filter
    const assignmentFilter = isAdmin ? {} : { assignedBy: managerId };

    // For managers: resolve their assignment IDs first so progress counts are scoped
    let assignmentIds = null;
    if (!isAdmin) {
        const myAssignments = await ModuleAssignment.find(assignmentFilter).select("_id");
        assignmentIds = myAssignments.map((a) => a._id);
    }

    const progressFilter = (extra) =>
        isAdmin ? extra : { ...extra, assignment: { $in: assignmentIds } };

    const [
        totalModules,
        publishedModules,
        totalAssignments,
        completedAssignments,
        passedAssignments,
        failedAssignments,
    ] = await Promise.all([
        TrainingModule.countDocuments(),
        TrainingModule.countDocuments({ status: "published" }),
        ModuleAssignment.countDocuments(assignmentFilter),
        ModuleAssignment.countDocuments({ ...assignmentFilter, status: "completed" }),
        TrainingLearnerProgress.countDocuments(progressFilter({ isPassed: true, completedAt: { $ne: null } })),
        TrainingLearnerProgress.countDocuments(progressFilter({ isPassed: false, completedAt: { $ne: null } })),
    ]);

    const completionRate =
        totalAssignments > 0
            ? Math.round((completedAssignments / totalAssignments) * 100)
            : 0;

    const passRate =
        completedAssignments > 0
            ? Math.round((passedAssignments / completedAssignments) * 100)
            : 0;

    const avgScoreAgg = await TrainingLearnerProgress.aggregate([
        { $match: progressFilter({ completedAt: { $ne: null } }) },
        { $group: { _id: null, avg: { $avg: "$score" } } },
    ]);
    const avgScore = avgScoreAgg[0]?.avg
        ? Number(avgScoreAgg[0].avg.toFixed(1))
        : 0;

    res.status(200).json({
        success: true,
        data: {
            totalModules,
            publishedModules,
            totalAssignments,
            completedAssignments,
            passedAssignments,
            failedAssignments,
            inProgressAssignments: totalAssignments - completedAssignments,
            completionRate,
            passRate,
            avgScore,
        },
    });
});

// ─── GET /reports/modules ─────────────────────────────────────────────────────
// @desc  Per-module analytics: assignment count, pass rate, avg score
// @route GET /api/v1/reports/modules
exports.getModuleReport = asyncHandler(async (req, res, next) => {
    const modules = await TrainingModule.find({ status: "published" })
        .select("title uid stats")
        .lean();

    const enriched = modules.map((m) => {
        const completed = (m.stats.passedCount || 0) + (m.stats.failedCount || 0);
        const passRate =
            completed > 0
                ? Math.round(((m.stats.passedCount || 0) / completed) * 100)
                : 0;

        return {
            _id: m._id,
            title: m.title,
            uid: m.uid,
            assignedCount: m.stats.assignedCount || 0,
            startedCount: m.stats.startedCount || 0,
            passedCount: m.stats.passedCount || 0,
            failedCount: m.stats.failedCount || 0,
            avgScore: m.stats.avgScore || 0,
            completionRate:
                m.stats.assignedCount > 0
                    ? Math.round(
                        ((m.stats.passedCount || 0) / m.stats.assignedCount) * 100
                    )
                    : 0,
            passRate,
        };
    });

    res.status(200).json({ success: true, count: enriched.length, data: enriched });
});

// ─── GET /reports/learners ────────────────────────────────────────────────────
// @desc  Per-learner progress table (with optional moduleId filter)
// @route GET /api/v1/reports/learners?moduleId=&status=
exports.getLearnerReport = asyncHandler(async (req, res, next) => {
    const { moduleId, status } = req.query;
    const filter = {};

    if (moduleId) filter.module = moduleId;
    if (status === "passed") filter.isPassed = true;
    if (status === "failed")
        Object.assign(filter, { isPassed: false, completedAt: { $ne: null } });
    if (status === "in-progress")
        Object.assign(filter, {
            completedAt: null,
            "attempts.0": { $exists: true },
        });
    if (status === "not-started")
        Object.assign(filter, { attempts: { $size: 0 } });

    // Managers only see learners in their assignments
    if (req.user.role?.toLowerCase() === "manager") {
        const myAssignments = await ModuleAssignment.find({
            assignedBy: req.user._id,
        }).select("learner module");

        filter.$or = myAssignments.map((a) => ({
            learner: a.learner,
            module: a.module,
        }));

        if (filter.$or.length === 0) {
            return res.status(200).json({ success: true, count: 0, data: [] });
        }
    }

    const records = await TrainingLearnerProgress.find(filter)
        .populate("learner", "name email")
        .populate("module", "title uid")
        .lean();

    const data = records.map((r) => ({
        _id: r._id,
        learner: r.learner,
        module: r.module,
        score: r.score,
        isPassed: r.isPassed,
        attemptRound: r.attemptRound,
        completedAt: r.completedAt,
        passedAt: r.passedAt,
        startedAt: r.startedAt,
        status: r.isPassed
            ? "passed"
            : r.completedAt
                ? "failed"
                : r.attempts?.length > 0
                    ? "in-progress"
                    : "not-started",
        correctAnswers: r.attempts?.filter((a) => a.isCorrect).length || 0,
        totalAnswered: r.attempts?.length || 0,
    }));

    res.status(200).json({ success: true, count: data.length, data });
});

// ─── GET /reports/module/:moduleId ───────────────────────────────────────────
// @desc  Full breakdown for a single module: part analytics + per-question difficulty
// @route GET /api/v1/reports/module/:moduleId
exports.getSingleModuleReport = asyncHandler(async (req, res, next) => {
    const { moduleId } = req.params;

    const mod = await TrainingModule.findById(moduleId);
    if (!mod) return next(new ErrorResponse("Module not found", 404));

    // All progress for this module
    const progressDocs = await TrainingLearnerProgress.find({ module: moduleId })
        .populate("learner", "name email")
        .lean();

    const totalLearners = progressDocs.length;
    const completed = progressDocs.filter((p) => p.completedAt).length;
    const passed = progressDocs.filter((p) => p.isPassed).length;
    const avgScore =
        completed > 0
            ? Number(
                (
                    progressDocs
                        .filter((p) => p.completedAt)
                        .reduce((sum, p) => sum + p.score, 0) / completed
                ).toFixed(1)
            )
            : 0;

    // Per-question stats — aggregate correct/wrong ratios
    const allAttempts = progressDocs.flatMap((p) => p.attempts || []);
    const questionStats = {};

    for (const attempt of allAttempts) {
        const qId = String(attempt.question);
        if (!questionStats[qId]) {
            questionStats[qId] = { total: 0, correct: 0 };
        }
        questionStats[qId].total += 1;
        if (attempt.isCorrect) questionStats[qId].correct += 1;
    }

    const questionBreakdown = Object.entries(questionStats).map(([qId, s]) => ({
        questionId: qId,
        totalAttempts: s.total,
        correctCount: s.correct,
        incorrectCount: s.total - s.correct,
        correctRate:
            s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0,
    }));

    // Sort by most difficult (lowest correct rate)
    questionBreakdown.sort((a, b) => a.correctRate - b.correctRate);

    res.status(200).json({
        success: true,
        data: {
            module: { _id: mod._id, title: mod.title, uid: mod.uid },
            summary: {
                totalLearners,
                completed,
                passed,
                failed: completed - passed,
                inProgress: totalLearners - completed,
                avgScore,
                passRate:
                    completed > 0 ? Math.round((passed / completed) * 100) : 0,
            },
            learners: progressDocs.map((p) => ({
                learner: p.learner,
                score: p.score,
                isPassed: p.isPassed,
                completedAt: p.completedAt,
                attemptRound: p.attemptRound,
                status: p.isPassed
                    ? "passed"
                    : p.completedAt
                        ? "failed"
                        : p.attempts?.length > 0
                            ? "in-progress"
                            : "not-started",
            })),
            questionBreakdown,
        },
    });
});