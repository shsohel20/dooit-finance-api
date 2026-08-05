const express = require("express");
const {
  getUsers,
  createUser,
  getUser,
  updateUser,
  deleteUser,
  filterUserSection,
  updateUserPassword,
  getUserBySlug,
  getUsersPost,
  resetPassword,
  getUsersByRole,
  getMemberships,
  addMembership,
  updateMembership,
  deleteMembership,
  scopeUserListByTenant,
} = require("../controllers/userController");

const User = require("../models/User");

const advancedResults = require("../middleware/advancedResults");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

router.use(protect);
router.use(authorizePermission("USER.GET", "USER.ADD", "USER.EDIT", "USER.DELETE"));

// User is identity-only — clientBelongs/branchBelongs no longer exist on it.
// Pass skipClientFilter so advancedResults doesn't inject those stale filters.
router
  .route("/")
  .post(scopeUserListByTenant, advancedResults(User, null, filterUserSection, { skipClientFilter: true }), getUsersPost)
  .get(scopeUserListByTenant, advancedResults(User, null, null, { skipClientFilter: true }), getUsers);

router.route("/new").post(authorizePermission("USER.ADD"), createUser);
router.route("/role/:role").get(authorizePermission("USER.GET"), getUsersByRole);
router
  .route("/update-user-password/:id")
  .put(authorizePermission("USER.EDIT"), updateUserPassword);
router.route("/reset-password/:id").put(authorizePermission("USER.EDIT"), resetPassword);

// Membership management — must come before /:id to avoid route shadowing
router
  .route("/:id/memberships")
  .get(authorizePermission("USER.GET"), getMemberships)
  .post(authorizePermission("USER.EDIT"), addMembership);
router
  .route("/:id/memberships/:userTypeId")
  .put(authorizePermission("USER.EDIT"), updateMembership)
  .delete(authorizePermission("USER.EDIT"), deleteMembership);

router
  .route("/:id")
  .get(authorizePermission("USER.GET"), getUser)
  .put(authorizePermission("USER.EDIT"), updateUser)
  .delete(authorizePermission("USER.DELETE"), deleteUser);
router.route("/slug/:slug").get(authorizePermission("USER.GET"), getUserBySlug);

module.exports = router;
