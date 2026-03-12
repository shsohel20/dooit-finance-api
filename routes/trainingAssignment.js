const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth");

const {
    assignModule,
    getMyAssignments,
    getAssignedByMe,
    getAssignment,
    deleteAssignment,
    getAllAssignments,
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

router.get("/by-me", authorize("admin", "manager"), getAssignedByMe);
router.get("/", authorize("admin", "manager"), getAllAssignments);

router.post("/:moduleId/assign", authorize("admin", "manager"), assignModule);

router
    .route("/:id")
    .get(getAssignment)
    .delete(authorize("admin", "manager"), deleteAssignment);

router.patch(
    "/:id/status",
    authorize("admin", "manager"),
    updateAssignmentStatus
);

module.exports = router; 