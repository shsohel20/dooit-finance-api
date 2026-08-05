const express = require("express");
const router  = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");
const {
  getIssues, getIssueSummary, getIssue,
  createIssue, updateIssue, deleteIssue,
  getTasks, createTask, updateTask, deleteTask,
} = require("../controllers/issueRegisterController");

router.use(express.json({ limit: "100kb" }));
router.use(protect);
// Router-level floor: any GRC grant gets in; each route below narrows by verb.
router.use(authorizePermission("GRC.GET", "GRC.ADD", "GRC.EDIT", "GRC.DELETE"));

// Summary (must be before /:id)
router.get("/summary", authorizePermission("GRC.GET"), getIssueSummary);

// Issue CRUD
router
  .route("/")
  .get(authorizePermission("GRC.GET"), getIssues)
  .post(authorizePermission("GRC.ADD"), createIssue);
router
  .route("/:id")
  .get(authorizePermission("GRC.GET"), getIssue)
  .put(authorizePermission("GRC.EDIT"), updateIssue)
  .delete(authorizePermission("GRC.DELETE"), deleteIssue);

// Remediation tasks (nested)
router
  .route("/:id/tasks")
  .get(authorizePermission("GRC.GET"), getTasks)
  .post(authorizePermission("GRC.ADD"), createTask);
router
  .route("/:id/tasks/:taskId")
  .put(authorizePermission("GRC.EDIT"), updateTask)
  .delete(authorizePermission("GRC.DELETE"), deleteTask);

module.exports = router;
