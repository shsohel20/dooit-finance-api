// controllers/contactController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Contact = require("../models/Contact");
const {
  contactAdminHtml,
  contactUserHtml,
  contactText,
} = require("../utils/email-template/contactEmailTemplate");
const sendEmail = require("../utils/sendEmail");

/**
 * Create contact / support message (public)
 * POST /api/v1/contact/new
 * body: { name, email, subject, message, utm }
 */
exports.createContact = asyncHandler(async (req, res, next) => {
  const { name, email, subject, message, utm } = req.body || {};

  if (!name || !email || !subject || !message) {
    return next(
      new ErrorResponse("name, email, subject and message are required", 400)
    );
  }

  const payload = {
    name: String(name).trim(),
    email: String(email).trim().toLowerCase(),
    subject: String(subject).trim(),
    message: String(message).trim(),
    utm: utm || {},
    metadata: {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      referer: req.get("referer"),
    },
  };

  const contact = await Contact.create(payload);

  // Admin notification (non-blocking)
  (async () => {
    try {
      const adminTo = process.env.DEFAULT_NOTIFICATION_EMAIL;
      if (adminTo) {
        await sendEmail({
          email: adminTo,
          subject: `New contact message: ${contact.subject}`,
          message: contactAdminHtml(contact),
          text: contactText(contact),
        });
      }
    } catch (err) {
      console.warn("Contact create: admin email failed", err);
    }
  })();

  // User confirmation (non-blocking)
  (async () => {
    try {
      await sendEmail({
        email: contact.email,
        subject: `We received your message`,
        message: contactUserHtml(contact),
        text: `Hi ${contact.name}, thanks for reaching out. We received your message and will get back to you shortly.`,
        replyTo:
          process.env.SUPPORT_EMAIL || process.env.DEFAULT_NOTIFICATION_EMAIL,
      });
    } catch (err) {
      console.warn("Contact create: user confirmation email failed", err);
    }
  })();

  return res
    .status(201)
    .json({ succeed: true, data: contact, id: contact._id });
});

// Admin: list contacts
exports.getContacts = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// Admin: get single contact
exports.getContact = asyncHandler(async (req, res, next) => {
  const contact = await Contact.findById(req.params.id);
  if (!contact)
    return next(
      new ErrorResponse(`Contact not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: contact });
});

// Admin: delete contact
exports.deleteContact = asyncHandler(async (req, res, next) => {
  const contact = await Contact.findById(req.params.id);
  if (!contact)
    return next(
      new ErrorResponse(`Contact not found with id ${req.params.id}`, 404)
    );
  await contact.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});
