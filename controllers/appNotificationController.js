const asyncHandler = require("../middleware/async");
const AppNotification = require("../models/AppNotification");
const NotificationRule = require("../models/NotificationRule");
const ErrorResponse = require("../utils/errorResponse");

const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// @route GET /api/v1/app-notifications
exports.listNotifications = asyncHandler(async (req, res) => {
  const { unread, urgency, limit = 50, page = 1 } = req.query;
  const filter = { client: getClient(req), dismissed: false };
  if (req.user?.id) filter.recipient = req.user.id;
  if (unread === "true") filter.read = false;
  if (urgency) filter.urgency = urgency;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [docs, total] = await Promise.all([
    AppNotification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    AppNotification.countDocuments(filter),
  ]);

  const unreadCount = await AppNotification.countDocuments({ ...filter, read: false });
  res.status(200).json({ success: true, total, unreadCount, data: docs });
});

// @route PUT /api/v1/app-notifications/:id/read
exports.markRead = asyncHandler(async (req, res, next) => {
  const n = await AppNotification.findByIdAndUpdate(
    req.params.id,
    { read: true, readAt: new Date() },
    { new: true }
  );
  if (!n) return next(new ErrorResponse("Notification not found", 404));
  res.status(200).json({ success: true, data: n });
});

// @route PUT /api/v1/app-notifications/read-all
exports.markAllRead = asyncHandler(async (req, res) => {
  const filter = { client: getClient(req), read: false };
  if (req.user?.id) filter.recipient = req.user.id;
  await AppNotification.updateMany(filter, { read: true, readAt: new Date() });
  res.status(200).json({ success: true, message: "All notifications marked read" });
});

// @route DELETE /api/v1/app-notifications/:id
exports.dismiss = asyncHandler(async (req, res, next) => {
  const n = await AppNotification.findByIdAndUpdate(req.params.id, { dismissed: true }, { new: true });
  if (!n) return next(new ErrorResponse("Notification not found", 404));
  res.status(200).json({ success: true, data: {} });
});

// @route GET /api/v1/app-notifications/rules
exports.listRules = asyncHandler(async (req, res) => {
  const { active, urgency } = req.query;
  const filter = {};
  if (active !== undefined) filter.active = active === "true";
  if (urgency) filter.urgency = urgency;
  const rules = await NotificationRule.find(filter).sort({ notifId: 1 });
  res.status(200).json({ success: true, count: rules.length, data: rules });
});

// @route PUT /api/v1/app-notifications/rules/:id
exports.updateRule = asyncHandler(async (req, res, next) => {
  const allowed = ["active","repeating","repeatIntervalDays","deliveryChannels","bodyTemplate","urgency"];
  const update = {};
  allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  const rule = await NotificationRule.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!rule) return next(new ErrorResponse("Rule not found", 404));
  res.status(200).json({ success: true, data: rule });
});
