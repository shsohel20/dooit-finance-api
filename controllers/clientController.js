// controllers/client.controller.js
const asyncHandler = require("../middleware/async");
const Client = require("../models/Client");
const User = require("../models/User");
const { validateClientCreation } = require("../utils");
const ErrorResponse = require("../utils/errorResponse");

/**
 * Simple filter helper similar to filterUserSection
 * Checks if client name includes the requestBody.name (case-insensitive)
 */
exports.filterClientSection = (c, requestBody) => {
  if (!requestBody || !requestBody.name) return true;
  return c.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all clients
// @route  /api/v1/clients
// @access Public (or restrict as needed)
exports.getClients = asyncHandler(async (req, res, next) => {
  // expects advancedResults middleware to populate res.advancedResults
  res.status(200).json(res.advancedResults);
});

// @desc   Create a single client
// @route  /api/v1/clients
// @access Public (or restrict as needed)
exports.createClient = asyncHandler(async (req, res, next) => {
  // Validate request
  const isValid = await validateClientCreation(req.body, next);
  if (!isValid) return;

  const {
    name,
    clientType,
    registrationNumber,
    taxId,
    email,
    phone,
    website,
    contacts,
    address,
    legalRepresentative,
    documents,
    status,
    settings,
    metadata,
    userName,
  } = req.body;

  let user = null;

  user = await User.findOne({
    email,
    userName,
  });
  if (!user) {
    user = await User.create({
      name,
      email,
      password: "123456", // TODO: replace with random password
      role: "admin",
      isActive: true,
      userName,
    });
  }
  // Create new user

  if (!user) return next(new ErrorResponse("Please try again!", 400));

  // Create client record
  const client = await Client.create({
    user: user._id,
    name,
    clientType,
    registrationNumber,
    taxId,
    email,
    phone,
    website,
    contacts,
    address,
    legalRepresentative,
    documents,
    status,
    settings,
    metadata,
  });

  res.status(201).json({
    succeed: true,
    data: client,
    id: client._id,
  });
});

// @desc   Fetch single client by id
// @route  /api/v1/clients/:id
// @access Public
exports.getClient = asyncHandler(async (req, res, next) => {
  const client = await Client.findById(req.params.id).populate(
    "user",
    "userName -_id",
  );

  if (!client) {
    return next(
      new ErrorResponse(`Client not found with id of ${req.params.id}`, 404),
    );
  }
  res.status(200).json({
    success: true,
    data: client,
  });
});

// @desc   Fetch single client by slug
// @route  /api/v1/clients/slug/:slug
// @access Public/Private depending on your auth
exports.getClientBySlug = asyncHandler(async (req, res, next) => {
  const client = await Client.findOne({ slug: req.params.slug });
  if (!client) {
    return next(
      new ErrorResponse(
        `Client not found with slug of ${req.params.slug}`,
        404,
      ),
    );
  }
  res.status(200).json({
    success: true,
    data: client,
  });
});

/**
 * Update single client (with multi-field duplicate checks and linked user update)
 * @route  PUT /api/v1/clients/:id
 */
exports.updateClient = asyncHandler(async (req, res, next) => {
  const clientId = req.params.id;
  const {
    name,
    email,
    registrationNumber,
    taxId,
    phone,
    website,
    userName, // optional: update linked user's userName
    // ... other client fields
  } = req.body;

  // 1. Fetch existing client
  const client = await Client.findById(clientId);
  if (!client) {
    return next(
      new ErrorResponse(`Client not found with id of ${clientId}`, 404),
    );
  }

  // 2. Build list of candidate unique checks for Client
  const clientUniqueChecks = [
    { name },
    { email },
    { registrationNumber },
    { taxId },
    { phone },
    { website },
  ].filter((obj) => {
    const val = Object.values(obj)[0];
    return val !== undefined && val !== null && String(val).trim() !== "";
  });

  if (clientUniqueChecks.length > 0) {
    const orQuery = clientUniqueChecks;
    // exclude current client by _id
    const existing = await Client.findOne({
      $or: orQuery,
      _id: { $ne: clientId },
    }).lean();

    if (existing) {
      // determine which field(s) collided to give a clearer error
      const collidedFields = [];
      clientUniqueChecks.forEach((check) => {
        const key = Object.keys(check)[0];
        const val = String(check[key]).trim().toLowerCase();
        const existingVal = existing[key];
        if (
          existingVal !== undefined &&
          existingVal !== null &&
          String(existingVal).trim().toLowerCase() === val
        ) {
          collidedFields.push(key);
        }
      });

      const fieldsMsg = collidedFields.length
        ? collidedFields.join(", ")
        : "one of the unique fields";
      return next(
        new ErrorResponse(
          `Another client already uses the same ${fieldsMsg}.`,
          409,
        ),
      );
    }
  }

  // 3. If updating linked user info (email/userName), ensure uniqueness across Users excluding current linked user (if any)
  if (
    (email && String(email).trim() !== "") ||
    (userName && String(userName).trim() !== "")
  ) {
    // find linked user id from client.user (if present)
    const linkedUserId = client.user ? client.user.toString() : null;

    const userUniqueChecks = [
      userName ? { userName } : null,
      email ? { email } : null,
    ].filter(Boolean);

    if (userUniqueChecks.length > 0) {
      const userExisting = await User.findOne({
        $or: userUniqueChecks,
        ...(linkedUserId ? { _id: { $ne: linkedUserId } } : {}),
      }).lean();

      if (userExisting) {
        // detect which user field collided
        const collidedUserFields = [];
        userUniqueChecks.forEach((check) => {
          const key = Object.keys(check)[0];
          const val = String(check[key]).trim().toLowerCase();
          const existingVal = userExisting[key];
          if (
            existingVal !== undefined &&
            existingVal !== null &&
            String(existingVal).trim().toLowerCase() === val
          ) {
            collidedUserFields.push(key);
          }
        });

        const fieldsMsg = collidedUserFields.length
          ? collidedUserFields.join(", ")
          : "email/userName";
        return next(
          new ErrorResponse(
            `Another user already uses the same ${fieldsMsg}.`,
            409,
          ),
        );
      }
    }
  }

  // 4. Perform client update
  const updatedClient = await Client.findByIdAndUpdate(clientId, req.body, {
    new: true,
    runValidators: true,
  });

  if (!updatedClient) {
    return next(
      new ErrorResponse(`Failed to update client with id ${clientId}`, 500),
    );
  }

  // 5. If linked user exists and email/userName changed, update linked user
  try {
    if (client.user) {
      const linkedUser = await User.findById(client.user).select("+password");
      if (linkedUser) {
        let shouldSaveUser = false;

        if (
          email &&
          String(email).trim() !== "" &&
          String(linkedUser.email).trim().toLowerCase() !==
            String(email).trim().toLowerCase()
        ) {
          linkedUser.email = email;
          shouldSaveUser = true;
        }

        if (
          userName &&
          String(userName).trim() !== "" &&
          String(linkedUser.userName).trim().toLowerCase() !==
            String(userName).trim().toLowerCase()
        ) {
          linkedUser.userName = userName;
          shouldSaveUser = true;
        }

        // You may also want to sync name or other user fields from client body:
        if (
          req.body.name &&
          String(linkedUser.name).trim() !== String(req.body.name).trim()
        ) {
          linkedUser.name = req.body.name;
          shouldSaveUser = true;
        }

        if (shouldSaveUser) {
          await linkedUser.save();
        }
      }
    }
  } catch (err) {
    // If user update fails for some reason, log it but don't necessarily fail the entire request.
    // However, depending on your needs, you could revert the client update or return an error.
    console.error(
      "Warning: failed to update linked user after client update:",
      err,
    );
  }

  res.status(200).json({
    success: true,
    data: updatedClient,
  });
});

/**
 * Delete single client
 * - Default: soft-delete (marks client as Inactive and sets metadata.deleted)
 * - Hard delete: pass query ?hard=true
 * - If hard delete and you want to also delete linked user: pass ?deleteUser=true
 *
 * Route: DELETE /api/v1/clients/:id
 */
exports.deleteClient = asyncHandler(async (req, res, next) => {
  const clientId = req.params.id;
  const hardDelete = String(req.query.hard || "").toLowerCase() === "true";
  const deleteLinkedUser =
    String(req.query.deleteUser || "").toLowerCase() === "true";

  const client = await Client.findById(clientId).exec();
  if (!client) {
    return next(
      new ErrorResponse(`Client not found with id of ${clientId}`, 404),
    );
  }

  // Get linked user id if exists
  const linkedUserId = client.user ? client.user.toString() : null;

  // If hard delete requested, try to run inside a transaction (if DB supports it)
  if (hardDelete) {
    // Best-effort: use a session if available
    let session = null;
    let usedSession = false;
    try {
      if (mongoose.connection && mongoose.connection.startSession) {
        session = await mongoose.connection.startSession();
        session.startTransaction();
        usedSession = true;
      }

      // Delete client
      if (usedSession) {
        await Client.deleteOne({ _id: clientId }).session(session);
      } else {
        await Client.deleteOne({ _id: clientId });
      }

      // Optionally delete linked user
      if (deleteLinkedUser && linkedUserId) {
        if (usedSession) {
          await User.deleteOne({ _id: linkedUserId }).session(session);
        } else {
          await User.deleteOne({ _id: linkedUserId });
        }
      } else if (linkedUserId) {
        // If not deleting the user, disassociate the user.client field
        if (usedSession) {
          await User.updateOne(
            { _id: linkedUserId },
            { $unset: { client: "" } },
          ).session(session);
        } else {
          await User.updateOne(
            { _id: linkedUserId },
            { $unset: { client: "" } },
          );
        }
      }

      // TODO: Delete or cleanup other related collections (vendors/accounts/orders/etc.)
      // e.g. await SomeModel.deleteMany({ client: clientId }).session(session);

      if (usedSession) {
        await session.commitTransaction();
        session.endSession();
      }

      return res.status(200).json({
        success: true,
        message: `Client ${
          hardDelete ? "hard-deleted" : "deleted"
        } successfully`,
        data: {
          id: clientId,
          deletedUser: deleteLinkedUser ? linkedUserId : null,
        },
      });
    } catch (err) {
      if (usedSession && session) {
        try {
          await session.abortTransaction();
          session.endSession();
        } catch (e) {
          console.error("Failed to abort session", e);
        }
      }
      console.error(err);
      return next(
        new ErrorResponse("Failed to delete client. " + err.message, 500),
      );
    }
  }

  // Soft delete (default)
  try {
    // Mark client as Inactive, set metadata.deleted and timestamp
    client.status = "Inactive";
    if (!client.metadata || typeof client.metadata !== "object")
      client.metadata = {};
    client.metadata.deleted = true;
    client.metadata.deletedAt = new Date();

    // Optionally you can also move the name to a backup field to avoid unique collisions:
    // client.metadata.previousName = client.name;
    // client.name = `${client.name}--deleted--${client._id}`;

    await client.save();

    // Disassociate linked user (if any) but do NOT delete user
    if (linkedUserId) {
      await User.updateOne({ _id: linkedUserId }, { $unset: { client: "" } });
    }

    return res.status(200).json({
      success: true,
      message: "Client soft-deleted (status set to Inactive)",
      data: { id: clientId },
    });
  } catch (err) {
    console.error(err);
    return next(
      new ErrorResponse("Failed to soft-delete client. " + err.message, 500),
    );
  }
});

/**
 * Optional: update client status (Active/Pending/Inactive/Blocked)
 * @route PUT /api/v1/clients/:id/status
 */
exports.updateClientStatus = asyncHandler(async (req, res, next) => {
  const { status, isActive } = req.body;
  const client = await Client.findById(req.params.id);
  if (!client) {
    return next(
      new ErrorResponse(`Client not found with id of ${req.params.id}`, 404),
    );
  }

  if (typeof status === "string") client.status = status;
  if (typeof isActive === "boolean") client.isActive = isActive;

  await client.save();

  res.status(200).json({
    success: true,
    data: client,
  });
});
