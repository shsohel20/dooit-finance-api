const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const {
  getIssues, getIssueSummary, getIssue,
  createIssue, updateIssue, deleteIssue,
  getTasks, createTask, updateTask, deleteTask,
} = require("../controllers/issueRegisterController");

router.use(express.json({ limit: "100kb" }));
router.use(protect);

// Summary (must be before /:id)
router.get("/summary", getIssueSummary);

// Issue CRUD
router.route("/").get(getIssues).post(createIssue);
router.route("/:id").get(getIssue).put(updateIssue).delete(deleteIssue);

// Remediation tasks (nested)
router.route("/:id/tasks").get(getTasks).post(createTask);
router.route("/:id/tasks/:taskId").put(updateTask).delete(deleteTask);

module.exports = router;
