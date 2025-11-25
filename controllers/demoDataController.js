// controllers/demoDataController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const DemoData = require("../models/DemoData");

/**
 * Basic filter helper for client-side searching by name
 * (used similarly to filterUserSection)
 */
exports.filterDemoDataSection = (doc, requestBody, req) => {
  if (!doc.name || !requestBody.name) return false;
  return doc.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all demoDataes
// @route  GET /api/v1/demoDataes
// @access Public
exports.getDemoDataes = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Demo']
  #swagger.summary = 'Get Demo Data'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});

// @desc   Get single demoData by id
// @route  GET /api/v1/demoDataes/:id
// @access Public
exports.getDemoData = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Demo']
  #swagger.summary = 'Get by ID'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const demoData = await DemoData.findById(req.params.id);

  if (!demoData) {
    return next(
      new ErrorResponse(`DemoData not found with id of ${req.params.id}`, 404)
    );
  }

  res.status(200).json({
    success: true,
    data: demoData,
  });
});

exports.createDemo = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Demo']
  #swagger.summary = 'Demo Data Insert'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: {  } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const demo = await DemoData.create(req.body);

  res.status(201).json({
    succeed: true,
    data: demo,
    id: demo._id,
  });
});
