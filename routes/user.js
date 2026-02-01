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
} = require("../controllers/userController");

const User = require("../models/User");

const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

router.use(protect);
router.use(authorize("admin"));

router
  .route("/")
  .post(advancedResults(User, null, filterUserSection), getUsersPost)
  .get(advancedResults(User), getUsers);

router.route("/new").post(createUser);
router.route("/update-user-password/:id").put(updateUserPassword);
router.route("/reset-password/:id").put(resetPassword);

router.route("/:id").get(getUser).put(updateUser).delete(deleteUser);
router.route("/slug/:slug").get(getUserBySlug);

module.exports = router;
