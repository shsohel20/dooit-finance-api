"use strict";

const Role = require("../models/Role");

/**
 * utils/attachUserRoleId.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The User model stores `role` as a name string (e.g. "admin"), not a Role
 * ObjectId. This helper resolves each populated user's role name to its Role
 * document _id and attaches it as `user.roleId` so API responses expose both.
 *
 * Accepts a single Staff doc/object or an array. Mongoose documents are
 * converted to plain objects (with virtuals) so the non-schema `roleId` field
 * survives JSON serialization; lean objects pass through and are mutated.
 *
 * Role-name matching is case-insensitive, mirroring middleware/auth.js.
 *
 * @param {Object|Array|null} staff — Staff doc(s)/object(s) with `user` populated
 * @returns {Promise<Object|Array|null>} plain object(s) with user.roleId set
 */
const attachUserRoleId = async (staff) => {
  const isArray = Array.isArray(staff);
  const list = (isArray ? staff : [staff]).filter(Boolean);

  const objs = list.map((s) =>
    typeof s.toObject === "function" ? s.toObject({ virtuals: true }) : s,
  );

  const roles = await Role.find({}).select("_id name").lean();
  const nameToId = new Map(roles.map((r) => [r.name.toLowerCase(), r._id]));

  for (const s of objs) {
    if (s.user && typeof s.user === "object") {
      s.user.roleId = nameToId.get(String(s.user.role || "").toLowerCase()) || null;
    }
  }

  return isArray ? objs : objs[0] || null;
};

module.exports = { attachUserRoleId };
