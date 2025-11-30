const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const TTR = require("../models/TtrReport");
const sendEmail = require("../utils/sendEmail");
const { fillTemplate } = require("../utils/email-template/rfiTemplates");

// Simple filter helper for POST filtering
exports.filterTTRSection = (doc, requestBody = {}) => {
  if (requestBody.uid) {
    return doc.uid?.toLowerCase().includes(requestBody.uid.toLowerCase());
  }
  if (requestBody.customerName) {
    const name = doc.partA?.[0]?.customers?.fullName || "";
    return name.toLowerCase().includes(requestBody.customerName.toLowerCase());
  }
  return true;
};

// GET list
exports.getTTRs = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});
exports.getTTRsPost = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// CREATE
exports.createTTR = asyncHandler(async (req, res, next) => {
  const body = req.body || {};
  if (!body.partA || !body.partB || !body.partC || !body.partD) {
    return next(new ErrorResponse("Missing required TTR parts", 400));
  }

  const ttr = await TTR.create({
    completionDate: body.completionDate,
    referenceNumber: body.referenceNumber,
    partA: body.partA,
    partB: body.partB,
    partC: body.partC,
    partD: body.partD,
    metadata: {
      ...body.metadata,
      createdBy: req.user?.id,
      version: body.metadata?.version || "1.0",
    },
    status: body.status || "draft",
  });

  // Add workflow history
  ttr.metadata = ttr.metadata || {};
  ttr.metadata.workflowHistory = ttr.metadata.workflowHistory || [];
  ttr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created",
    fromStatus: null,
    toStatus: ttr.status,
    notes: body.metadata?.notes || "Created via API",
  });
  await ttr.save();

  res.status(201).json({ succeed: true, data: ttr, id: ttr._id });
});

// CREATE DUMMY
exports.createDummyTTR = asyncHandler(async (req, res, next) => {
  const { primaryName = "John Doe" } = req.body;

  const ttr = await TTR.create({
    referenceNumber: `TTR-${Date.now()}`,
    partA: [
      {
        customers: {
          fullName: primaryName,
          businessAddress: {
            fullStreetAddress: "123 Street",
            city: "Sydney",
            state: "NSW",
            postcode: "2000",
          },
          phoneNumbers: ["+61234567890"],
          emailAddresses: ["dummy@example.com"],
          businessStructure: "individual",
        },
        transactionConductMethod: "individual",
        transactionConductDescription: "Dummy transaction",
      },
    ],
    partB: {
      type: "customer",
      details: {
        fullName: primaryName,
      },
    },
    partC: {
      transaction: {
        date: new Date(),
        referenceNumber: `TX-${Date.now()}`,
        totalAmount: { amount: 1000 },
        designatedService: "funds-transfer",
      },
      recipients: [],
    },
    partD: {
      identificationNumber: "BR001",
      name: "Dummy Branch",
      branch: {
        identificationNumber: "BR001",
        name: "Main Branch",
        address: {
          fullStreetAddress: "123 Street",
          city: "Sydney",
          state: "NSW",
          postcode: "2000",
        },
      },
      personCompleting: {
        name: req.user?.name || "System",
        jobTitle: "Analyst",
        phone: "",
        email: req.user?.email || "",
        date: new Date(),
      },
    },
    metadata: { createdBy: req.user?.id },
    status: "draft",
  });

  ttr.metadata.workflowHistory = ttr.metadata.workflowHistory || [];
  ttr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created_dummy",
    fromStatus: null,
    toStatus: ttr.status,
    notes: `Dummy created`,
  });
  await ttr.save();

  res.status(201).json({ succeed: true, data: ttr, id: ttr._id });
});

// GET single
exports.getTTR = asyncHandler(async (req, res, next) => {
  const ttr = await TTR.findById(req.params.id);
  if (!ttr)
    return next(
      new ErrorResponse(`TTR not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: ttr });
});

// UPDATE
exports.updateTTR = asyncHandler(async (req, res, next) => {
  const ttr = await TTR.findById(req.params.id);
  if (!ttr)
    return next(
      new ErrorResponse(`TTR not found with id ${req.params.id}`, 404)
    );

  Object.assign(ttr, req.body);
  ttr.metadata = ttr.metadata || {};
  ttr.metadata.updatedBy = req.user?.id;
  ttr.metadata.workflowHistory = ttr.metadata.workflowHistory || [];
  ttr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "updated",
    fromStatus: ttr.status,
    toStatus: ttr.status,
    notes: req.body.metadata?.notes || "Updated via API",
  });

  await ttr.save();
  res.status(200).json({ succeed: true, data: ttr });
});

// DELETE
exports.deleteTTR = asyncHandler(async (req, res, next) => {
  const ttr = await TTR.findById(req.params.id);
  if (!ttr)
    return next(
      new ErrorResponse(`TTR not found with id ${req.params.id}`, 404)
    );
  await ttr.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});

// SUBMIT (draft -> submitted) with optional email notification
exports.submitTTR = asyncHandler(async (req, res, next) => {
  const ttr = await TTR.findById(req.params.id);
  if (!ttr)
    return next(
      new ErrorResponse(`TTR not found with id ${req.params.id}`, 404)
    );

  const from = ttr.status;
  ttr.status = "submitted";
  ttr.metadata.submissionDate = new Date();
  ttr.metadata.updatedBy = req.user?.id;
  ttr.metadata.workflowHistory = ttr.metadata.workflowHistory || [];
  ttr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "submitted",
    fromStatus: from,
    toStatus: ttr.status,
    notes: req.body.notes || "Submitted for review",
  });

  await ttr.save();

  // optionally send notification email
  if (req.body.notify && req.body.notifyEmail) {
    const content = fillTemplate("submitTTR", ttr, {
      submittedBy: req.user?.name || "System",
      submittedAt: ttr.metadata.submissionDate,
    });

    await sendEmail({
      to: req.body.notifyEmail,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  }

  res.status(200).json({ succeed: true, data: ttr });
});

// APPROVE
exports.approveTTR = asyncHandler(async (req, res, next) => {
  const ttr = await TTR.findById(req.params.id);
  if (!ttr)
    return next(
      new ErrorResponse(`TTR not found with id ${req.params.id}`, 404)
    );

  const from = ttr.status;
  ttr.status = "approved";
  ttr.metadata.updatedBy = req.user?.id;
  ttr.metadata.workflowHistory = ttr.metadata.workflowHistory || [];
  ttr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "approved",
    fromStatus: from,
    toStatus: ttr.status,
    notes: req.body.notes || "Approved",
  });

  await ttr.save();
  res.status(200).json({ succeed: true, data: ttr });
});
