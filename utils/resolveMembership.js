const UserType = require("../models/UserType");

/**
 * Resolve the active UserType membership for a user.
 *
 * 1. If requestedUserType is supplied, find the first active membership of that type.
 * 2. If no match (or no type supplied), fall back to the oldest active membership.
 * Returns null if the user has no active memberships at all.
 *
 * @param {ObjectId|string} userId
 * @param {string|null} requestedUserType  — from x-user-type header or body
 * @returns {Promise<Object|null>}
 */
async function resolveMembership(userId, requestedUserType) {
  if (requestedUserType) {
    const match = await UserType.findOne({
      user: userId,
      userType: requestedUserType,
      isActive: true,
    }).lean();
    if (match) return match;
  }

  // Fallback: oldest active membership (deterministic)
  return UserType.findOne({ user: userId, isActive: true })
    .sort({ createdAt: 1 })
    .lean();
}

module.exports = { resolveMembership };
