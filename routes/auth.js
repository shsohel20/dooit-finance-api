const express = require("express");

const User = require("../models/User");

const {
  register,
  login,
  getMe,
  forgotPassword,
  resetPassword,
  updateMe,
  updatePassword,
  logout,
  confirmUser,
  confirmUserByOtp,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.route("/register").post(register);
router.route("/login").post(login);
router.route("/logout").get(logout);
router.route("/me").get(protect, getMe);
router.route("/forgot-password").post(forgotPassword);
router.route("/reset-password/:resettoken").put(resetPassword);
router.route("/confirm-user/:resettoken").put(confirmUser);
router.route("/confirm-user-by-otp").put(confirmUserByOtp);
router.route("/update-me").put(protect, updateMe);
router.route("/update-password").put(protect, updatePassword);

module.exports = router;
