const express = require('express');

const { sendOtp } = require('../controllers/otpController');

const router = express.Router();
const { protect } = require('../middleware/auth');

router.route('/').get(protect, sendOtp);

module.exports = router;
