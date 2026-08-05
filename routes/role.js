const express = require("express");
const {
  getRoles,
  getRole,
  updateRole,
  deleteRole,
  filterRoleSection,
  createRole,
} = require("../controllers/roleController");

const Role = require("../models/Role");

const advancedResults = require("../middleware/advancedResults");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

// This router had no auth at all — an unauthenticated caller could list, create
// and delete the Role documents the whole permission system is keyed on.
router.use(protect);

router
  .route("/")
  .post(
    authorizePermission("ROLE.GET"),
    advancedResults(Role, [], filterRoleSection),
    getRoles,
  )
  .get(authorizePermission("ROLE.GET"), advancedResults(Role), getRoles);

router.route("/new").post(authorizePermission("ROLE.ADD"), createRole);

router
  .route("/:id")
  .get(authorizePermission("ROLE.GET"), getRole)
  .put(authorizePermission("ROLE.EDIT"), updateRole)
  .delete(authorizePermission("ROLE.DELETE"), deleteRole);

module.exports = router;
