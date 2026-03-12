const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const TrainingModule = require("../models/TrainingModule");
const TrainingModulePart = require("../models/TrainingModulePart");
const TrainingModuleQuestion = require("../models/TrainingModuleQuestion");
const ModuleAssignment = require("../models/ModuleAssignment");

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

//
// MODULE CRUD
//

// @desc Create module
// @route POST /api/v1/training-modules
exports.createModule = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id;
  const branch = req?.user?.branch?._id;

  const { title, description, manager, status } = req.body;

  if (!title) {
    return next(new ErrorResponse("title is required", 400));
  }

  const module = await TrainingModule.create({
    title,
    description,
    manager,
    status,
    client,
    branch,
    createdBy: req.user._id,
  });

  res.status(201).json({ success: true, data: module });
});

// @desc Get all modules
// @route GET /api/v1/training-modules
exports.getModules = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// @desc Get single module
// @route GET /api/v1/training-modules/:id
exports.getModule = asyncHandler(async (req, res, next) => {
  if (!isValidId(req.params.id))
    return next(new ErrorResponse("Invalid module id", 400));

  const mod = await TrainingModule.findById(req.params.id);

  if (!mod) return next(new ErrorResponse("Module not found", 404));

  res.status(200).json({ success: true, data: mod });
});

// @desc Update module
// @route PUT /api/v1/training-modules/:id
exports.updateModule = asyncHandler(async (req, res, next) => {
  const mod = await TrainingModule.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!mod) return next(new ErrorResponse("Module not found", 404));

  res.status(200).json({ success: true, data: mod });
});

// @desc Delete module
exports.deleteModule = asyncHandler(async (req, res, next) => {
  const mod = await TrainingModule.findById(req.params.id);

  if (!mod) return next(new ErrorResponse("Module not found", 404));

  await mod.deleteOne();

  res.status(200).json({ success: true });
});

//
// PARTS
//

// @desc Create part
// @route POST /api/v1/training-modules/:moduleId/parts
exports.createPart = asyncHandler(async (req, res, next) => {
  const { moduleId } = req.params;

  if (!isValidId(moduleId))
    return next(new ErrorResponse("Invalid module id", 400));

  const mod = await TrainingModule.findById(moduleId);
  if (!mod) return next(new ErrorResponse("Module not found", 404));

  const part = await TrainingModulePart.create({
    ...req.body,
    module: moduleId,
  });

  res.status(201).json({ success: true, data: part });
});

// @desc Get parts by module
exports.getPartsByModule = asyncHandler(async (req, res, next) => {
  const parts = await TrainingModulePart.find({
    module: req.params.moduleId,
  }).sort("order");

  res.status(200).json({ success: true, count: parts.length, data: parts });
});

// @desc Get single part
// @route GET /api/v1/training-modules/parts/:partId
exports.getPart = asyncHandler(async (req, res, next) => {
  if (!isValidId(req.params.partId))
    return next(new ErrorResponse("Invalid part id", 400));

  const part = await TrainingModulePart.findById(req.params.partId);

  if (!part) return next(new ErrorResponse("Part not found", 404));

  res.status(200).json({ success: true, data: part });
});
// @desc Update single part
// @route PUT /api/v1/training-modules/parts/:partId
exports.updatePart = asyncHandler(async (req, res, next) => {
  if (!isValidId(req.params.partId))
    return next(new ErrorResponse("Invalid part id", 400));

  const part = await TrainingModulePart.findByIdAndUpdate(
    req.params.partId,
    req.body,
    { new: true, runValidators: true },
  );

  if (!part) return next(new ErrorResponse("Part not found", 404));

  res.status(200).json({ success: true, data: part });
});
// @desc Update single part
// @route D /api/v1/training-modules/parts/:partId
exports.deletePart = asyncHandler(async (req, res, next) => {
  if (!isValidId(req.params.partId))
    return next(new ErrorResponse("Invalid part id", 400));

  const part = await TrainingModulePart.findByIdAndDelete(req.params.partId);
  if (!part) return next(new ErrorResponse("Part not found", 404));

  await part.deleteOne();

  res.status(200).json({ success: true, data: part });
});

//
// QUESTIONS
//

// @desc Create question
// @route POST /api/v1/parts/:partId/questions
exports.createQuestion = asyncHandler(async (req, res, next) => {
  const { partId } = req.params;

  if (!isValidId(partId))
    return next(new ErrorResponse("Invalid part id", 400));

  const part = await TrainingModulePart.findById(partId);
  if (!part) return next(new ErrorResponse("Part not found", 404));

  const question = await TrainingModuleQuestion.create(req.body);

  part.questions.push(question._id);
  await part.save();

  res.status(201).json({ success: true, data: question });
});

// @desc GET question
exports.getQuestion = asyncHandler(async (req, res, next) => {
  const q = await TrainingModuleQuestion.findById(req.params.id);

  if (!q) return next(new ErrorResponse("Question not found", 404));

  res.status(200).json({ success: true, data: q });
});
// @desc Update question
exports.updateQuestion = asyncHandler(async (req, res, next) => {
  const q = await TrainingModuleQuestion.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true, runValidators: true },
  );

  if (!q) return next(new ErrorResponse("Question not found", 404));

  res.status(200).json({ success: true, data: q });
});

// @desc Delete question
exports.deleteQuestion = asyncHandler(async (req, res, next) => {
  const q = await TrainingModuleQuestion.findById(req.params.id);
  if (!q) return next(new ErrorResponse("Question not found", 404));

  await q.deleteOne();

  await TrainingModulePart.updateMany(
    { questions: q._id },
    { $pull: { questions: q._id } },
  );

  res.status(200).json({ success: true });
});


//@desc Module Assign: Manager
//@route POST /api/v1/:moduleId/assign
exports.assignModule = asyncHandler(async (req, res, next) => {
  const { moduleId } = req.params;
  const { learnerIds, dueDate, maxAttempts } = req.body;

  const managerId = req.user._id;

  const assignments = learnerIds.map(userId => ({
    module: moduleId,
    learner: userId,
    assignedBy: managerId,
    dueDate,
    maxAttempts,
  }));

  await ModuleAssignment.insertMany(assignments, {
    ordered: false, // skip duplicates
  });

  // update module stats
  await TrainingModule.findByIdAndUpdate(moduleId, {
    $inc: { "stats.assignedCount": learnerIds.length },
  });

  res.json({
    success: true,
    message: "Module assigned successfully",
  });
});

//@desc : Get Manager Assigned List
//@route GET /api/v1/assigned-by-me
exports.getManagerModule = asyncHandler(async (req, res, next) => {
  const modules = await ModuleAssignment.find({ assignedBy: req.user._id });

  res.json({
    data: modules,
    success: true,
    message: "Find Modules assigned by me",
  });
});