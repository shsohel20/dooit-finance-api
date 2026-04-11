const express = require("express");
const {
  createRolePermission,
  getRolePermissions,
  getRolePermission,
  updateRolePermission,
  deleteRolePermission,
  addPermissions,
  removePermissions,
  addRestrictedUsers,
  removeRestrictedUsers,
} = require("../controllers/rolePermissionController");

const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "10kb" }));

router.use(protect);
router.use(authorize("admin"));

// POST   /api/v1/role-permissions             → create
// GET    /api/v1/role-permissions             → list  (?isActive=true&role=<roleId>)
router.route("/").post(createRolePermission).get(getRolePermissions);

// GET    /api/v1/role-permissions/:roleId     → single by roleId
// PUT    /api/v1/role-permissions/:roleId     → update by roleId
// DELETE /api/v1/role-permissions/:roleId     → delete by roleId
router
  .route("/:roleId")
  .get(getRolePermission)
  .put(updateRolePermission)
  .delete(deleteRolePermission);

// PATCH  /api/v1/role-permissions/:roleId/permissions/add     → add permission strings
// PATCH  /api/v1/role-permissions/:roleId/permissions/remove  → remove permission strings
router.route("/:roleId/permissions/add").patch(addPermissions);
router.route("/:roleId/permissions/remove").patch(removePermissions);

// PATCH  /api/v1/role-permissions/:roleId/restrict    → add restricted users
// PATCH  /api/v1/role-permissions/:roleId/unrestrict  → remove restricted users
router.route("/:roleId/restrict").patch(addRestrictedUsers);
router.route("/:roleId/unrestrict").patch(removeRestrictedUsers);

module.exports = router;
