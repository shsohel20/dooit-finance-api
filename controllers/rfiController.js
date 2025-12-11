// controllers/rfiController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const RFI = require("../models/Rfi");
const Customer = require("../models/Customer");
const Client = require("../models/Client");
// const User = require("../models/User");
const { fillTemplate } = require("../utils/email-template/rfiTemplates");
const sendEmail = require("../utils/sendEmail");

/**
 * Basic filter helper if you want POST-based filtering (body)
 * Example: filter by primaryContactName or caseNumber string match
 */
exports.filterRFISection = (doc, requestBody, req) => {
  if (!requestBody) return true;
  if (requestBody.primaryContactName) {
    return (
      doc.primaryContactName &&
      doc.primaryContactName
        .toLowerCase()
        .includes(requestBody.primaryContactName.toLowerCase())
    );
  }
  if (requestBody.caseNumber) {
    return doc.metadata?.caseNumber === requestBody.caseNumber;
  }
  return true;
};

// GET list (advancedResults middleware provides pagination/filtering)
exports.getRFIs = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['RFI']
  #swagger.summary = 'Get All RFI'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  res.status(200).json(res.advancedResults);
});
exports.getRFIsPost = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// CREATE RFI
exports.createRFI = asyncHandler(async (req, res, next) => {
  const {
    caseId,
    // clientId,
    // branchId,
    customerId,
    primaryContactName,
    replyToEmail,
    requestedItems = [],
    metadata = {},
    settings = {},
  } = req.body;
  const clientId = req?.user?.client?._id || null;
  const branchId = req?.user?.branch?._id || null;
  // optional existence checks
  if (clientId) {
    const client = await Client.findById(clientId);
    if (!client) return next(new ErrorResponse("Client not found", 404));
  }
  if (customerId) {
    const customer = await Customer.findById(customerId);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
  }

  const rfi = await RFI.create({
    case: caseId,
    client: clientId,
    branch: branchId || null,
    customer: customerId,
    primaryContactName,
    replyToEmail,
    requestedItems,
    metadata,
    settings,
    status: "Draft",
  });

  res.status(201).json({
    succeed: true,
    data: rfi,
    id: rfi._id,
  });
});

// CREATE DUMMY RFI by names (client/customer lookups)
exports.createDummyRFI = asyncHandler(async (req, res, next) => {
  const { clientName, customerName, primaryContactName, caseNumber } = req.body;

  const client = clientName ? await Client.findOne({ name: clientName }) : null;
  const customer = customerName
    ? await Customer.findOne({ name: customerName })
    : null;

  if (!client) return next(new ErrorResponse("Client not found", 404));
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  const rfi = await RFI.create({
    client: client._id,
    customer: customer._id,
    primaryContactName: primaryContactName || "",
    replyToEmail: customer.email || "" || undefined,
    requestedItems: [
      { text: "Proof of funds / SOF for Transaction 1" },
      { text: "Basic counterparty details for Transaction 1" },
    ],
    metadata: { caseNumber: caseNumber || `DUMMY-${Date.now()}` },
    status: "Pending",
  });

  res.status(201).json({
    succeed: true,
    data: rfi,
    id: rfi._id,
  });
});

// GET single RFI
exports.getRFI = asyncHandler(async (req, res, next) => {
  const rfi = await RFI.findById(req.params.id)
    .populate("client")
    .populate("customer")
    .populate("sentBy");
  if (!rfi)
    return next(
      new ErrorResponse(`RFI not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: rfi });
});

// UPDATE RFI
exports.updateRFI = asyncHandler(async (req, res, next) => {
  const rfiId = req.params.id;
  const rfi = await RFI.findById(rfiId);
  if (!rfi)
    return next(new ErrorResponse(`RFI not found with id ${rfiId}`, 404));

  Object.assign(rfi, req.body);
  await rfi.save();

  res.status(200).json({ succeed: true, data: rfi });
});

// DELETE RFI
exports.deleteRFI = asyncHandler(async (req, res, next) => {
  const rfi = await RFI.findById(req.params.id);
  if (!rfi)
    return next(
      new ErrorResponse(`RFI not found with id ${req.params.id}`, 404)
    );
  await rfi.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});

/**
 * Send RFI email (initial | followup | final)
 * Route: PUT /api/v1/rfis/:id/send?type=initial
 * Body optional: override clientName, customerName, replyToEmail, requestedItems (array)
 */
exports.sendRFI = asyncHandler(async (req, res, next) => {
  const rfiId = req.params.id;
  const type = (req.query.type || "initial").toLowerCase(); // initial | followup | final
  if (!["initial", "followup", "final"].includes(type)) {
    return next(new ErrorResponse("Invalid type param", 400));
  }

  const rfi = await RFI.findById(rfiId).populate([
    { path: "case" },
    { path: "client" },
    { path: "branch" },
    { path: "customer", populate: { path: "user" } },
  ]);
  // if (rfi) {
  //   res.status(200).json({
  //     succeed: true,
  //     message: `RFI ${type} email sent to `,
  //     data: rfi,
  //   });
  //   next();
  // }
  if (!rfi)
    return next(new ErrorResponse(`RFI not found with id ${rfiId}`, 404));

  // compute deadlines if missing
  const now = new Date();
  if (type === "initial") {
    rfi.responseDeadline =
      rfi.responseDeadline ||
      new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    rfi.followupDeadline =
      rfi.followupDeadline ||
      new Date(now.getTime() + (14 + 7) * 24 * 60 * 60 * 1000);
    rfi.finalDeadline =
      rfi.finalDeadline ||
      new Date(now.getTime() + (14 + 7 + 7) * 24 * 60 * 60 * 1000);
    rfi.status = "Sent";
  } else if (type === "followup") {
    rfi.followupDeadline = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    rfi.status = "Pending FollowUp";
  } else if (type === "final") {
    rfi.finalDeadline = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    rfi.status = "Final Notice";
  }

  const clientName = rfi.client?.name || "Unknown";
  const customerName = rfi.customer?.user?.name || "Unknown";
  const email = rfi.customer?.user?.email;
  const caseNumber = rfi.metadata?.caseNumber || rfi.case?.uid || "Unknown";
  const primaryContactName = rfi.client?.contacts?.name || "Unknown";
  const replyToEmail = rfi.client?.contacts?.email || "Unknown";

  const context = {
    clientName,
    customerName,
    caseNumber,
    uid: rfi.uid,
    primaryContactName:
      rfi.primaryContactName || primaryContactName || "Unknown",
    replyToEmail: rfi.replyToEmail || replyToEmail,
    requestedItems: rfi.requestedItems.map((it) =>
      typeof it === "string" ? it : it.text
    ),
    responseDeadline: rfi.responseDeadline,
    followupDeadline: rfi.followupDeadline,
    finalDeadline: rfi.finalDeadline,
  };

  const { subject, body } = fillTemplate(type, context);

  // send email (text body)
  const to = context.replyToEmail;
  if (!to)
    return next(
      new ErrorResponse("Reply-To/recipient email not configured for RFI", 400)
    );

  try {
    await sendEmail({
      email: "shsohel.tc@gmail.com",
      subject,
      message: body,
      replyTo: context.replyToEmail,
    });

    rfi.sentAt = new Date();
    rfi.sentBy = req.user?.id;
    rfi.activityNote.push({
      note: `RFI ${type} sent to ${to} by ${req.user?.id || "system"}`,
      by: req.user?.id,
    });

    // store simple SEC_LOG reference as per your PDF note
    rfi.metadata = rfi.metadata || {};
    rfi.metadata.secLog = rfi.metadata.secLog || [];
    rfi.metadata.secLog.push({
      type,
      code: "SEC_LOG_003",
      action: `RFI_${type}_sent`,
      by: req.user?.id,
      at: new Date(),
    });

    await rfi.save();

    res.status(200).json({
      succeed: true,
      message: `RFI ${type} email sent to ${email}`,
      data: rfi,
    });
  } catch (err) {
    return next(new ErrorResponse(`Failed to send email: ${err.message}`, 500));
  }
});
