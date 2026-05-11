const asyncHandler = require("../middleware/async");
const User = require("../models/User");
const Customer = require("../models/Customer");
const bcrypt = require("bcryptjs");
const Otp = require("../models/Otp");
const ErrorResponse = require("../utils/errorResponse");
const sendEmail = require("../utils/sendEmail");
const crypto = require("crypto");
const { hashForSearch, decrypt } = require("../utils/encryption");
const mongoose = require("mongoose");

// Fetches the raw email from MongoDB, bypassing all Mongoose hooks.
// post("init") mutates user.email to "***" before any controller code runs,
// so we must go to the raw collection to get the encrypted value and decrypt it.
const getRawEmail = async (userId) => {
  const raw = await mongoose.connection.db
    .collection("users")
    .findOne({ _id: userId }, { projection: { email: 1, isDataEncrypted: 1 } });
  if (!raw) return null;
  if (raw.isDataEncrypted) return decrypt(raw.email);
  return raw.email;
};

const sendTokenResponse = (user, statusCode, res) => {
  const token = user.getSignedJwtToken();

  let options = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRE * 24 * 60 * 60 * 1000
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
      email: await getRawEmail(user._id),
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
      email: await getRawEmail(user._id),
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
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Customer register'
  #swagger.description = 'Create a new customer user'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/AuthRegisterBody' } }
  #swagger.responses[200] = { description: 'Registered + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[400] = { description: 'Validation error', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/
  const { name, email, password, role, userName } = req.body;
  let clientUrl;
  if (req.body.clientUrl) {
    clientUrl = req.body.clientUrl;
  } else {
    clientUrl = req.header("Referer");
  }
  const exitingUser = await User.findOne({ emailHash: hashForSearch(email) });
  if (exitingUser) {
    return next(new ErrorResponse("The e-mail address used previous!", 400));
  }

  //Create a new user
  // const user = await User.create({
  //   name,
  //   email,
  //   password,
  //   role,
  //   userName,
  //   // resetPasswordToken,
  //   // resetPasswordExpire,
  // }).populate([
  //   {
  //     path: "client", // virtual on User
  //     // select: "name _id",
  //   },
  //   {
  //     path: "customer", // virtual on User
  //     // select: "name _id",
  //   },
  //   {
  //     path: "branch", // virtual on User
  //     // select: "name _id",
  //     populate: { path: "client" },
  //   },
  // ])
  //   .lean()

  const newUser = await User.create({
    name,
    email,
    password,
    role,
    userName,
  });

  const user = await User.findById(newUser._id)
    .populate([
      { path: "client" },
      { path: "customer" },
      {
        path: "branch",
        populate: { path: "client" },
      },
    ])


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
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Login user'
  #swagger.description = 'Authenticate user and return a JWT token'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/AuthLoginBody' } }
  #swagger.responses[200] = { description: 'User logged in', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[400] = { description: 'Invalid credentials', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/
  const { email, password } = req.body;

  if (!email || !password) {
    return next(
      new ErrorResponse("Please provide a valid email and password.", 400)
    );
  }

  const populateOptions = [
    { path: "client" },
    { path: "customer" },
    { path: "branch", populate: { path: "client" } },
  ];

  // Primary lookup — works for all users once emailHash is set
  let user = await User.findOne({ emailHash: hashForSearch(email) })
    .select("+password +emailHash")
    .populate(populateOptions);

  // Fallback for existing users who pre-date emailHash (lazy migration).
  // Only works when data is not encrypted — fine for legacy plain-text users.
  if (!user) {
    user = await User.findOne({ email, isDataEncrypted: { $ne: true } })
      .select("+password +emailHash")
      .populate(populateOptions);

    // Backfill emailHash so this fallback is only needed once per user
    if (user) {
      await User.updateOne({ _id: user._id }, { emailHash: hashForSearch(email) });
    }
  }

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
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Get current user'
  #swagger.description = 'Returns currently authenticated user'
  #swagger.responses[200] = { description: 'Current user', schema: { success: true, data: {  } } }
  #swagger.responses[401] = { description: 'Unauthorized', schema: { $ref: '#/definitions/ErrorResponse' } }
*/
  const clientId = req.user.client?._id ?? null;
  const branchId = req.user.branch?._id ?? null;

  // Build scope conditions (same logic as privacyController.buildFilter)
  const userScope = [];
  const customerScope = [];
  if (clientId) {
    // userScope.push({ clientBelongs: clientId });
    customerScope.push({ "relations.client": clientId });
  }
  if (branchId) {
    userScope.push({ branchBelongs: branchId });
    customerScope.push({ "relations.branch": branchId });
  }

  const customerFilter = customerScope.length ? { $or: customerScope } : {};

  // Include users referenced in the customer table within scope
  const customerUserIds = await Customer.distinct("user", { ...customerFilter, user: { $ne: null } });
  if (customerUserIds.length) {
    userScope.push({ _id: { $in: customerUserIds } });
  }

  const userFilter = userScope.length ? { $or: userScope } : {};

  let encryptionStatus = false;
  let encryptionData = {}
  try {
    const [totalUsers, encryptedUsers, totalCustomers, encryptedCustomers] = await Promise.all([
      User.countDocuments(userFilter),
      User.countDocuments({ ...userFilter, isDataEncrypted: true }),
      Customer.countDocuments(customerFilter),
      Customer.countDocuments({ ...customerFilter, isDataEncrypted: true }),
    ]);

    const allEncrypted =
      totalUsers > 0 && encryptedUsers === totalUsers &&
      totalCustomers > 0 && encryptedCustomers === totalCustomers;

    encryptionStatus = allEncrypted;

    encryptionData = {
      totalUsers,
      encryptedUsers,
      totalCustomers,
      encryptedCustomers
    }
  } catch (err) {
    console.error("[getMe] encryptionStatus failed:", err.message);
  }

  res.status(200).json({
    success: true,
    encryptionData,
    encryptionStatus,
    data: req.user,

  });
});
exports.getMeCustomer = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Get current user (customer view)'
  #swagger.description = 'Returns user + linked customer record and metadata'
  #swagger.responses[200] = { description: 'User+customer data', schema: {
      success: true,
      data: {
        customer: {},
        email: 'shsohel20@gmail.com',
        phone: null,
        userExists: true,
        userId: '673d9as91sad81',
        linkedToCustomer: false,
        isInviteActive: false,
        user: {}
      }
  } }
  #swagger.responses[401] = { description: 'Unauthorized', schema: { $ref: '#/definitions/ErrorResponse' } }
*/
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
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Logout user (clear cookie)'
  #swagger.description = 'Clears cookie token'
  #swagger.responses[200] = { description: 'Logged out', schema: { $ref: '#/definitions/GenericSuccess' } }
*/
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
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Request password reset'
  #swagger.description = 'Sends a reset link to the email'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ForgotPasswordBody' } }
  #swagger.responses[200] = { description: 'Reset email sent', schema: { success: true, message: 'Email Send Successfully' } }
  #swagger.responses[404] = { description: 'Email not found', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/
  const user = await User.findOne({ emailHash: hashForSearch(req.body.email) });

  if (!user) {
    return next(new ErrorResponse("The email address is not valid", 404));
  }

  //get reset token
  const resetToken = user.getResetPasswordToken();

  await User.updateOne(
    { _id: user._id },
    { resetPasswordToken: user.resetPasswordToken, resetPasswordExpire: user.resetPasswordExpire }
  );
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
      email: await getRawEmail(user._id),
      subject: "Password reset token",
      message,
    });
    res.status(200).json({
      success: true,
      message: "Email Send Successfully",
    });
  } catch (error) {
    await User.updateOne(
      { _id: user._id },
      { resetPasswordToken: undefined, resetPasswordExpire: undefined }
    );

    return next(new ErrorResponse("Email could not be sent", 500));
  }
});

// @desc   get me
// @route   /api/v1/auth/reset-password/:resettoken
// @access   Private
exports.resetPassword = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Reset password'
  #swagger.description = 'Reset user password using reset token'
  #swagger.parameters['resettoken'] = { in: 'path', required: true, type: 'string', description: 'Reset token' }
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ResetPasswordBody' } }
  #swagger.responses[200] = { description: 'Password reset + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[401] = { description: 'Invalid or expired token', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // usually public (token in URL)
*/

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

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(req.body.password, salt);

  await User.updateOne(
    { _id: user._id },
    { password: hashedPassword, resetPasswordToken: undefined, resetPasswordExpire: undefined }
  );
  sendTokenResponse(user, 200, res);
});

// @desc   update user detail by user
// @route   /api/v1/auth/update-me
// @access   Private
exports.updateMe = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Update user profile'
  #swagger.description = 'Update name/email/photo'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UpdateMeBody' } }
  #swagger.responses[200] = { description: 'Profile updated + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[401] = { description: 'Unauthorized', schema: { $ref: '#/definitions/ErrorResponse' } }
*/

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
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Update password'
  #swagger.description = 'Change password by providing current and new password'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UpdatePasswordBody' } }
  #swagger.responses[200] = { description: 'Password updated + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[401] = { description: 'Current password mismatch', schema: { $ref: '#/definitions/ErrorResponse' } }
*/

  const user = await User.findById(req.user.id).select("+password");

  //Check current password
  if (!(await user.mathPassword(req.body.currentPassword))) {
    return next(new ErrorResponse("Current Password not match.", 401));
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(req.body.newPassword, salt);

  await User.updateOne({ _id: user._id }, { password: hashedPassword });
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
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Confirm user (email token)'
  #swagger.description = 'Activate user account using token'
  #swagger.parameters['resettoken'] = { in: 'path', required: true, type: 'string', description: 'Confirmation token' }
  #swagger.responses[200] = { description: 'User activated + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[401] = { description: 'Invalid token', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public via URL token
*/

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

  await User.updateOne(
    { _id: user._id },
    { isActive: true, resetPasswordToken: undefined, resetPasswordExpire: undefined }
  );
  sendTokenResponse(user, 200, res);
});

// @desc   get me
// @route   /api/v1/auth/confirm-user/:resettoken
// @access   Private
exports.confirmUserByOtp = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Confirm user by OTP'
  #swagger.description = 'Activate user account by OTP code'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ConfirmOtpBody' } }
  #swagger.responses[200] = { description: 'User activated + token', schema: { $ref: '#/definitions/AuthSuccessResponse' } }
  #swagger.responses[400] = { description: 'OTP expired or invalid', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/

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

      await User.updateOne({ _id: user._id }, { isActive: true });

      userActivated = true;
      sendTokenResponse(user, 200, res);
      break;
    }
  }

  if (!userActivated) {
    return next(new ErrorResponse("Invalid Code.", 401));
  }
});

// new helper: create & send OTP (hash before storing)
const createAndSendOtp = async (user, res, next) => {
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Resend OTP'
  #swagger.description = 'Create & send a new OTP to user'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ResendOtpBody' } }
  #swagger.responses[200] = { description: 'OTP sent', schema: { success: true, message: 'OTP Sent' } }
  #swagger.responses[429] = { description: 'Too many requests', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/

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
  /*
  #swagger.tags = ['Auth']
  #swagger.summary = 'Resend OTP'
  #swagger.description = 'Create & send a new OTP to user'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/ResendOtpBody' } }
  #swagger.responses[200] = { description: 'OTP sent', schema: { success: true, message: 'OTP Sent' } }
  #swagger.responses[429] = { description: 'Too many requests', schema: { $ref: '#/definitions/ErrorResponse' } }
  #swagger.security = [] // public
*/

  // Accept email in body (or whichever identifier you prefer)
  const { email } = req.body;
  if (!email) {
    return next(new ErrorResponse("Please provide an email.", 400));
  }

  const user = await User.findOne({ emailHash: hashForSearch(email) });
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
      new ErrorResponse("Please wait a bit before requesting a new OTP.", 429)
    );
  }

  // If there's a still-valid OTP (not expired), you can either:
  // - refuse to create a new one (encourage using existing), or
  // - create a new OTP and delete old ones.
  // Here we just create a fresh one (we already deleted old ones inside helper).
  await createAndSendOtp(user, res, next);
});
