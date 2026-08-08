const asyncHandler = require("../middleware/async");
const Role = require("../models/Role");
const ErrorResponse = require("../utils/errorResponse");
const { logEvent } = require("../utils/audit");

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
  const role = await Role.create(req.body);

  logEvent({
    req,
    service: "auth",
    action: "role_created",
    target: String(role._id),
    details: `Role "${role.name}" created with ${role.permissions?.length ?? 0} permission(s)`,
    afterValue: { name: role.name, permissions: role.permissions ?? [] },
  });

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

  // Snapshot the pre-update doc so the audit event carries the permissions diff.
  const beforeRole = await Role.findById(req.params.id).lean();

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

  logEvent({
    req,
    service: "auth",
    action: "role_updated",
    target: String(role._id),
    details: `Role "${role.name}" updated`,
    beforeValue: beforeRole
      ? { name: beforeRole.name, permissions: beforeRole.permissions }
      : null,
    afterValue: { name: role.name, permissions: role.permissions },
  });

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

  // Snapshot before the delete — the doc stops existing after this point.
  const beforeValue = { name: role.name, permissions: role.permissions };

  await role.deleteOne();

  logEvent({
    req,
    service: "auth",
    action: "role_deleted",
    target: String(req.params.id),
    details: `Role "${beforeValue.name}" deleted`,
    beforeValue,
  });

  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});
