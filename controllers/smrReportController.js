const asyncHandler = require("../middleware/async");

exports.getSmrReport = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Smr Reports']
  #swagger.summary = 'Get All Smr Reports'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // expected to be populated by advancedResults middleware
  res.status(200).json(res.advancedResults);
});
