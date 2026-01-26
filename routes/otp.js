const express = require("express");

const { sendOtp } = require("../controllers/otpController");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const { protect } = require("../middleware/auth");

router.route("/").get(protect, sendOtp);

module.exports = router;
