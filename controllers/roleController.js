const asyncHandler = require("../middleware/async");
const Role = require("../models/Role");
const ErrorResponse = require("../utils/errorResponse");

exports.filterRoleSection = (s, requestBody) => {
  return s.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all role
// @route   /api/v1/role
// @access   Public
exports.getRoles = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Role']
  #swagger.summary = 'Get all Rolle reports'
  #swagger.responses[200] = { description: 'Success' }
*/
  res.status(200).json(res.advancedResults);
});

// @desc   create a single role
// @route   /api/v1/role
// @access   Public
exports.createRole = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Role']
  #swagger.summary = 'Create Role'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { 
  
    "name":"Admin",
    "permissions":["USER.ADD", "USER.EDIT", "USER.DELETE", "USER.GET"]

  } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  console.log(req.body);
  const role = await Role.create(req.body);

  res.status(201).json({
    succeed: true,
    data: role,
    // id: role._id,
  });
});

// @desc   fetch single role
// @route   /api/v1/role/:id
// @access   Public
exports.getRole = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Role']
  #swagger.summary = 'Get Role By Id'

  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const role = await Role.findById(req.params.id).populate(["products"]);

  if (!role) {
    return next(
      new ErrorResponse(`Role not found with id of ${req.params.id}`, 404)
    );
  }
  res.status(200).json({
    success: true,
    data: role,
  });
});

// @desc   update single role
// @route   /api/v1/role/:id
// @access   Public
exports.updateRole = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Role']
  #swagger.summary = 'Update By Id'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { 
  
    "name":"Admin",
    "permissions":["USER.ADD", "USER.EDIT", "USER.DELETE", "USER.GET"]

  } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  ///Name Checked in Role
  const duplicateItem = await Role.findOne({
    name: req.body.name,
  });

  const role = await Role.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  ///Duplicate Check while updating
  if (duplicateItem && duplicateItem.id !== req.params.id) {
    return next(
      new ErrorResponse(
        `The name ( ${duplicateItem.name}) used another Role`,
        409
      )
    );
  }

  if (!role) {
    return next(
      new ErrorResponse(`Role not found with id of ${req.params.id}`, 404)
    );
  }
  res.status(200).json({
    success: true,
    data: role,
  });
});
// @desc   Delete single role
// @route   /api/v1/roles/:id
// @access   Public
exports.deleteRole = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Role']
  #swagger.summary = 'Delete by ID'
 
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // const role = await role.findByIdAndDelete(req.params.id);
  const role = await Role.findById(req.params.id);
  if (!role) {
    return next(
      new ErrorResponse(`Role not found with id of ${req.params.id}`, 404)
    );
  }

  role.deleteOne();

  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});
