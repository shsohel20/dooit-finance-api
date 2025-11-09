// controllers/branchController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Branch = require("../models/Branch");
const {
  validateBranchUpdate,
  validateBranchCreation,
  generateRandomPassword,
} = require("../utils");
const User = require("../models/User");
const Client = require("../models/Client");

/**
 * Basic filter helper for client-side searching by name
 * (used similarly to filterUserSection)
 */
exports.filterBranchSection = (s, requestBody) => {
  if (!s.name || !requestBody.name) return false;
  return s.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all branches
// @route  GET /api/v1/branches
// @access Public
exports.getBranches = asyncHandler(async (req, res, next) => {
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});

// @desc   Create single branch
// @route  POST /api/v1/branches
// @access Public
exports.createBranch = asyncHandler(async (req, res, next) => {
  // validate payload (includes User uniqueness checks when userName/email present)
  const ok = await validateBranchCreation(req, next);
  if (!ok) return;
  const loggedInUser = req.user ?? null;
  const client = await Client.findOne({ user: loggedInUser?.id });
  const {
    name,
    branchCode,
    email,
    phone,
    slug,
    manager,
    services,
    address,
    documents,
    settings,
    metadata,
    // user-related props (optional)
    userName,

    autoCreateUserForBranch = false, // optional flag
  } = req.body;

  // Decide whether to create a user:
  // - explicit userName or userEmail provided
  // - or a flag autoCreateUserForBranch true AND an email exists (branch email)
  const shouldCreateUser = Boolean(
    userName || (autoCreateUserForBranch && email)
  );

  let createdUser = null;
  let initialPassword = null;

  if (shouldCreateUser) {
    const userName1 =
      userName || (email ? email.split("@")[0] : `${branchCode}`);

    console.log(userName1);
    createdUser = await User.findOne({
      email,
      userName: userName1,
    });

    if (!createdUser) {
      // build user payload
      // initialPassword = generateRandomPassword(10);
      initialPassword = "123456";
      const uPayload = {
        name: name,
        email: email.toLowerCase(),
        userName: userName1,
        phone,
        password: initialPassword, // assume User model handles hashing in pre-save
        // role: "branch", // role for branch login
        userType: "branch", // custom field if you use it
        role: "admin", // custom field if you use it
        isActive: true,
      };

      // create user
      createdUser = await User.create(uPayload);
    }
  }

  if (!createdUser) {
    return next(new ErrorResponse("Failed to create branch user account", 500));
  }

  // create branch object; include reference to createdUser if available
  const branchPayload = {
    client,
    name,
    branchCode,
    email: email && email.toLowerCase(),
    phone,
    slug,
    manager,
    services,
    address,
    documents,
    settings,
    metadata,
  };

  if (createdUser) branchPayload.user = createdUser._id;

  const branch = await Branch.create(branchPayload);

  // Optionally: set branch reference on user (if you want reverse link)
  if (createdUser) {
    createdUser.branch = branch._id; // requires User schema to have branch field (optional)
    await createdUser.save();
  }

  res.status(201).json({
    succeed: true,
    data: branch,
    id: branch._id,
    ...(createdUser
      ? {
          branchUser: {
            id: createdUser._id,
            userName: createdUser.userName,
            email: createdUser.email,
            password: initialPassword,
          },
        }
      : {}),
  });
});

// @desc   Get single branch by id
// @route  GET /api/v1/branches/:id
// @access Public
exports.getBranch = asyncHandler(async (req, res, next) => {
  const branch = await Branch.findById(req.params.id).populate("client");

  if (!branch) {
    return next(
      new ErrorResponse(`Branch not found with id of ${req.params.id}`, 404)
    );
  }

  res.status(200).json({
    success: true,
    data: branch,
  });
});

// @desc   Get single branch by slug
// @route  GET /api/v1/branches/slug/:slug
// @access Public (or Private based on your route)
exports.getBranchBySlug = asyncHandler(async (req, res, next) => {
  const branch = await Branch.findOne({ slug: req.params.slug }).populate(
    "client"
  );

  if (!branch) {
    return next(
      new ErrorResponse(`Branch not found with slug of ${req.params.slug}`, 404)
    );
  }

  res.status(200).json({
    success: true,
    data: branch,
  });
});

// @desc   Update single branch
// @route  PUT /api/v1/branches/:id
// @access Public
exports.updateBranch = asyncHandler(async (req, res, next) => {
  const branchId = req.params.id;
  const branch = await Branch.findById(branchId);
  if (!branch)
    return next(
      new ErrorResponse(`Branch not found with id of ${branchId}`, 404)
    );

  // validate update payload
  const ok = await validateBranchUpdate(branchId, req.body, next);
  if (!ok) return;

  // if user fields present, update linked user
  const { userName, userEmail } = req.body;
  if (userName || userEmail) {
    // ensure branch has linked user; if not, create one
    let linkedUser = null;
    if (branch.user) {
      linkedUser = await User.findById(branch.user);
      if (linkedUser) {
        if (userName) linkedUser.userName = userName;
        if (userEmail) linkedUser.email = userEmail.toLowerCase();
        await linkedUser.save();
      }
    } else {
      // create new user and attach
      const newPassword = generateRandomPassword(10);
      const newUser = await User.create({
        name: req.body.name || branch.name,
        email: (userEmail || branch.email || "").toLowerCase(),
        userName: userName || (userEmail || branch.email || "").split("@")[0],
        password: newPassword,
        role: "branch",
        userType: "branch",
        isActive: true,
      });
      branch.user = newUser._id;
      await branch.save();

      // return initial password in response (one-time)
      return res.status(200).json({
        success: true,
        data: branch,
        branchUser: {
          id: newUser._id,
          userName: newUser.userName,
          email: newUser.email,
          password: newPassword,
        },
      });
    }
  }

  // perform normal branch update
  const updated = await Branch.findByIdAndUpdate(branchId, req.body, {
    new: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    data: updated,
  });
});

// @desc   Delete single branch
// @route  DELETE /api/v1/branches/:id
// @access Public
exports.deleteBranch = asyncHandler(async (req, res, next) => {
  const branch = await Branch.findById(req.params.id);
  if (!branch) {
    return next(
      new ErrorResponse(`Branch not found with id of ${req.params.id}`, 404)
    );
  }

  await branch.deleteOne();

  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});
