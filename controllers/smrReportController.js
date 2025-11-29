// controllers/smrController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const SMR = require("../models/SmrReport");
const { fillTemplate } = require("../utils/email-template/rfiTemplates");
const sendEmail = require("../utils/sendEmail");

// simple filter helper (for advancedResults POST filtering)
exports.filterSMRSection = (doc, requestBody = {}) => {
  if (requestBody.reportId) {
    return (
      doc.reportId &&
      doc.reportId.toLowerCase().includes(requestBody.reportId.toLowerCase())
    );
  }
  if (requestBody.primaryName) {
    const name = doc.partC?.personOrganisation?.[0]?.name || "";
    return name.toLowerCase().includes(requestBody.primaryName.toLowerCase());
  }
  return true;
};

// GET list
exports.getSMRs = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});
exports.getSMRsPost = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// CREATE
exports.createSMR = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  // minimal validation: ensure required parts exist
  const body = req.body || {};
  if (
    !body.partA ||
    !body.partB ||
    !body.partC ||
    !body.partD ||
    !body.partE ||
    !body.partF ||
    !body.partG ||
    !body.partH
  ) {
    return next(new ErrorResponse("Missing required SMR parts", 400));
  }

  // create
  const smr = await SMR.create({
    client,
    branch,
    reportId: body.reportId,
    partA: body.partA,
    partB: body.partB,
    partC: body.partC,
    partD: body.partD,
    partE: body.partE,
    partF: body.partF,
    partG: body.partG,
    partH: body.partH,
    metadata: {
      ...body.metadata,
      createdBy: req.user?.id,
      version: body.metadata?.version || "1.0",
    },
    status: body.status || "draft",
  });

  // add initial workflow event
  smr.metadata = smr.metadata || {};
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created",
    fromStatus: null,
    toStatus: smr.status,
    notes: body.metadata?.notes || "Created via API",
  });
  await smr.save();

  res.status(201).json({ succeed: true, data: smr, id: smr._id });
});

// CREATE DUMMY
exports.createDummySMR = asyncHandler(async (req, res, next) => {
  const {
    primaryName = "John Doe",
    caseNumber = `DUMMY-${Date.now()}`,
    clientName,
  } = req.body;

  const smr = await SMR.create({
    reportId: `D-${Date.now()}`,
    partA: {
      designatedServices: ["Remittance services (money transfers)"],
      serviceStatus: "provided",
      suspicionReasons: ["Unusual transfer"],
      otherReasons: [],
    },
    partB: {
      groundsForSuspicion:
        "Large unexplained remittance to high-risk jurisdiction",
    },
    partC: {
      personOrganisation: {
        name: primaryName,
        businessAddress: {},
        isCustomer: true,
      },
    },
    partD: { hasOtherParties: false, otherParties: [] },
    partE: { hasUnidentifiedPersons: false, unidentifiedPersons: [] },
    partF: { transactions: [] },
    partG: {
      likelyOffence: ["Money laundering"],
      previousReports: [],
      otherGovernmentBodies: [],
      attachments: [],
    },
    partH: {
      reportingEntity: {
        name: clientName || process.env.FIRM_NAME || "Client",
        address: {},
        completedBy: {
          name: req.user?.name || "System",
          jobTitle: "Analyst",
          phone: "",
          email: req.user?.email || "",
        },
      },
    },
    metadata: { createdBy: req.user?.id, submissionDate: null },
    status: "draft",
  });

  smr.metadata = smr.metadata || {};
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created_dummy",
    fromStatus: null,
    toStatus: smr.status,
    notes: `Dummy created - ${caseNumber}`,
  });
  await smr.save();

  res.status(201).json({ succeed: true, data: smr, id: smr._id });
});

// GET single
exports.getSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: smr });
});

// UPDATE
exports.updateSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );

  Object.assign(smr, req.body);
  smr.metadata = smr.metadata || {};
  smr.metadata.updatedBy = req.user?.id;
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "updated",
    fromStatus: smr.status,
    toStatus: smr.status,
    notes: req.body.metadata?.notes || "Updated via API",
  });

  await smr.save();
  res.status(200).json({ succeed: true, data: smr });
});

// DELETE
exports.deleteSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );
  await smr.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});

// SUBMIT (change status draft -> review and optionally send email)
exports.submitSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );

  const from = smr.status;
  smr.status = "review";
  smr.metadata.submissionDate = new Date();
  smr.metadata.updatedBy = req.user?.id;
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "submitted",
    fromStatus: from,
    toStatus: smr.status,
    notes: req.body.notes || "Submitted for review",
  });

  await smr.save();

  // optionally send notification email
  if (req.body.notify && req.body.notifyEmail) {
    const content = fillTemplate("submit", smr, {
      submittedBy: req.user?.name,
      submittedAt: smr.metadata.submissionDate,
    });
    await sendEmail({
      to: req.body.notifyEmail,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  }

  res.status(200).json({ succeed: true, data: smr });
});

// APPROVE
exports.approveSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );
  const from = smr.status;
  smr.status = "approved";
  smr.metadata.updatedBy = req.user?.id;
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "approved",
    fromStatus: from,
    toStatus: smr.status,
    notes: req.body.notes || "Approved",
  });
  await smr.save();

  res.status(200).json({ succeed: true, data: smr });
});
