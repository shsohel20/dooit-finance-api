const asyncHandler = require("../middleware/async");
const User = require("../models/User");
const Customer = require("../models/Customer");
const bcrypt = require("bcryptjs");
const Otp = require("../models/Otp");
const ErrorResponse = require("../utils/errorResponse");
const sendEmail = require("../utils/sendEmail");
const crypto = require("crypto");

const sendTokenResponse = (user, statusCode, res) => {
  const token = user.getSignedJwtToken();

  let options = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRE * 24 * 60 * 60 * 1000,
    ),
    httpOnly: true,
    secure: true,
    path: "/",
    sameSite: "None",
    // domain: 'http://localhost:3000',
  };

  res.status(statusCode).cookie("token", token, options).json({
    success: true,
    expires: options.expires,
    token,
  });
};
const emailSend = async (user, resetToken, clientUrl, res, next) => {
  const resetUrl = `${clientUrl}confirm-user/${resetToken}`;

  const message = `You are receiving this email because you has requested the reset
  of a password, Please make a PUT request to: \n\n ${resetUrl}`;

  try {
    await sendEmail({
      email: user.email,
      subject: "Confirmation Token token",
      message,
    });
    res.status(200).json({
      success: true,
      message: "Email Send Successfully",
    });
  } catch (error) {
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    return next(new ErrorResponse("Email could not be sent", 500));
  }
};

const optSend = async (user, message, subject, res, next) => {
  try {
    await sendEmail({
      email: user.email,
      subject,
      message,
    });
    res.status(200).json({
      success: true,
      message: "Email Send Successfully",
    });
  } catch (error) {
    return next(new ErrorResponse("Email could not be sent", 500));
  }
};

// @desc   Create a user
// @route   /api/v1/auth/register
// @access   Public

exports.register = asyncHandler(async (req, res, next) => {
  const { name, email, password, role, userName } = req.body;
  let clientUrl;
  if (req.body.clientUrl) {
    clientUrl = req.body.clientUrl;
  } else {
    clientUrl = req.header("Referer");
  }
  const exitingUser = await User.findOne({ email });
  if (exitingUser) {
    return next(new ErrorResponse("The e-mail address used previous!", 400));
  }

  //Create a new user
  const user = await User.create({
    name,
    email,
    password,
    role,
    userName,
    // resetPasswordToken,
    // resetPasswordExpire,
  });

  const code = Math.floor(100000 + Math.random() * 900000);

  const otp = await Otp.create({
    code,
    user: user._id,
  });

  if (!otp) {
    return next(new ErrorResponse(`Otp Created Failed`), 404);
  }
  const subject = "Confirmation Token";
  const message = `You need to confirm your account through the <strong>OTP</strong>, \n\n ${code}`;
  sendTokenResponse(user, 200, res);
  optSend(user, message, subject, res, next);

  ///Generate Token
  // const resetToken = crypto.randomBytes(20).toString("hex");

  ///Hash Token and set resetPasswordToken field
  // const resetPasswordToken = crypto
  //   .createHash("sha256")
  //   .update(resetToken)
  //   .digest("hex");

  ///Set Expires
  // resetPasswordExpire = Date.now() + 10 * 60 * 1000;

  // emailSend(user, code, clientUrl, res, next);

  // const resetUrl = `${req.body.clientUrl}/auth/reset-password/${resetToken}`;

  // const message = `You are receiving this email because you has requested the reset
  // of a password, Please make a PUT request to: \n\n ${resetUrl}`;

  // try {
  //   await sendEmail({
  //     email: user.email,
  //     subject: 'Confirmation Token token',
  //     message,
  //   });
  //   res.status(200).json({
  //     success: true,
  //     message: 'Email Send Successfully',
  //   });
  // } catch (error) {
  //   user.resetPasswordToken = undefined;
  //   user.resetPasswordExpire = undefined;

  //   return next(new ErrorResponse('Email could not be sent', 500));
  // }

  // sendTokenResponse(user, 200, res);
});
// @desc   Create a user
// @route   /api/v1/auth/login
// @access   Public

exports.login = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(
      new ErrorResponse("Please provide a valid email and password.", 400),
    );
  }

  //Check User
  const user = await User.findOne({ email }).select("+password");

  if (!user) {
    return next(new ErrorResponse("Invalid Credential.", 401));
  }
  // if (!user.isActive) {
  //   return next(new ErrorResponse("You are not confirmed user", 401));
  // }

  //Check password
  const isMath = await user.mathPassword(password);

  if (!isMath) {
    return next(new ErrorResponse("Invalid Credential.", 401));
  }
  sendTokenResponse(user, 200, res);
});

// @desc   get me
// @route   /api/v1/auth/me
// @access   Private
exports.getMe = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id);

  res.status(200).json({
    success: true,
    data: user,
  });
});
exports.getMeCustomer = asyncHandler(async (req, res, next) => {
  // req.user must exist (protect middleware)
  const userId = req.user && req.user.id ? req.user.id : null;
  if (!userId) return next(new ErrorResponse("Authentication required", 401));

  // load user (exclude password)
  const user = await User.findById(userId).select("-password").lean();
  if (!user) return next(new ErrorResponse("User not found", 404));

  // try: 1) customer linked to this user, 2) fallback: customer by email/phone
  let customer = await Customer.findOne({ user: user._id })
    .populate("relations.client relations.branch")
    .lean();

  let linkedToCustomer = false;
  let email = user.email ?? null;
  let phone = user.phone ?? null;
  const userExists = true; // since we found the user above

  if (customer) {
    linkedToCustomer = true;
    // prefer contact info from customer metadata/personalKyc if present
    email = customer.metadata?.email;

    phone = customer.metadata?.phone;
  } else {
    // attempt to find a customer by email/phone if not directly linked
    const or = [];
    if (email) {
      or.push({ "metadata.email": email });
      or.push({ "personalKyc.personal_form.contact_details.email": email });
    }
    if (phone) {
      or.push({ "metadata.phone": phone });
      or.push({ "personalKyc.personal_form.contact_details.phone": phone });
    }

    if (or.length) {
      customer = await Customer.findOne({ $or: or })
        // .populate("relations.client relations.branch")
        .lean();

      if (customer) {
        // if customer.user matches this user, it's effectively linked
        linkedToCustomer =
          !!customer.user && customer.user.toString() === user._id.toString();

        email =
          customer.metadata?.email ??
          customer.personalKyc?.personal_form?.contact_details?.email ??
          email;
        phone =
          customer.metadata?.phone ??
          customer.personalKyc?.personal_form?.contact_details?.phone ??
          phone;
      }
    }
  }

  // compute invite active flag (if a customer exists)
  const isInviteActive = !!(
    customer &&
    customer.inviteToken &&
    customer.inviteTokenExpire &&
    new Date(customer.inviteTokenExpire).getTime() > Date.now()
  );
  let latestCustomer = null;
  if (customer) {
    latestCustomer = {
      id: customer?._id,
      personalKyc: customer?.personalKyc ?? null,
      country: customer?.country,
      kycStatus: customer?.kycStatus,
      kycNotes: customer?.kycNotes,
      metadata: customer?.metadata,
      consentToScreen: customer?.consentToScreen,
      declaration: customer?.declaration,
      authorized: customer?.authorized,
      documents: customer?.documents,
    };
  }

  return res.status(200).json({
    success: true,
    data: {
      customer: latestCustomer,
      // relations: customer ? customer.relations : [], // optional if you want
      email,
      phone,
      userExists,
      userId: user._id,
      linkedToCustomer,
      isInviteActive,
      user,
    },
  });
});

// @desc   logout an clear the cookie
// @route   /api/v1/auth/logout
// @access   Private
exports.logout = asyncHandler(async (req, res, next) => {
  res.cookie("token", "none", {
    expires: new Date(Date.now() + 0),
    httpOnly: true,
  });

  res.status(200).json({
    success: true,
    data: {},
  });
});
// @desc   get me
// @route   /api/v1/auth/forgot-password
// @access   public
exports.forgotPassword = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({ email: req.body.email });

  if (!user) {
    return next(new ErrorResponse("The email address is not valid", 404));
  }

  //get reset token
  const resetToken = user.getResetPasswordToken();

  await user.save({ validateBeforeSave: false });
  ///Create URL
  // const resetUrl = `http://localhost:3000/auth/reset-password/${resetToken}`;

  // const resetUrl = `${req.protocol}://${req.get(
  //   'host'
  // )}/auth/reset-password/${resetToken}`;

  const resetUrl = `${req.body.clientUrl}/auth/reset-password/${resetToken}`;

  const message = `You are receiving this email because you has requested the reset
  of a password, Please make a PUT request to: \n\n ${resetUrl}`;

  try {
    await sendEmail({
      email: user.email,
      subject: "Password reset token",
      message,
    });
    res.status(200).json({
      success: true,
      message: "Email Send Successfully",
    });
  } catch (error) {
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;

    await user.save({ validateBeforeSave: false });

    return next(new ErrorResponse("Email could not be sent", 500));
  }
});

// @desc   get me
// @route   /api/v1/auth/reset-password/:resettoken
// @access   Private
exports.resetPassword = asyncHandler(async (req, res, next) => {
  //Get Hashed token
  const resetPasswordToken = crypto
    .createHash("sha256")
    .update(req.params.resettoken)
    .digest("hex");

  const user = await User.findOne({
    resetPasswordToken,
    resetPasswordExpire: { $gt: Date.now() },
  });

  if (!user) {
    return next(new ErrorResponse("Invalid Token.", 401));
  }

  //Set New Password
  user.password = req.body.password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  await user.save();
  sendTokenResponse(user, 200, res);
});

// @desc   update user detail by user
// @route   /api/v1/auth/update-me
// @access   Private
exports.updateMe = asyncHandler(async (req, res, next) => {
  const updateField = {
    name: req.body.name,
    email: req.body.email,
    photoUrl: req.body.photoUrl,
  };

  const user = await User.findByIdAndUpdate(req.user.id, updateField, {
    new: true,
    runValidators: true,
  });

  sendTokenResponse(user, 200, res);
});
// @desc   update user Password by user
// @route   /api/v1/auth/update-password
// @access   Private
exports.updatePassword = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id).select("+password");

  //Check current password
  if (!(await user.mathPassword(req.body.currentPassword))) {
    return next(new ErrorResponse("Current Password not match.", 401));
  }

  user.password = req.body.newPassword;

  await user.save();
  sendTokenResponse(user, 200, res);
});

// @desc   Create a user
// @route   /api/v1/auth/register
// @access   Public

exports.customerRegister = asyncHandler(async (req, res, next) => {
  const { name, email, password } = req.body;

  //Create a new user
  const user = await User.create({
    name,
    email,
    password,
    role: "customer",
  });

  sendTokenResponse(user, 200, res);
});

// @desc   get me
// @route   /api/v1/auth/confirm-user/:resettoken
// @access   Private
exports.confirmUser = asyncHandler(async (req, res, next) => {
  //Get Hashed token
  const resetPasswordToken = crypto
    .createHash("sha256")
    .update(req.params.resettoken)
    .digest("hex");

  const user = await User.findOne({
    resetPasswordToken,
    resetPasswordExpire: { $gt: Date.now() },
  });

  if (!user) {
    return next(new ErrorResponse("Invalid Token.", 401));
  }

  //Set New Password
  user.isActive = true;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  await user.save();
  sendTokenResponse(user, 200, res);
});

// @desc   get me
// @route   /api/v1/auth/confirm-user/:resettoken
// @access   Private
exports.confirmUserByOtp = asyncHandler(async (req, res, next) => {
  const otp = await Otp.find({
    expire: { $gt: Date.now() },
  });

  if (!otp || otp.length === 0) {
    return next(new ErrorResponse("The OTP is Expired!.", 400));
  }

  let userActivated = false;

  for (let index = 0; index < otp.length; index++) {
    const element = otp[index];
    const isMatch = await bcrypt.compare(req.body.code, element.code);

    if (isMatch) {
      const user = await User.findById(element.user);
      if (!user) {
        return next(new ErrorResponse("Invalid Token.", 401));
      }
      // active user
      user.isActive = true;

      await user.save();
      userActivated = true;
      sendTokenResponse(user, 200, res);
      break; // Break out of the loop once the user is activated
    }
  }

  if (!userActivated) {
    return next(new ErrorResponse("Invalid Code.", 401));
  }
});

// new helper: create & send OTP (hash before storing)
const createAndSendOtp = async (user, res, next) => {
  // Delete any old OTPs for the user first (cleanup)
  await Otp.deleteMany({ user: user._id });

  // generate 6-digit numeric code (string)
  const code = Math.floor(100000 + Math.random() * 900000);

  // hash the code before saving (confirmUserByOtp uses bcrypt.compare)

  const otpExpireMs = 10 * 60 * 1000; // 10 minutes
  const otpDoc = await Otp.create({
    code: code,
    user: user._id,
    expire: Date.now() + otpExpireMs,
  });

  if (!otpDoc) {
    return next(new ErrorResponse("Otp Creation Failed", 500));
  }

  const subject = "Confirmation Token";
  const message = `You need to confirm your account through the <strong>OTP</strong>: \n\n ${code}`;

  // use your existing optSend which sends the HTTP response
  return optSend(user, message, subject, res, next);
};
// New endpoint: resend OTP
// @route  POST /api/v1/auth/resend-otp
// @access Public (or require auth if you prefer)
exports.resendOtp = asyncHandler(async (req, res, next) => {
  // Accept email in body (or whichever identifier you prefer)
  const { email } = req.body;
  if (!email) {
    return next(new ErrorResponse("Please provide an email.", 400));
  }

  const user = await User.findOne({ email });
  if (!user) {
    return next(new ErrorResponse("No user found with that email.", 404));
  }

  if (user.isActive) {
    return next(new ErrorResponse("User already confirmed.", 400));
  }

  // Rate limit: check latest OTP for this user
  const latest = await Otp.findOne({ user: user._id }).sort({ createdAt: -1 });

  // If there's a recent OTP created < 60s ago, block
  const resendThrottleMs = 60 * 1000; // 60 seconds
  if (
    latest &&
    latest.createdAt &&
    Date.now() - latest.createdAt.getTime() < resendThrottleMs
  ) {
    return next(
      new ErrorResponse("Please wait a bit before requesting a new OTP.", 429),
    );
  }

  // If there's a still-valid OTP (not expired), you can either:
  // - refuse to create a new one (encourage using existing), or
  // - create a new OTP and delete old ones.
  // Here we just create a fresh one (we already deleted old ones inside helper).
  await createAndSendOtp(user, res, next);
});
