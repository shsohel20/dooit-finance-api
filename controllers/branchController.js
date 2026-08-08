// controllers/branchController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Branch = require("../models/Branch");
const {
  validateBranchUpdate,
  validateBranchCreation,
  generateRandomPassword,
  initialPassword,
} = require("../utils");
const User = require("../models/User");
const UserType = require("../models/UserType");
const Client = require("../models/Client");
const { hashForSearch } = require("../utils/encryption");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");

/**
 * Basic filter helper for client-side searching by name
 * (used similarly to filterUserSection)
 */
exports.filterBranchSection = (doc, requestBody, req) => {
  // const client = req.user?.clients;
  // const clientId = client;
  // // console.log(client);

  // if (clientId && !doc.client === String(clientId)) {
  //   return false;
  // }
  if (!doc.name || !requestBody.name) return false;
  return doc.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all branches
// @route  GET /api/v1/branches
// @access Public
exports.getBranches = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Branch']
  #swagger.summary = 'Get All Branch'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});
exports.getBranchesPost = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Branch']
  #swagger.summary = 'Get All Branch'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: {  } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});

// @desc   Create single branch
// @route  POST /api/v1/branches
// @access Public
exports.createBranch = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Branch']
  #swagger.summary = 'Create Branch'
  #swagger.security = [{ "BearerAuth": [] }]
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/BranchBody' } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // validate payload (includes User uniqueness checks when userName/email present)
  const ok = await validateBranchCreation(req, next);
  if (!ok) return;
  const loggedInUser = req.user ?? null;
  const client = await Client.findOne({ user: loggedInUser?.id });
  const {
    name,
    branchCode,
    email,
    phone,
    slug,
    manager,
    services,
    address,
    documents,
    settings,
    metadata,
    // user-related props (optional)
    userName,

    autoCreateUserForBranch = false, // optional flag
  } = req.body;

  if (!client) {
    return next(
      new ErrorResponse("Un Authorized Person , please check login info", 500)
    );
  }
  // Decide whether to create a user:
  // - explicit userName or userEmail provided
  // - or a flag autoCreateUserForBranch true AND an email exists (branch email)
  const shouldCreateUser = Boolean(
    userName || (autoCreateUserForBranch && email)
  );

  let createdUser = null;


  if (shouldCreateUser) {
    const userName1 =
      userName || (email ? email.split("@")[0] : `${branchCode}`);

    // Use emailHash for dedupe — plaintext email may be AES-encrypted at rest.
    createdUser = await User.findOne({ emailHash: hashForSearch(email) });

    if (!createdUser) {

      const uPayload = {
        name: name,
        email: email.toLowerCase(),
        userName: userName1,
        phone,
        password: initialPassword,
        isActive: true,
      };

      // create user
      createdUser = await User.create(uPayload);
    }
  }

  if (!createdUser) {
    return next(new ErrorResponse("Failed to create branch user account", 500));
  }

  // create branch object; include reference to createdUser if available
  const branchPayload = {
    client,
    name,
    branchCode,
    email: email && email.toLowerCase(),
    phone,
    slug,
    manager,
    services,
    address,
    documents,
    settings,
    metadata,
  };

  if (createdUser) branchPayload.user = createdUser._id;

  const branch = await Branch.create(branchPayload);

  // Seed UserType membership after branch is created so we know the clientBelongs.
  if (createdUser) {
    await UserType.findOneAndUpdate(
      { user: createdUser._id, userType: "branch", role: "admin", clientBelongs: client ?? null, branchBelongs: branch._id },
      { $setOnInsert: { isActive: true, assignedBy: req.user?._id ?? null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  logEvent({
    req,
    service: "auth",
    action: "branch_created",
    client: client._id,
    branch: branch._id,
    afterValue: { name: branch.name },
  });
  recordDevice({ req, purpose: "admin_action" });

  res.status(201).json({
    succeed: true,
    data: branch,
    id: branch._id,
    ...(createdUser
      ? {
        branchUser: {
          id: createdUser._id,
          userName: createdUser.userName,
          email: createdUser.email,
          password: initialPassword,
        },
      }
      : {}),
  });
});
// @desc   Create single branch
// @route  POST /api/v1/branches
// @access Public
exports.createDummyBranch = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Branch']
  #swagger.summary = 'Dummy  Branch'
  #swagger.security = [{ "BearerAuth": [] }]
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/BranchBody' } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // validate payload (includes User uniqueness checks when userName/email present)
  const ok = await validateBranchCreation(req, next);
  if (!ok) return;

  const {
    name,
    branchCode,
    email,
    phone,
    slug,
    manager,
    services,
    address,
    documents,
    settings,
    metadata,
    // user-related props (optional)
    userName,
    clientName,
    autoCreateUserForBranch = false, // optional flag
  } = req.body;

  const client = await Client.findOne({ name: clientName });

  if (!client) {
    return next(new ErrorResponse("Client not available by Client Name", 500));
  }
  // Decide whether to create a user:
  // - explicit userName or userEmail provided
  // - or a flag autoCreateUserForBranch true AND an email exists (branch email)
  const shouldCreateUser = Boolean(
    userName || (autoCreateUserForBranch && email)
  );

  let createdUser = null;


  if (shouldCreateUser) {
    const userName1 =
      userName || (email ? email.split("@")[0] : `${branchCode}`);

    // Use emailHash for dedupe — plaintext email may be AES-encrypted at rest.
    createdUser = await User.findOne({ emailHash: hashForSearch(email) });

    if (!createdUser) {

      const uPayload = {
        name: name,
        email: email.toLowerCase(),
        userName: userName1,
        phone,
        password: initialPassword,
        isActive: true,
      };

      // create user
      createdUser = await User.create(uPayload);
    }
  }

  if (!createdUser) {
    return next(new ErrorResponse("Failed to create branch user account", 500));
  }

  // create branch object; include reference to createdUser if available
  const branchPayload = {
    client,
    name,
    branchCode,
    email: email && email.toLowerCase(),
    phone,
    slug,
    manager,
    services,
    address,
    documents,
    settings,
    metadata,
  };

  if (createdUser) branchPayload.user = createdUser._id;

  const branch = await Branch.create(branchPayload);

  // Seed UserType membership after branch is created.
  if (createdUser) {
    await UserType.findOneAndUpdate(
      { user: createdUser._id, userType: "branch", role: "admin", clientBelongs: client ?? null, branchBelongs: branch._id },
      { $setOnInsert: { isActive: true, assignedBy: req.user?._id ?? null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  if (!branch) {
    return next(new ErrorResponse(`Branch Not Create`, 500));
  }

  res.status(201).json({
    succeed: true,
    data: branch,
    id: branch._id,
    ...(createdUser
      ? {
        branchUser: {
          id: createdUser._id,
          userName: createdUser.userName,
          email: createdUser.email,
          password: initialPassword,
        },
      }
      : {}),
  });
});

// @desc   Get single branch by id
// @route  GET /api/v1/branches/:id
// @access Public
exports.getBranch = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Branch']
  #swagger.summary = 'Get By Branch'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const branch = await Branch.findById(req.params.id).populate("client");

  if (!branch) {
    return next(
      new ErrorResponse(`Branch not found with id of ${req.params.id}`, 404)
    );
  }

  res.status(200).json({
    success: true,
    data: branch,
  });
});

// @desc   Get single branch by slug
// @route  GET /api/v1/branches/slug/:slug
// @access Public (or Private based on your route)
exports.getBranchBySlug = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Branch']
  #swagger.summary = 'Get by slug'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const branch = await Branch.findOne({ slug: req.params.slug }).populate(
    "client"
  );

  if (!branch) {
    return next(
      new ErrorResponse(`Branch not found with slug of ${req.params.slug}`, 404)
    );
  }

  res.status(200).json({
    success: true,
    data: branch,
  });
});

// @desc   Update single branch
// @route  PUT /api/v1/branches/:id
// @access Public
exports.updateBranch = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Branch']
  #swagger.summary = 'Update Branch'
  #swagger.security = [{ "BearerAuth": [] }]
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/BranchBody' } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const branchId = req.params.id;
  const branch = await Branch.findById(branchId);
  if (!branch)
    return next(
      new ErrorResponse(`Branch not found with id of ${branchId}`, 404)
    );

  // validate update payload
  const ok = await validateBranchUpdate(branchId, req.body, next);
  if (!ok) return;

  // if user fields present, update linked user
  const { userName, userEmail } = req.body;
  if (userName || userEmail) {
    // ensure branch has linked user; if not, create one
    let linkedUser = null;
    if (branch.user) {
      linkedUser = await User.findById(branch.user);
      if (linkedUser) {
        if (userName) linkedUser.userName = userName;
        if (userEmail) linkedUser.email = userEmail.toLowerCase();
        await linkedUser.save();
      }
    } else {
      // create new user and attach
      const newPassword = generateRandomPassword(10);
      const newUser = await User.create({
        name: req.body.name || branch.name,
        email: (userEmail || branch.email || "").toLowerCase(),
        userName: userName || (userEmail || branch.email || "").split("@")[0],
        password: newPassword,
        isActive: true,
      });
      // Seed UserType membership for this branch user.
      await UserType.findOneAndUpdate(
        { user: newUser._id, userType: "branch", role: "branch", clientBelongs: branch.client ?? null, branchBelongs: branch._id },
        { $setOnInsert: { isActive: true } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      branch.user = newUser._id;
      await branch.save();

      logEvent({
        req,
        service: "auth",
        action: "membership_granted",
        user: newUser._id,
        client: branch.client ?? null,
        branch: branch._id,
        afterValue: {
          userType: "branch",
          role: "branch",
          branchBelongs: branch._id,
        },
      });
      logEvent({
        req,
        service: "auth",
        action: "branch_updated",
        client: branch.client ?? null,
        branch: branch._id,
        details: `Changed: ${Object.keys(req.body || {}).join(", ")}`,
      });

      // return initial password in response (one-time)
      return res.status(200).json({
        success: true,
        data: branch,
        branchUser: {
          id: newUser._id,
          userName: newUser.userName,
          email: newUser.email,
          password: newPassword,
        },
      });
    }
  }

  // perform normal branch update
  const updated = await Branch.findByIdAndUpdate(branchId, req.body, {
    new: true,
    runValidators: true,
  });

  logEvent({
    req,
    service: "auth",
    action: "branch_updated",
    client: branch.client ?? null,
    branch: branchId,
    details: `Changed: ${Object.keys(req.body || {}).join(", ")}`,
  });

  res.status(200).json({
    success: true,
    data: updated,
  });
});

// @desc   Delete single branch
// @route  DELETE /api/v1/branches/:id
// @access Public
exports.deleteBranch = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Branch']
  #swagger.summary = 'Delete by id'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const branch = await Branch.findById(req.params.id);
  if (!branch) {
    return next(
      new ErrorResponse(`Branch not found with id of ${req.params.id}`, 404)
    );
  }

  // Snapshot BEFORE the delete — nothing left to read afterwards.
  const auditBefore = { name: branch.name };
  const branchClient = branch.client ?? null;

  await branch.deleteOne();

  logEvent({
    req,
    service: "auth",
    action: "branch_deleted",
    client: branchClient,
    branch: req.params.id,
    beforeValue: auditBefore,
  });

  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});
