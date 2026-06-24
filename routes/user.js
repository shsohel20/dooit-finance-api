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
} = require("../controllers/userController");

const User = require("../models/User");

const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

router.use(protect);
router.use(authorize("admin"));

// User is identity-only — clientBelongs/branchBelongs no longer exist on it.
// Pass skipClientFilter so advancedResults doesn't inject those stale filters.
router
  .route("/")
  .post(advancedResults(User, null, filterUserSection, { skipClientFilter: true }), getUsersPost)
  .get(advancedResults(User, null, null, { skipClientFilter: true }), getUsers);

router.route("/new").post(createUser);
router.route("/role/:role").get(getUsersByRole);
router.route("/update-user-password/:id").put(updateUserPassword);
router.route("/reset-password/:id").put(resetPassword);

// Membership management — must come before /:id to avoid route shadowing
router.route("/:id/memberships").get(getMemberships).post(addMembership);
router
  .route("/:id/memberships/:userTypeId")
  .put(updateMembership)
  .delete(deleteMembership);

router.route("/:id").get(getUser).put(updateUser).delete(deleteUser);
router.route("/slug/:slug").get(getUserBySlug);

module.exports = router;
