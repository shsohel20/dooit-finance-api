const express = require("express");
const router = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");

const {
    assignModule,
    getMyAssignments,
    getAssignedByMe,
    getAssignment,
    deleteAssignment,
    getAllAssignments,
    getAssignmentsByModule,
    updateAssignmentStatus,
} = require("../controllers/trainingAssignmentController");

router.use(express.json({ limit: "100kb" }));

router.use(protect);

// ── Learner ───────────────────────────────────────────────────────────────────
// GET /api/v1/assignments/mine        → all my assignments (learner)
router.get("/mine", getMyAssignments);

// ── Manager / Admin ───────────────────────────────────────────────────────────
// GET    /api/v1/assignments/by-me        → assignments I created
// GET    /api/v1/assignments              → all (admin) or mine (manager)
// POST   /api/v1/assignments/:moduleId/assign
// GET    /api/v1/assignments/:id
// DELETE /api/v1/assignments/:id
// PATCH  /api/v1/assignments/:id/status

router.get("/by-me", authorizePermission("TRAINING.ASSIGN"), getAssignedByMe);
router.get("/", authorizePermission("TRAINING.ASSIGN"), getAllAssignments);

// GET /api/v1/assignments/module/:moduleId → all assignments for a module
router.get(
    "/module/:moduleId",
    authorizePermission("TRAINING.ASSIGN"),
    getAssignmentsByModule
);

router.post("/:moduleId/assign", authorizePermission("TRAINING.ASSIGN"), assignModule);

router
    .route("/:id")
    .get(getAssignment)
    .delete(authorizePermission("TRAINING.ASSIGN"), deleteAssignment);

router.patch(
    "/:id/status",
    authorizePermission("TRAINING.ASSIGN"),
    updateAssignmentStatus
);

module.exports = router; 