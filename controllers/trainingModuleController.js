const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const TrainingModule = require("../models/TrainingModule");
const TrainingModulePart = require("../models/TrainingModulePart");
const TrainingModuleQuestion = require("../models/TrainingModuleQuestion");
const ModuleAssignment = require("../models/ModuleAssignment");
const TrainingModuleAccess = require("../models/TrainingModuleAccess");
const User = require("../models/User");
const Roles = require("../models/Role");
const axios = require("axios");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const _ = require("lodash");

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

//
// MODULE CRUD
//

// @desc Create module
// @route POST /api/v1/training-modules
exports.createModule = asyncHandler(async (req, res, next) => {
  const { title, description, status } = req.body;

  if (!title) {
    return next(new ErrorResponse("title is required", 400));
  }

  const module = await TrainingModule.create({
    title,
    description,
    status,
    createdBy: req.user._id,
  });

  res.status(201).json({ success: true, data: module });
});

exports.assignAccess = asyncHandler(async (req, res, next) => {
  const { moduleId } = req.params;

  const mod = await TrainingModule.findById(moduleId);
  if (!mod) return next(new ErrorResponse("Module not found", 404));
  const scopes = Array.isArray(req.body) ? req.body : [req.body];

  console.log(scopes);

  const allRoles = await Roles.find({}).select("_id name").lean();
  const roleIdToName = {};
  const roleNameToId = {};
  for (const r of allRoles) {
    roleIdToName[String(r._id)] = r.name.toLowerCase();
    roleNameToId[r.name.toLowerCase()] = String(r._id);
  }

  const docs = scopes.map(({ client, branch, roles }) => ({
    // uid: `TMACSS_${new mongoose.Types.ObjectId()}`,
    module: moduleId,
    client: client || null,
    branch: branch || null,
    roles: Array.isArray(roles) ? roles : roles ? [roles] : [],
    assignedBy: req.user._id,
  }));
  let clientUsers = [];
  for (const doc of docs) {
    const query = {
      module: moduleId,
      client: doc.client,
      branch: doc.branch,
    };
    const queryUser = {
      // module: moduleId,
      clientBelongs: doc.client,
      branchBelongs: doc.branch,
    };

    const client = await Client.findById(doc.client)
      .populate({
        path: "user",
        select: "_id role userType",
      })
      .lean();
    const branch = await Branch.findById(doc.branch)
      .populate({
        path: "user",
        select: "_id role userType",
      })
      .lean();

    clientUsers = [
      ...clientUsers,
      ...(await User.find(queryUser).select("_id role userType").lean()),
      ...(client?.user ? [client.user] : []),
      ...(branch?.user ? [branch.user] : []),
    ];

    clientUsers = clientUsers.filter(
      (u) => u && doc.roles.includes(roleNameToId[u.role?.toLowerCase()]),
    ); // filter out null/undefined
  }

  let inserted = 0;
  try {
    const result = await TrainingModuleAccess.insertMany(docs, {
      ordered: false,
      rawResult: true,
    });
    inserted = result.insertedCount ?? 0;
  } catch (err) {
    if (err.name === "MongoBulkWriteError" || err.result) {
      inserted = err.result?.insertedCount ?? err.insertedCount ?? 0;
    } else {
      return next(err);
    }
  }
  const uniqueUsers = _.uniqBy(
    clientUsers.filter((u) => u?._id),
    (u) => String(u._id),
  );

  const learnerIds = uniqueUsers.map((u) => u._id);

  const assignDocs = uniqueUsers.map((u) => ({
    module: moduleId,
    learner: u._id,
    assignedBy: req.user._id,

    roleId: roleNameToId[u.role?.toLowerCase()]
      ? new mongoose.Types.ObjectId(roleNameToId[u.role.toLowerCase()])
      : undefined,
  }));

  await ModuleAssignment.bulkWrite([
    // CREATE + UPDATE
    ...assignDocs.map((doc) => ({
      updateOne: {
        filter: {
          module: doc.module,
          learner: doc.learner,
        },

        update: {
          $set: {
            assignedBy: doc.assignedBy,
            roleId: doc.roleId,
          },

          // only when creating
          $setOnInsert: {
            uid: `MODASS_${new mongoose.Types.ObjectId()}`,
            module: doc.module,
            learner: doc.learner,
            status: "pending",
          },
        },

        upsert: true,
      },
    })),

    // DELETE removed learners
    {
      deleteMany: {
        filter: {
          module: moduleId,
          learner: {
            $nin: learnerIds,
          },
        },
      },
    },
  ]);

  res.status(201).json({
    success: true,
    moduleId,
    inserted,
    skipped: docs.length - inserted,
  });
});

// @desc  Get all access rules for a module
// @route GET /api/v1/training-modules/:moduleId/access
exports.getModuleAccess = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const { moduleId } = req.params;

  const query = {
    client,
    branch,
    module: moduleId,
  };

  Object.keys(query).forEach((key) => {
    if (
      query[key] == null ||
      query[key] == undefined ||
      query[key]?.length == 0
    ) {
      delete query[key];
    }
  });

  if (!mongoose.Types.ObjectId.isValid(moduleId))
    return next(new ErrorResponse("Invalid module id", 400));

  const access = await TrainingModuleAccess.find(query);

  res.status(200).json({ success: true, count: access.length, data: access });
});

// @desc  Remove a single access rule
// @route DELETE /api/v1/training-modules/access/:accessId
exports.deleteModuleAccess = asyncHandler(async (req, res, next) => {
  const { accessId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(accessId))
    return next(new ErrorResponse("Invalid access id", 400));

  const access = await TrainingModuleAccess.findByIdAndDelete(accessId);
  if (!access) return next(new ErrorResponse("Access rule not found", 404));

  res.status(200).json({ success: true });
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

  console.log(req.params.id);

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

function convertISO8601(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);
  return hours * 3600 + minutes * 60 + seconds;
}

async function getVideoMetadata(url) {
  let provider = "self";
  let durationSec = 0;
  let videoId = null;

  // YOUTUBE
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    provider = "youtube";

    const match = url.match(
      /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([^&?/]+)/,
    );

    videoId = match ? match[1] : null;

    const api = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`;

    const res = await axios.get(api);

    const duration = res.data.items[0].contentDetails.duration;

    durationSec = convertISO8601(duration);
  }

  // VIMEO
  else if (url.includes("vimeo.com")) {
    provider = "vimeo";

    const match = url.match(/vimeo\.com\/(\d+)/);
    videoId = match ? match[1] : null;

    const res = await axios.get(
      `https://vimeo.com/api/v2/video/${videoId}.json`,
    );

    durationSec = res.data[0].duration;
  }

  // CLOUDINARY
  else if (url.includes("cloudinary.com")) {
    provider = "cloudinary";
  }

  // AWS S3
  else if (url.includes("amazonaws.com") || url.includes("s3.")) {
    provider = "aws";
  }

  return {
    url,
    provider,
    videoId,
    durationSec,
  };
}
// @desc Create part
// @route POST /api/v1/training-modules/:moduleId/parts
exports.createPart = asyncHandler(async (req, res, next) => {
  const { moduleId } = req.params;
  const { video } = req.body;

  if (!isValidId(moduleId))
    return next(new ErrorResponse("Invalid module id", 400));

  const mod = await TrainingModule.findById(moduleId);
  if (!mod) return next(new ErrorResponse("Module not found", 404));

  const videoMetaData = await getVideoMetadata(video?.url ?? "");

  const part = await TrainingModulePart.create({
    ...req.body,
    video: videoMetaData,
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

  const { video } = req.body;

  const videoMetaData = await getVideoMetadata(video?.url ?? "");

  const reqBody = {
    ...req.body,
    video: videoMetaData,
  };

  const part = await TrainingModulePart.findByIdAndUpdate(
    req.params.partId,
    reqBody,
    { new: true, runValidators: true },
  );

  if (!part) return next(new ErrorResponse("Part not found", 404));

  res.status(200).json({ success: true, data: part });
});
// @desc Delete single part
// @route DELETE /api/v1/training-modules/parts/:partId
exports.deletePart = asyncHandler(async (req, res, next) => {
  if (!isValidId(req.params.partId))
    return next(new ErrorResponse("Invalid part id", 400));

  const part = await TrainingModulePart.findByIdAndDelete(req.params.partId);
  if (!part) return next(new ErrorResponse("Part not found", 404));

  res.status(200).json({ success: true, data: part });
});

//
// QUESTIONS Here
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
