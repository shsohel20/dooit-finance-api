const asyncHandler = require("../middleware/async");
const Otp = require("../models/Otp");
const ErrorResponse = require("../utils/errorResponse");
const sendEmail = require("../utils/sendEmail");

exports.sendOtp = asyncHandler(async (req, res, next) => {
  const code = Math.floor(100000 + Math.random() * 900000);
  const userId = req?.user?.id ?? null;
  if (!userId) {
    return next(new ErrorResponse(`You are unauthorized!!!`), 404);
  }

  const otp = await Otp.create({
    code,
    user: userId,
  });

  if (!otp) {
    return next(new ErrorResponse(`Otp Created Failed`), 404);
  }

  try {
    await sendEmail({
      email: req.user.email,
      subject: "Your OTP",
      message: `Your One Time Password is </br> <h2 style={font-size:"50px"}>${code}</h2>`,
    });
    res.status(200).json({
      success: true,
      message: "OTP Send in your Email Successfully",
    });
  } catch (error) {
    console.log(error);
    return next(new ErrorResponse("Email could not be sent", 500));
  }
});
