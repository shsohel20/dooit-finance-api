const asyncHandler = require("../middleware/async");
const User = require("../models/User");
const ErrorResponse = require("../utils/errorResponse");

exports.filterUserSection = (s, requestBody) => {
  return s.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all user
// @route   /api/v1/user
// @access   Public
exports.getUsers = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// @desc   create a single user
// @route   /api/v1/user
// @access   Public
exports.createUser = asyncHandler(async (req, res, next) => {
  const { email } = req.body;
  const user = await User.create(req.body);

  res.status(201).json({
    succeed: true,
    data: user,
    id: user._id,
  });
});

// @desc   fetch single user
// @route   /api/v1/user/:id
// @access   Public
exports.getUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404),
    );
  }
  res.status(200).json({
    success: true,
    data: user,
  });
});

// @desc   fetch single user
// @route   /api/v1/user/:slug
// @access   Private
exports.getUserBySlug = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({ slug: req.params.slug });
  console.log(req.params.slug);
  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404),
    );
  }
  res.status(200).json({
    success: true,
    data: user,
  });
});

// @desc   update single user
// @route   /api/v1/user/:id
// @access   Public
exports.updateUser = asyncHandler(async (req, res, next) => {
  ///Name Checked in User
  const duplicateItem = await User.findById(req.params.id);

  const user = await User.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  ///Duplicate Check while updating
  if (duplicateItem && duplicateItem.id !== req.params.id) {
    return next(
      new ErrorResponse(
        `The name ( ${duplicateItem.name}) used another User`,
        409,
      ),
    );
  }

  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404),
    );
  }
  res.status(200).json({
    success: true,
    data: user,
  });
});
// @desc   Delete single user
// @route   /api/v1/user/:id
// @access   Public
exports.deleteUser = asyncHandler(async (req, res, next) => {
  // const user = await user.findByIdAndDelete(req.params.id);
  const user = await User.findById(req.params.id);
  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404),
    );
  }

  user.deleteOne();

  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});

exports.updateUserPassword = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id).select("+password");

  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404),
    );
  }

  user.password = req.body.password;

  await user.save();
  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});
