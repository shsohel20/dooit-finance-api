// controllers/alertController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Alert = require("../models/Alert");
const Customer = require("../models/Customer");
const User = require("../models/User");
const Transaction = require("../models/Transaction");

/**
 * Basic filter helper for alert searching by uid or caseType
 */
exports.filterAlertSection = (doc, requestBody, req) => {
  if (!doc.uid || !requestBody.uid) return false;
  return doc.uid.toLowerCase().includes(requestBody.uid.toLowerCase().trim());
};

// @desc   Get all alerts
// @route  GET /api/v1/alerts
// @access Public
exports.getAlerts = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Alert']
  #swagger.summary = 'Get All Alerts'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  res.status(200).json(res.advancedResults);
});

// @desc   Get all alerts via POST
// @route  POST /api/v1/alerts/search
// @access Public
exports.getAlertsPost = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Search Alerts'
  */
  res.status(200).json(res.advancedResults);
});

// @desc   Create single alert
// @route  POST /api/v1/alerts
// @access Public
exports.createAlert = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Create Alert'
    #swagger.security = [{ "BearerAuth": [] }]
  */
  const {
    customerId,
    analystId,
    transactionId,
    caseType,
    riskScore,
    riskLabel,
    activity = [],
    activityNote = [],
    settings,
    metadata,
    status,
  } = req.body;

  // validate references
  const customer = customerId ? await Customer.findById(customerId) : null;
  const transaction = transactionId
    ? await Transaction.findById(transactionId)
    : null;

  if (customerId && !customer)
    return next(
      new ErrorResponse(`Customer not found with id ${customerId}`, 404)
    );

  if (transactionId && !transaction)
    return next(
      new ErrorResponse(`Transaction not found with id ${transactionId}`, 404)
    );

  const alert = await Alert.create({
    customer: customer?._id,
    analyst: null,
    transaction: transaction?._id,
    caseType,
    riskScore,
    riskLabel,
    activity,
    activityNote,
    settings,
    metadata,
    status,
  });

  res.status(201).json({
    succeed: true,
    data: alert,
    id: alert._id,
  });
});

// @desc   Create dummy alert
// @route  POST /api/v1/alerts/dummy
// @access Public
exports.createDummyAlert = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Alert']
    #swagger.summary = 'Create Dummy Alert'
  */
  const {
    customerName,
    analystName,
    transactionId,
    caseType,
    status = "Pending",
    riskScore = Math.floor(Math.random() * 100),
    riskLabel = "Medium",
    activity = [],
    activityNote = [],
  } = req.body;

  const user = await User.findOne({ name: customerName });

  const customer = customerName
    ? await Customer.findOne({ user: user?._id })
    : null;

  const transaction = transactionId
    ? await Transaction.findOne({ uid: transactionId })
    : null;

  const analyst = analystName
    ? await User.findOne({ name: analystName })
    : null;

  if (!customer) return next(new ErrorResponse("Customer not found", 404));
  if (!transaction)
    return next(new ErrorResponse("Transaction not found", 404));

  const alert = await Alert.create({
    customer: customer._id,
    transaction: transaction._id,
    analyst: analyst._id,
    caseType: caseType || "Default",
    riskScore,
    riskLabel,
    activity,
    activityNote,
    status,
  });

  res.status(201).json({
    succeed: true,
    data: alert,
    id: alert._id,
  });
});

// @desc   Get single alert by id
// @route  GET /api/v1/alerts/:id
// @access Public
exports.getAlert = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findById(req.params.id)
    .populate("customer")
    .populate("analyst")
    .populate("transaction");

  if (!alert)
    return next(
      new ErrorResponse(`Alert not found with id ${req.params.id}`, 404)
    );

  res.status(200).json({
    succeed: true,
    data: alert,
  });
});

// @desc   Update single alert
// @route  PUT /api/v1/alerts/:id
// @access Public
exports.updateAlert = asyncHandler(async (req, res, next) => {
  const alertId = req.params.id;
  let alert = await Alert.findById(alertId);

  if (!alert)
    return next(new ErrorResponse(`Alert not found with id ${alertId}`, 404));

  // update fields
  const updated = await Alert.findByIdAndUpdate(alertId, req.body, {
    new: true,
    runValidators: true,
  });

  res.status(200).json({
    succeed: true,
    data: updated,
  });
});

// @desc   Delete single alert
// @route  DELETE /api/v1/alerts/:id
// @access Public
exports.deleteAlert = asyncHandler(async (req, res, next) => {
  const alert = await Alert.findById(req.params.id);
  if (!alert)
    return next(
      new ErrorResponse(`Alert not found with id ${req.params.id}`, 404)
    );

  await alert.deleteOne();

  res.status(200).json({
    succeed: true,
    data: req.params.id,
  });
});

// @desc   Assign an analyst to an alert
// @route  PUT /api/v1/alerts/:id/assign-analyst
// @access Private (Admin)
exports.assignAnalyst = asyncHandler(async (req, res, next) => {
  /*
      #swagger.tags = ['Alert']
      #swagger.summary = 'Assign Analyst to Alert'
      #swagger.parameters['body'] = { 
        in: 'body', 
        required: true, 
        schema: { analystId: "analystIdHere" } 
      }
    */

  const alertId = req.params.id;
  const { analystId } = req.body;

  if (!analystId) {
    return next(new ErrorResponse("analystId is required", 400));
  }
  console.log(analystId);
  const alert = await Alert.findById(alertId);
  if (!alert)
    return next(new ErrorResponse(`Alert not found with id ${alertId}`, 404));

  const analyst = await User.findById(analystId);
  if (!analyst)
    return next(
      new ErrorResponse(`Analyst not found with id ${analystId}`, 404)
    );

  alert.analyst = analyst._id;
  await alert.save();

  res.status(200).json({
    succeed: true,
    message: `Analyst ${analyst.name} assigned to alert ${alert.uid}`,
    data: alert,
  });
});
