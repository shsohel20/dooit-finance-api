"use strict";

const { getDeviceContext } = require("./deviceContext");

/**
 * Device/network context for an AuditLog entry.
 * Cheap (no DB access) — safe to call on every audit write.
 * Pass a Device _id as `deviceRef` when a registry row is at hand
 * (e.g. right after recordDevice on login).
 *
 * @param {object} req  Express request (may be undefined in jobs → all nulls)
 * @param {object} [deviceRef]  Device._id
 * @returns {{ ip, userAgent, deviceId, device }}
 */
const auditContext = (req, deviceRef) => {
  if (!req) return { ip: null, userAgent: null, deviceId: null, device: deviceRef ?? null };
  const ctx = getDeviceContext(req);
  return {
    ip: ctx.ipAddress,
    userAgent: ctx.userAgent,
    deviceId: ctx.deviceId,
    device: deviceRef ?? null,
  };
};

module.exports = { auditContext };
