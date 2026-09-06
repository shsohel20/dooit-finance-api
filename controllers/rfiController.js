// controllers/rfiController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const RFI = require("../models/Rfi");
const Customer = require("../models/Customer");
const Client = require("../models/Client");
const { resolveCaseLinkage, hasLinkageRef, linkageOverrides } = require("../utils/resolveCaseLinkage");
// const User = require("../models/User");
const { fillTemplate } = require("../utils/email-template/rfiTemplates");
const sendEmail = require("../utils/sendEmail");
const { logEvent } = require("../utils/audit");

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

  // Resolve the investigation hub: `caseId` may be a Case id/uid or a legacy
  // Alert id/uid — derive the owning Case + originating Alert.
  const link = await resolveCaseLinkage({ caseId });

  const rfi = await RFI.create({
    case: link.caseId, // Case hub (null until the alert is escalated)
    alert: link.alert, // originating Alert (provenance)
    client: clientId || link.client,
    branch: (branchId || link.branch) || null,
    customer: customerId || link.customer,
    primaryContactName,
    replyToEmail,
    requestedItems,
    metadata,
    settings,
    status: "Draft",
  });

  logEvent({
    req,
    service: "report",
    action: "rfi_created",
    reportType: "RFI",
    target: rfi.uid || String(rfi._id),
    case: rfi.case || null,
    customer: rfi.customer || null,
    afterValue: { status: rfi.status },
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
    .populate("sentBy")
    // Same context the list carries: the Case hub and the originating alert
    .populate({ path: "case", select: "uid title status caseType riskLabel priority linkedTransactions", populate: { path: "linkedTransactions", select: "uid amount currency type status timestamp" } })
    .populate({ path: "alert", select: "uid status caseType riskScore riskLabel priority transaction linkedCase", populate: { path: "transaction", select: "uid amount currency type status timestamp" } });
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

  const prevStatus = rfi.status;
  Object.assign(rfi, req.body);
  if (hasLinkageRef(req.body)) Object.assign(rfi, await linkageOverrides(req.body, "case"));
  await rfi.save();

  logEvent({
    req,
    service: "report",
    action: "rfi_updated",
    reportType: "RFI",
    target: rfi.uid || String(rfi._id),
    case: rfi.case || null,
    customer: rfi.customer || null,
    ...(prevStatus !== rfi.status
      ? { beforeValue: { status: prevStatus }, afterValue: { status: rfi.status } }
      : {}),
  });

  res.status(200).json({ succeed: true, data: rfi });
});

// DELETE RFI
exports.deleteRFI = asyncHandler(async (req, res, next) => {
  const rfi = await RFI.findById(req.params.id);
  if (!rfi)
    return next(
      new ErrorResponse(`RFI not found with id ${req.params.id}`, 404)
    );
  // Snapshot before the delete — this is the only surviving record of the doc.
  const snapshot = {
    uid: rfi.uid,
    status: rfi.status,
    case: rfi.case,
    customer: rfi.customer,
  };
  await rfi.deleteOne();

  logEvent({
    req,
    service: "report",
    action: "rfi_deleted",
    reportType: "RFI",
    target: snapshot.uid || String(rfi._id),
    case: snapshot.case || null,
    customer: snapshot.customer || null,
    beforeValue: snapshot,
  });

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

  // ── Tipping-off control (AML/CTF Act s123) ──────────────────────────────
  // Asking the customer for information while a suspicious matter report about
  // them is being prepared can tip them off, which is an offence. A live SMR on
  // the same case blocks the send outright — the analyst must resolve the SMR
  // first. docs/74 C9.
  const caseId = rfi.case?._id || rfi.case;
  if (caseId) {
    const SMR = require("../models/SmrReport");
    const liveSmr = await SMR.findOne({
      caseId,
      status: { $in: ["review", "approved"] },
    })
      .select("uid status")
      .lean();

    if (liveSmr) {
      // Record the block on the RFI so the UI can explain it without asking again.
      await RFI.updateOne(
        { _id: rfi._id },
        {
          $set: {
            tippingOffWarning: true,
            deliveryBlocked: true,
            deliveryBlockReason: `SMR ${liveSmr.uid} is ${liveSmr.status} on this case.`,
          },
        }
      );
      return next(
        new ErrorResponse(
          `Cannot send: SMR ${liveSmr.uid} is ${liveSmr.status} on this case. Sending an information request now risks tipping off the subject.`,
          409
        )
      );
    }
  }

  const fromStatus = rfi.status;

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
  const caseNumber = rfi.metadata?.caseNumber || rfi.case?.uid || "Unknown";
  const primaryContactName = rfi.client?.contacts?.name || "Unknown";

  // ── Who the letter goes to ───────────────────────────────────────────────
  // An information request is addressed to the CUSTOMER; the reply-to is the
  // reporting entity's compliance mailbox. Both were wrong before: the code
  // read the customer's address and then ignored it, using the reply-to as the
  // recipient and sending every request to one hardcoded personal inbox — so
  // no RFI had ever reached a customer (docs/74 C19).
  const customerEmail = rfi.customer?.user?.email || null;
  const replyTo =
    rfi.replyToEmail || rfi.client?.contacts?.email || rfi.client?.email || process.env.FROM_EMAIL || null;

  // Safety valve for non-production: with RFI_REDIRECT_TO set, every request is
  // delivered to that mailbox instead of the customer, so a staging or demo
  // environment cannot email real people. The intended recipient is still
  // resolved, recorded on the RFI and shown in the audit note.
  const redirectTo = (process.env.RFI_REDIRECT_TO || "").trim() || null;
  const to = redirectTo || customerEmail;

  if (!to) {
    return next(
      new ErrorResponse(
        `No email address on file for ${customerName} — an information request cannot be sent.`,
        400
      )
    );
  }

  const context = {
    clientName,
    customerName,
    caseNumber,
    uid: rfi.uid,
    primaryContactName:
      rfi.primaryContactName || primaryContactName || "Unknown",
    replyToEmail: replyTo,
    requestedItems: rfi.requestedItems.map((it) =>
      typeof it === "string" ? it : it.text
    ),
    responseDeadline: rfi.responseDeadline,
    followupDeadline: rfi.followupDeadline,
    finalDeadline: rfi.finalDeadline,
  };

  const { subject, body } = fillTemplate(type, context);

  try {
    await sendEmail({
      email: to,
      subject,
      message: body,
      replyTo,
    });

    rfi.sentAt = new Date();
    rfi.sentBy = req.user?.id;
    rfi.activityNote.push({
      // Records the real recipient, and says so plainly when a redirect was in
      // force — an audit must never read as though the customer was written to.
      note:
        `RFI ${type} sent to ${to} by ${req.user?.id || "system"}` +
        (redirectTo ? ` (redirected from ${customerEmail || "no customer address"} by RFI_REDIRECT_TO)` : ""),
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

    logEvent({
      req,
      service: "report",
      action: "rfi_sent",
      reportType: "RFI",
      target: rfi.uid || String(rfi._id),
      case: rfi.case?._id || rfi.case || null,
      customer: rfi.customer?._id || rfi.customer || null,
      details: `RFI ${type} sent to ${to}`,
      beforeValue: { status: fromStatus },
      afterValue: { status: rfi.status },
    });

    res.status(200).json({
      succeed: true,
      message: `RFI ${type} email sent to ${to}`,
      data: rfi,
    });
  } catch (err) {
    return next(new ErrorResponse(`Failed to send email: ${err.message}`, 500));
  }
});
