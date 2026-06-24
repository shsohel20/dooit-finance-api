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
  resendOtp,
  getMeCustomer,
  switchContext,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.use(express.json({ limit: "100kb" }));

router.route("/re-send-opt").post(resendOtp);
router.route("/register").post(register);
router.route("/login").post(login);
router.route("/logout").get(logout);
router.route("/me").get(protect, getMe);
router.route("/me/customer").get(protect, getMeCustomer);
router.route("/forgot-password").post(forgotPassword);
router.route("/reset-password/:resettoken").put(resetPassword);
router.route("/confirm-user/:resettoken").put(confirmUser);
router.route("/confirm-user-by-otp").put(confirmUserByOtp);
router.route("/update-me").put(protect, updateMe);
router.route("/update-password").put(protect, updatePassword);

// Re-issue JWT for a different membership — no server-side state change.
router.route("/switch-context/:userTypeId").post(protect, switchContext);

module.exports = router;
