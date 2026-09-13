// routes/workflow.js
//
// See models/Workflow.js for what a Workflow is (a definition, not a run).
// Mirrors the shape of routes/ruleEngine.js.

const express = require("express");
const {
  getWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  publishWorkflow,
  approveWorkflow,
  archiveWorkflow,
  toggleWorkflowVisibility,
  getWorkflowVersions,
  getWorkflowVersion,
  getWorkflowCatalog,
} = require("../controllers/workflowController");

const workflowResults = require("../middleware/workflowResults");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
// A 31-node graph is larger than a rule, hence 512kb rather than the
// rule engine's 100kb.
router.use(express.json({ limit: "512kb" }));

// Protect all routes
router.use(protect);

// authorizePermission passes when the user holds ANY of the listed perms, so
// each verb gets its own guard — holding WORKFLOW.GET alone must not
// authorize create, edit, or delete.
const canRead = authorizePermission(
  "WORKFLOW.GET",
  "WORKFLOW.ADD",
  "WORKFLOW.EDIT",
  "WORKFLOW.DELETE",
);
const canCreate = authorizePermission("WORKFLOW.ADD");
const canEdit = authorizePermission("WORKFLOW.EDIT");
const canDelete = authorizePermission("WORKFLOW.DELETE");
// Deliberately its own permission, held only by compliance officer — see
// seeds/syncRolePermissions.js. Maker (WORKFLOW.EDIT via publish) and
// checker (WORKFLOW.APPROVE) must never come from the same default grant.
const canApprove = authorizePermission("WORKFLOW.APPROVE");

// List workflows
router.route("/").get(canRead, workflowResults, getWorkflows);

// Create workflow
router.route("/new").post(canCreate, createWorkflow);

// Static paths before /:id, or "meta" is read as an id.
router.route("/meta/catalog").get(canRead, getWorkflowCatalog);

// CRUD by id
router
  .route("/:id")
  .get(canRead, getWorkflow)
  .put(canEdit, updateWorkflow)
  .delete(canDelete, deleteWorkflow);

router.route("/:id/duplicate").post(canCreate, duplicateWorkflow);
router.route("/:id/publish").post(canEdit, publishWorkflow);
router.route("/:id/approve").post(canApprove, approveWorkflow);
router.route("/:id/archive").post(canEdit, archiveWorkflow);
router.route("/:id/visibility").patch(canEdit, toggleWorkflowVisibility);

router.route("/:id/versions").get(canRead, getWorkflowVersions);
router.route("/:id/versions/:version").get(canRead, getWorkflowVersion);

module.exports = router;
