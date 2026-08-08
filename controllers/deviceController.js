"use strict";

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Device = require("../models/Device");
const AuditLog = require("../models/AuditLog");
const { auditContext } = require("../utils/auditContext");

// Tenancy guard for single-device reads/writes: a tenant-scoped user may only
// touch devices in their own client/branch; dooit (no tenant) is unscoped.
const checkDeviceAccess = (device, req) => {
  const client = req.user?.client?._id ?? req.user?.clientBelongs ?? null;
  const branch = req.user?.branch?._id ?? req.user?.branchBelongs ?? null;
  if (client && device.client && String(device.client) !== String(client)) {
    return new ErrorResponse("Device not in your tenant", 403);
  }
  if (branch && device.branch && String(device.branch) !== String(branch)) {
    return new ErrorResponse("Device not in your branch", 403);
  }
  return null;
};

// ── GET /devices ──────────────────────────────────────────────────────────────
// List devices. advancedResults auto-scopes on client/branch from req.user
// (dooit → unscoped, sees every tenant). Supports ?user= ?customer=
// ?deviceType= ?purpose= ?isTrusted= plus the standard select/sort/page/limit.
// @access DEVICE.GET
exports.getDevices = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// ── GET /devices/me ───────────────────────────────────────────────────────────
// The calling user's own devices — any authenticated user, no module grant.
// @access Private
exports.getMyDevices = asyncHandler(async (req, res, next) => {
  const devices = await Device.find({ user: req.user._id ?? req.user.id })
    .sort({ updatedAt: -1 })
    .lean();
  res.status(200).json({ success: true, count: devices.length, data: devices });
});

// ── GET /devices/:id ──────────────────────────────────────────────────────────
// Device detail + its recent audit trail (matched on deviceId string, so
// entries written before the registry row resolve too).
// @access DEVICE.GET
exports.getDeviceById = asyncHandler(async (req, res, next) => {
  const device = await Device.findById(req.params.id)
    .populate("user", "name email photoUrl")
    .populate("customer", "uid personalKyc kycStatus")
    .populate("client", "name")
    .populate("branch", "name")
    .lean();

  if (!device) {
    return next(new ErrorResponse("Device not found", 404));
  }
  const denied = checkDeviceAccess(device, req);
  if (denied) return next(denied);

  const recentActivity = await AuditLog.find({ deviceId: device.deviceId })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate("user", "name email")
    .populate("actor", "name email")
    .select("service action details status ip createdAt user actor case customer")
    .lean();

  res.status(200).json({ success: true, data: { ...device, recentActivity } });
});

// ── PATCH /devices/:id/trust ──────────────────────────────────────────────────
// Mark a device trusted/untrusted and manage risk flags.
// Body: { isTrusted?: boolean, riskFlags?: string[] }
// @access DEVICE.EDIT
exports.updateDeviceTrust = asyncHandler(async (req, res, next) => {
  const device = await Device.findById(req.params.id);
  if (!device) {
    return next(new ErrorResponse("Device not found", 404));
  }
  const denied = checkDeviceAccess(device, req);
  if (denied) return next(denied);

  const before = { isTrusted: device.isTrusted, riskFlags: device.riskFlags };

  if (typeof req.body.isTrusted === "boolean") device.isTrusted = req.body.isTrusted;
  if (Array.isArray(req.body.riskFlags)) {
    device.riskFlags = req.body.riskFlags.map((f) => String(f).trim()).filter(Boolean);
  }
  await device.save();

  AuditLog.create({
    service: "device",
    action: "device_trust_updated",
    details: `Device ${device.uid || device.deviceId} trust updated`,
    user: req.user._id ?? req.user.id,
    client: device.client,
    branch: device.branch,
    beforeValue: before,
    afterValue: { isTrusted: device.isTrusted, riskFlags: device.riskFlags },
    ...auditContext(req, device._id),
  }).catch((err) => console.error("device trust audit failed:", err.message));

  res.status(200).json({ success: true, data: device });
});
