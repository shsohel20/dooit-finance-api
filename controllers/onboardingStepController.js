// controllers/onboardingStepController.js
const asyncHandler = require("../middleware/async");
const OnboardingStep = require("../models/OnboardingStep");
const ErrorResponse = require("../utils/errorResponse");
const { validateOnboardingStep } = require("../utils");

// Resolve { client } or { branch } filter from:
//   1. explicit param (admin override via query or body)
//   2. logged-in user's session (client/branch user)
const resolveEntityFilter = (req, next, source = "query") => {
  const params = source === "query" ? req.query : req.body;
  const { client: paramClient, branch: paramBranch } = params;

  if (paramClient) return { client: paramClient };
  if (paramBranch) return { branch: paramBranch };

  // Derive from JWT session
  const clientId = req.user?.client?._id ?? req.user?.client ?? null;
  const branchId = req.user?.branch?._id ?? req.user?.branch ?? null;

  if (clientId) return { client: clientId };
  if (branchId) return { branch: branchId };

  next(
    new ErrorResponse(
      "Cannot determine client or branch. Pass as query/body param or log in as a client/branch user.",
      400
    )
  );
  return null;
};

// @desc   Get onboarding record by client or branch
// @route  GET /api/v1/onboarding-step?client=:id  |  ?branch=:id
// @access Protected
exports.getOnboarding = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Onboarding Step']
    #swagger.summary = 'Get onboarding record (client or branch)'
    #swagger.responses[200] = { description: 'Success' }
    #swagger.responses[404] = { description: 'Not Found' }
  */
  const filter = resolveEntityFilter(req, next, "query");
  if (!filter) return;

  const record = await OnboardingStep.findOne(filter)
    .populate("client", "name email")
    .populate("branch", "name branchCode")
    .populate("steps.completedBy", "name email");

  if (!record)
    return next(new ErrorResponse("No onboarding record found.", 404));

  res.status(200).json({ success: true, data: record });
});

// @desc   Initialize an onboarding record (creates if not exists)
// @route  POST /api/v1/onboarding-step/init
// @access Protected
exports.initOnboarding = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Onboarding Step']
    #swagger.summary = 'Initialize onboarding record'
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { client: '', branch: '', steps: [] } }
    #swagger.responses[201] = { description: 'Created' }
    #swagger.responses[200] = { description: 'Already exists' }
  */
  const { steps } = req.body;

  const filter = resolveEntityFilter(req, next, "body");
  if (!filter) return;

  const existing = await OnboardingStep.findOne(filter);
  if (existing)
    return res.status(200).json({
      success: true,
      data: existing,
      message: "Onboarding already initialized.",
    });

  const record = await OnboardingStep.create({
    ...filter,
    steps: steps || [],
  });

  res.status(201).json({ success: true, data: record });
});

// @desc   Upsert a step — updates existing by order, or pushes new
// @route  PUT /api/v1/onboarding-step/step
// @access Protected
exports.upsertStep = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Onboarding Step']
    #swagger.summary = 'Add or update a step by order number'
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { client: '', branch: '', step: '', order: 1, status: 'pending' } }
    #swagger.responses[200] = { description: 'Success' }
  */
  const isValid = validateOnboardingStep(req.body, next);
  if (!isValid) return;

  const filter = resolveEntityFilter(req, next, "body");
  if (!filter) return;

  const {
    step,
    order,
    status,
    required,
    completedAt,
    completedBy,
    notes,
    data,
    dueDate,
  } = req.body;

  const stepData = {
    step,
    order,
    status: status || "pending",
    ...(required !== undefined && { required }),
    ...(completedAt && { completedAt }),
    ...(completedBy && { completedBy }),
    ...(notes && { notes }),
    ...(data && { data }),
    ...(dueDate && { dueDate }),
  };

  // Try update existing step at this order
  let record = await OnboardingStep.findOneAndUpdate(
    { ...filter, "steps.order": order },
    { $set: { "steps.$[el]": stepData } },
    {
      arrayFilters: [{ "el.order": order }],
      new: true,
      runValidators: true,
    }
  );

  // No step at this order yet — push it (upsert the document too)
  if (!record) {
    record = await OnboardingStep.findOneAndUpdate(
      filter,
      { $push: { steps: stepData } },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );
  }

  res.status(200).json({ success: true, data: record });
});

// @desc   Update only the status of a specific step
// @route  PATCH /api/v1/onboarding-step/step-status
// @access Protected
exports.updateStepStatus = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Onboarding Step']
    #swagger.summary = 'Update step status by order'
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { client: '', branch: '', order: 1, status: 'completed' } }
    #swagger.responses[200] = { description: 'Success' }
    #swagger.responses[404] = { description: 'Step not found' }
  */
  const { order, status } = req.body;

  if (order === undefined || order === null)
    return next(new ErrorResponse("Step order is required.", 400));
  if (!status)
    return next(new ErrorResponse("Status is required.", 400));

  const filter = resolveEntityFilter(req, next, "body");
  if (!filter) return;

  const setFields = { "steps.$[el].status": status };
  if (status === "completed") {
    setFields["steps.$[el].completedAt"] = new Date();
    if (req.user) setFields["steps.$[el].completedBy"] = req.user.id;
  }

  const record = await OnboardingStep.findOneAndUpdate(
    { ...filter, "steps.order": order },
    { $set: setFields },
    {
      arrayFilters: [{ "el.order": order }],
      new: true,
      runValidators: true,
    }
  );

  if (!record)
    return next(
      new ErrorResponse(`No step found at order ${order}.`, 404)
    );

  res.status(200).json({ success: true, data: record });
});

// @desc   Remove a step by order number
// @route  DELETE /api/v1/onboarding-step/step?client=:id&order=:n  |  ?branch=:id&order=:n
// @access Protected
exports.removeStep = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Onboarding Step']
    #swagger.summary = 'Remove a step by order number'
    #swagger.responses[200] = { description: 'Success' }
    #swagger.responses[404] = { description: 'Not Found' }
  */
  const { order } = req.query;

  if (!order)
    return next(new ErrorResponse("Query param order is required.", 400));

  const filter = resolveEntityFilter(req, next, "query");
  if (!filter) return;

  const record = await OnboardingStep.findOneAndUpdate(
    filter,
    { $pull: { steps: { order: Number(order) } } },
    { new: true }
  );

  if (!record)
    return next(new ErrorResponse("No onboarding record found.", 404));

  res.status(200).json({ success: true, data: record });
});

// @desc   Delete entire onboarding record
// @route  DELETE /api/v1/onboarding-step/:id
// @access Protected
exports.deleteOnboarding = asyncHandler(async (req, res, next) => {
  /*
    #swagger.tags = ['Onboarding Step']
    #swagger.summary = 'Delete onboarding record'
    #swagger.responses[200] = { description: 'Deleted' }
    #swagger.responses[404] = { description: 'Not Found' }
  */
  const record = await OnboardingStep.findById(req.params.id);
  if (!record)
    return next(
      new ErrorResponse(
        `Onboarding record not found with id ${req.params.id}`,
        404
      )
    );

  await record.deleteOne();

  res.status(200).json({ success: true, data: {} });
});
