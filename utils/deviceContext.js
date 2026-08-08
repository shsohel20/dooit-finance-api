"use strict";

const crypto = require("crypto");
const UAParser = require("ua-parser-js");
const Device = require("../models/Device");

/**
 * Client IP resolution that works with or without `trust proxy`:
 * prefer the left-most X-Forwarded-For hop, then req.ip / socket.
 */
const getClientIp = (req) => {
  const xff = req.headers?.["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
};

const uaDeviceType = (ua, parsedType) => {
  if (parsedType === "mobile") return "mobile";
  if (parsedType === "tablet") return "tablet";
  if (!ua) return "unknown";
  // Non-browser clients (curl, axios, Postman, server-to-server)
  if (/curl|axios|postman|node|python|okhttp|insomnia/i.test(ua)) return "server";
  return "desktop";
};

/**
 * Build the request's device context once; safe on any request.
 * Device identity: a client-provided persistent id (x-device-id header)
 * beats a coarse fingerprint of user-agent + IP.
 */
const getDeviceContext = (req) => {
  const userAgent = req.get?.("user-agent") || req.headers?.["user-agent"] || null;
  const ipAddress = getClientIp(req);
  const parsed = new UAParser(userAgent || "").getResult();

  const provided = req.headers?.["x-device-id"];
  const deviceId =
    (provided && String(provided).slice(0, 128)) ||
    "fp_" +
      crypto
        .createHash("sha256")
        .update(`${userAgent || "unknown"}|${ipAddress || "unknown"}`)
        .digest("hex")
        .slice(0, 32);

  return {
    deviceId,
    deviceType: uaDeviceType(userAgent, parsed.device?.type),
    os: parsed.os?.name || null,
    osVersion: parsed.os?.version || null,
    browser: parsed.browser?.name || null,
    browserVersion: parsed.browser?.version || null,
    ipAddress,
    userAgent,
    timezone: req.headers?.["x-timezone"] || null,
  };
};

/**
 * Upsert the device registry row for this actor + device and bump counters.
 * One row per { deviceId, user } (unique sparse index on Device);
 * per-event history belongs in AuditLog, not here.
 *
 * Fire-and-forget safe: never throws.
 *
 * @param {object} opts
 * @param {object} opts.req      Express request
 * @param {string} [opts.userId]     Users._id of the actor (defaults to req.user)
 * @param {string} [opts.customerId] Customer._id when the actor is a customer
 * @param {string} opts.purpose  Device purpose enum (login, transaction, admin_action, …)
 * @param {object} [opts.details] extra metadata about the event
 * @returns {Promise<object|null>} the Device doc (lean) or null on failure
 */
const recordDevice = async ({
  req,
  userId,
  customerId,
  purpose = "other",
  details,
  client: clientOverride,
  branch: branchOverride,
}) => {
  try {
    const ctx = getDeviceContext(req);
    const user = userId ?? req.user?._id ?? req.user?.id ?? null;
    const client =
      clientOverride ?? req.user?.client?._id ?? req.user?.clientBelongs ?? null;
    const branch =
      branchOverride ?? req.user?.branch?._id ?? req.user?.branchBelongs ?? null;

    const now = new Date();
    const $set = {
      deviceType: ctx.deviceType,
      os: ctx.os,
      osVersion: ctx.osVersion,
      browser: ctx.browser,
      browserVersion: ctx.browserVersion,
      ipAddress: ctx.ipAddress,
      purpose,
      ...(ctx.timezone && { timezone: ctx.timezone }),
      ...(customerId && { customer: customerId }),
      ...(client && { client }),
      ...(branch && { branch }),
      ...(details && { details }),
    };
    const $inc = {};
    if (purpose === "login") {
      $set.lastLoginAt = now;
      $inc.loginCount = 1;
    }
    if (purpose === "transaction") {
      $set.lastTransactionAt = now;
      $inc.transactionCount = 1;
    }

    const device = await Device.findOneAndUpdate(
      { deviceId: ctx.deviceId, user },
      {
        $set,
        ...(Object.keys($inc).length && { $inc }),
        $setOnInsert: { uid: `DE_${Date.now()}` },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    return device;
  } catch (err) {
    console.error("recordDevice failed:", err.message);
    return null;
  }
};

module.exports = { getClientIp, getDeviceContext, recordDevice };
