// controllers/newsletterController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const NewsletterSubscription = require("../models/NewsletterSubscription");
const {
  newsletterAdminHtml,
  newsletterUserHtml,
  newsletterText,
} = require("../utils/email-template/newsletterEmailTemplate");
const sendEmail = require("../utils/sendEmail");

/**
 * Subscribe to newsletter (public)
 * POST /api/v1/newsletter/subscribe
 * body: { email, utm }
 */
exports.subscribe = asyncHandler(async (req, res, next) => {
  const { email, utm } = req.body || {};

  if (!email) {
    return next(new ErrorResponse("email is required", 400));
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  // If already subscribed, re-activate silently and return success
  const existing = await NewsletterSubscription.findOne({
    email: normalizedEmail,
  });

  if (existing) {
    if (existing.status === "unsubscribed") {
      existing.status = "active";
      existing.utm = utm || existing.utm;
      existing.metadata = {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        referer: req.get("referer"),
      };
      await existing.save();
    }
    return res
      .status(200)
      .json({ succeed: true, data: existing, id: existing._id });
  }

  const payload = {
    email: normalizedEmail,
    utm: utm || {},
    metadata: {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      referer: req.get("referer"),
    },
  };

  const sub = await NewsletterSubscription.create(payload);

  // Admin notification (non-blocking)
  (async () => {
    try {
      const adminTo = process.env.DEFAULT_NOTIFICATION_EMAIL;
      if (adminTo) {
        await sendEmail({
          email: adminTo,
          subject: `New newsletter subscriber: ${sub.email}`,
          message: newsletterAdminHtml(sub),
          text: newsletterText(sub),
        });
      }
    } catch (err) {
      console.warn("Newsletter subscribe: admin email failed", err);
    }
  })();

  // User confirmation (non-blocking)
  (async () => {
    try {
      await sendEmail({
        email: sub.email,
        subject: `You're subscribed to our newsletter`,
        message: newsletterUserHtml(sub),
        text: `Thanks for subscribing! We'll keep you posted on the latest updates.`,
        replyTo:
          process.env.SUPPORT_EMAIL || process.env.DEFAULT_NOTIFICATION_EMAIL,
      });
    } catch (err) {
      console.warn("Newsletter subscribe: user confirmation email failed", err);
    }
  })();

  return res.status(201).json({ succeed: true, data: sub, id: sub._id });
});

// Admin: list subscriptions
exports.getSubscriptions = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// Admin: get single subscription
exports.getSubscription = asyncHandler(async (req, res, next) => {
  const sub = await NewsletterSubscription.findById(req.params.id);
  if (!sub)
    return next(
      new ErrorResponse(
        `Subscription not found with id ${req.params.id}`,
        404
      )
    );
  res.status(200).json({ succeed: true, data: sub });
});

// Admin: delete subscription
exports.deleteSubscription = asyncHandler(async (req, res, next) => {
  const sub = await NewsletterSubscription.findById(req.params.id);
  if (!sub)
    return next(
      new ErrorResponse(
        `Subscription not found with id ${req.params.id}`,
        404
      )
    );
  await sub.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});
