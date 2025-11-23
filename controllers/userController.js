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
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get all users'
  #swagger.description = 'Retrieve paginated / filtered users. Uses advancedResults middleware output.'
 
  #swagger.parameters['page'] = { in: 'query', type: 'integer', description: 'Page number (optional)' }
  #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Items per page (optional)' }
  #swagger.responses[200] = {
    description: 'Users list (from advancedResults middleware)',
    schema: {
      success: true,
      count: 10,
      pagination: {},
      data: [ { $ref: '#/definitions/UserResponse' } ]
    }
  }
*/
  res.status(200).json(res.advancedResults);
});
exports.getUsersPost = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get all users'
  #swagger.description = 'Retrieve paginated / filtered users. Uses advancedResults middleware output.'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { } }
 
  #swagger.parameters['page'] = { in: 'query', type: 'integer', description: 'Page number (optional)' }
  #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Items per page (optional)' }
  #swagger.responses[200] = {
    description: 'Users list (from advancedResults middleware)',
    schema: {
      success: true,
      count: 10,
      pagination: {},
      data: [ { $ref: '#/definitions/UserResponse' } ]
    }
  }
*/
  res.status(200).json(res.advancedResults);
});

// @desc   create a single user
// @route   /api/v1/user
// @access   Public
exports.createUser = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Create a new user'
  #swagger.description = 'Create a single user record'
  #swagger.security = [] // public (change if you want auth)
  #swagger.parameters['body'] = {
    in: 'body',
    required: true,
    schema: { $ref: '#/definitions/UserCreateBody' }
  }
  #swagger.responses[201] = {
    description: 'User created',
    schema: {
      succeed: true,
      data: { $ref: '#/definitions/UserResponse' },
      id: "64f1a8b2a1f2c3d4e5f6a7b8"
    }
  }
  #swagger.responses[400] = { description: 'Validation error' }
*/

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
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get user by ID'
  #swagger.description = 'Fetch a single user by MongoDB _id'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'User ID' }
  #swagger.security = [] // public
  #swagger.responses[200] = { description: 'User found', schema: { $ref: '#/definitions/UserResponse' } }
  #swagger.responses[404] = { description: 'User not found' }
*/
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404)
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
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Get user by slug'
  #swagger.description = 'Fetch a single user by slug'
  #swagger.parameters['slug'] = { in: 'path', required: true, type: 'string', description: 'User slug' }
  #swagger.security = [{ "BearerAuth": [] }]
  #swagger.responses[200] = { description: 'User found', schema: { $ref: '#/definitions/UserResponse' } }
  #swagger.responses[401] = { description: 'Unauthorized' }
  #swagger.responses[404] = { description: 'User not found' }
*/

  const user = await User.findOne({ slug: req.params.slug });
  console.log(req.params.slug);
  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404)
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
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Update user'
  #swagger.description = 'Update a user by ID (runValidators applied)'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'User ID' }
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UserUpdateBody' } }
  #swagger.responses[200] = { description: 'Updated user', schema: { $ref: '#/definitions/UserResponse' } }
  #swagger.responses[404] = { description: 'User not found' }
  #swagger.responses[409] = { description: 'Conflict - duplicate name' }
*/

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
        409
      )
    );
  }

  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404)
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
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Delete user'
  #swagger.description = 'Delete a user by ID'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'User ID' }
  #swagger.responses[200] = {
    description: 'User deleted',
    schema: { success: true, data: '64f1a8b2a1f2c3d4e5f6a7b8' }
  }
  #swagger.responses[404] = { description: 'User not found' }
*/

  // const user = await user.findByIdAndDelete(req.params.id);
  const user = await User.findById(req.params.id);
  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404)
    );
  }

  user.deleteOne();

  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});

exports.updateUserPassword = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['User']
  #swagger.summary = 'Update user password'
  #swagger.description = 'Change a user password by admin or authorized caller'
  #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'User ID' }
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/UpdatePasswordBody' } }
  #swagger.responses[200] = { description: 'Password updated', schema: { success: true, data: '64f1a8b2a1f2c3d4e5f6a7b8' } }
  #swagger.responses[404] = { description: 'User not found' }
*/

  const user = await User.findById(req.params.id).select("+password");

  if (!user) {
    return next(
      new ErrorResponse(`User not found with id of ${req.params.id}`, 404)
    );
  }

  user.password = req.body.password;

  await user.save();
  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});
