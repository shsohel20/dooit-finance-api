// controllers/leadController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Lead = require("../models/Lead");
const {
  leadAdminHtml,
  leadUserHtml,
  leadText,
} = require("../utils/email-template/leadEmailTemplate");
const advancedResults = require("../middleware/advancedResults");
const sendEmail = require("../utils/sendEmail");

/**
 * Create a lead (public form endpoint)
 * POST /api/v1/leads/new
 * body: { firstName,lastName,email,zipCode,phoneNumber,businessName,industry,annualRevenue,consent,utm }
 */
exports.createLead = asyncHandler(async (req, res, next) => {
  const {
    firstName,
    lastName,
    email,
    zipCode,
    phoneNumber,
    businessName,
    industry,
    annualRevenue,
    consent,
    utm,
    source,
  } = req.body || {};

  // basic validation
  if (!firstName || !lastName || !email) {
    return next(
      new ErrorResponse("firstName, lastName and email are required", 400)
    );
  }

  // build payload
  const payload = {
    firstName: String(firstName).trim(),
    lastName: String(lastName).trim(),
    email: String(email).trim().toLowerCase(),
    zipCode: zipCode ? String(zipCode).trim() : "",
    phoneNumber: phoneNumber ? String(phoneNumber).trim() : "",
    businessName: businessName ? String(businessName).trim() : "",
    industry: industry ? String(industry).trim() : "",
    annualRevenue: annualRevenue ? String(annualRevenue).trim() : "",
    consent: !!consent,
    utm: utm || {},
    source: source || "web-form",
    metadata: {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      referer: req.get("referer"),
    },
  };

  // Save
  const lead = await Lead.create(payload);

  // send emails (non-blocking: we try/catch but don't fail lead creation if email fails)
  const adminTo = [process.env.DEFAULT_NOTIFICATION_EMAIL];

  // send admin notification
  (async () => {
    try {
      if (adminTo && adminTo.length) {
        await sendEmail({
          email: adminTo.join(","),
          subject: `New lead: ${lead.firstName} ${lead.lastName}`,
          message: leadAdminHtml(lead),
          text: leadText(lead),
        });
      }
    } catch (err) {
      console.warn("Lead create: admin email failed", err);
    }
  })();

  // send user confirmation (if email present)
  (async () => {
    try {
      if (lead.email) {
        await sendEmail({
          email: lead.email,
          subject: `Thanks — we received your enquiry`,
          message: leadUserHtml(lead),
          text: `Thanks ${lead.firstName}, we received your enquiry. Someone will contact you soon.`,
          replyTo:
            process.env.SUPPORT_EMAIL || process.env.DEFAULT_NOTIFICATION_EMAIL,
        });
      }
    } catch (err) {
      console.warn("Lead create: user confirmation email failed", err);
    }
  })();

  return res.status(201).json({ succeed: true, data: lead, id: lead._id });
});

// Admin: list leads (protected)
exports.getLeads = asyncHandler(async (req, res, next) => {
  // advancedResults middleware should populate res.advancedResults
  res.status(200).json(res.advancedResults);
});

// Admin: get single lead
exports.getLead = asyncHandler(async (req, res, next) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead)
    return next(
      new ErrorResponse(`Lead not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: lead });
});

// Admin: delete lead
exports.deleteLead = asyncHandler(async (req, res, next) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead)
    return next(
      new ErrorResponse(`Lead not found with id ${req.params.id}`, 404)
    );
  await lead.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});
