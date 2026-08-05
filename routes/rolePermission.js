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
  getAllPermission,
} = require("../controllers/rolePermissionController");

const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "10kb" }));

router.use(protect);
router.use(authorizePermission("ROLE.GET", "ROLE.ADD", "ROLE.EDIT", "ROLE.DELETE"));

// POST   /api/v1/role-permissions             → create
// GET    /api/v1/role-permissions             → list  (?isActive=true&role=<roleId>)
router
  .route("/")
  .post(authorizePermission("ROLE.ADD"), createRolePermission)
  .get(authorizePermission("ROLE.GET"), getRolePermissions);

// GET    /api/v1/role-permissions/:roleId     → single by roleId
// PUT    /api/v1/role-permissions/:roleId     → update by roleId
// DELETE /api/v1/role-permissions/:roleId     → delete by roleId
router
  .route("/:roleId")
  .get(authorizePermission("ROLE.GET"), getRolePermission)
  .put(authorizePermission("ROLE.EDIT"), updateRolePermission)
  .delete(authorizePermission("ROLE.DELETE"), deleteRolePermission);

// PATCH  /api/v1/role-permissions/:roleId/permissions/add     → add permission strings
// PATCH  /api/v1/role-permissions/:roleId/permissions/remove  → remove permission strings
router
  .route("/:roleId/permissions/add")
  .patch(authorizePermission("ROLE.EDIT"), addPermissions);
router
  .route("/:roleId/permissions/remove")
  .patch(authorizePermission("ROLE.EDIT"), removePermissions);

// PATCH  /api/v1/role-permissions/:roleId/restrict    → add restricted users
// PATCH  /api/v1/role-permissions/:roleId/unrestrict  → remove restricted users
router
  .route("/:roleId/restrict")
  .patch(authorizePermission("ROLE.EDIT"), addRestrictedUsers);
router
  .route("/:roleId/unrestrict")
  .patch(authorizePermission("ROLE.EDIT"), removeRestrictedUsers);

//GET All Permissions for Modules

router
  .route("/permissions/all").get(authorizePermission("ROLE.GET"), getAllPermission)

module.exports = router;
