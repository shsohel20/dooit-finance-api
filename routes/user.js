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
} = require("../controllers/userController");

const User = require("../models/User");

const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

router.use(protect);
router.use(authorize("admin"));

router
  .route("/")
  .post(advancedResults(User, null, filterUserSection), getUsers)
  .get(advancedResults(User), getUsers);

router.route("/new").post(createUser);
router.route("/update-user-password/:id").put(updateUserPassword);

router.route("/:id").get(getUser).put(updateUser).delete(deleteUser);
router.route("/slug/:slug").get(getUserBySlug);

module.exports = router;
