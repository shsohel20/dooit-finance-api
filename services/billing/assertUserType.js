// services/billing/assertUserType.js
//
// userType guards for the billing module.
//
// The billing module distinguishes two actors: `dooit` (platform Super Admin —
// authors plans, applies billing) and `client` (the billed party — subscribes,
// consumes, pays).
//
// IMPORTANT: `userType` is NOT a field on `users`. Users is identity-only; the
// discriminator lives on the UserType collection, one row per membership
// (User.js:163). So "is this a dooit user?" is a question about a MEMBERSHIP,
// and a single person may legitimately hold both a dooit and a client one.
//
// That is why two guards exist and both are needed:
//   assertUserType()  — validates a STORED reference (createdBy, user, …)
//   assertActingAs()  — validates the CALLER's active hat, from the JWT
//
// A user holding both memberships must not be able to publish a plan while
// acting as a client, which only assertActingAs can catch.
//
// Reference: docs/billingmodule/mongoose-schema.md §C.0

const UserType = require("../../models/UserType");
const ErrorResponse = require("../../utils/errorResponse");
const {
  USER_TYPE_DOOIT,
  USER_TYPE_CLIENT,
} = require("../../models/constants/billing");

/**
 * Assert that `userId` holds an ACTIVE membership of `type`.
 * Use before persisting any user reference on a billing document.
 *
 * @param {ObjectId|String} userId
 * @param {String} type  'dooit' | 'client'
 * @param {String} [label]  field name, for a useful error message
 * @throws {ErrorResponse} 400 when userId is missing, 403 when the type is wrong
 */
async function assertUserType(userId, type, label = "user") {
  if (!userId) {
    throw new ErrorResponse(`${label} is required`, 400);
  }
  const exists = await UserType.exists({
    user: userId,
    userType: type,
    isActive: true,
  });
  if (!exists) {
    throw new ErrorResponse(
      `${label} must reference an active "${type}" user`,
      403
    );
  }
  return true;
}

/**
 * Assert that the CALLER is currently acting as `type`.
 * Reads the active membership from the JWT (auth.js overlays it onto req.user).
 *
 * Note this is intentionally stricter than middleware/auth.js `authorizeUserType`,
 * which lets `dooit` through unconditionally. Here the check is exact, so it can
 * also be used to assert "acting as a client".
 *
 * @param {Object} req
 * @param {String} type  'dooit' | 'client'
 */
function assertActingAs(req, type) {
  const active = (req.user?.userType ?? "").toLowerCase();
  if (active !== type) {
    throw new ErrorResponse(
      `This action requires acting as "${type}" (currently "${active || "none"}")`,
      403
    );
  }
  return true;
}

/** True when the caller's active hat is dooit. */
const isDooit = (req) =>
  (req.user?.userType ?? "").toLowerCase() === USER_TYPE_DOOIT;

/** True when the caller's active hat is client. */
const isClient = (req) =>
  (req.user?.userType ?? "").toLowerCase() === USER_TYPE_CLIENT;

/** The acting user's _id, or null. */
const actorId = (req) => req.user?._id ?? null;

/** The acting user's company (Client._id), or null — dooit users have none. */
const actorClient = (req) =>
  req.user?.client?._id ?? req.user?.clientBelongs ?? null;

module.exports = {
  assertUserType,
  assertActingAs,
  isDooit,
  isClient,
  actorId,
  actorClient,
  USER_TYPE_DOOIT,
  USER_TYPE_CLIENT,
};
