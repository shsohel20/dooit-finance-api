// controllers/notifyController.js
const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Notify = require("../models/Notify");
const { default: axios } = require("axios");
const Alert = require("../models/Alert");
const reportAPI_risk = process.env.REPORT_AI_API_RISK;
const reportAPI_eccd = process.env.REPORT_AI_API_ECCD;

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Simple filter helper (for advancedResults POST filtering)
 * If requestBody contains uid or notifyFor we can filter
 */
exports.filterNotifySection = (doc, requestBody = {}) => {
  if (requestBody.uid) {
    return (
      doc.uid && doc.uid.toLowerCase().includes(requestBody.uid.toLowerCase())
    );
  }
  if (requestBody.notifyFor) {
    return (
      doc.notifyFor &&
      doc.notifyFor.toLowerCase() === requestBody.notifyFor.toLowerCase()
    );
  }
  return true;
};

// GET list (advancedResults middleware should populate res.advancedResults)
exports.getNotifies = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});
exports.getNotifiesPost = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// GET single by id
exports.getNotify = asyncHandler(async (req, res, next) => {
  const notify = await Notify.findById(req.params.id).populate(
    "createdBy updatedBy resourceId"
  );
  if (!notify)
    return next(
      new ErrorResponse(`Notify not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: notify });
});

// GET by uid
exports.getNotifyByUid = asyncHandler(async (req, res, next) => {
  const notify = await Notify.findOne({ uid: req.params.uid }).populate(
    "createdBy updatedBy resourceId"
  );
  if (!notify)
    return next(
      new ErrorResponse(`Notify not found with uid ${req.params.uid}`, 404)
    );
  res.status(200).json({ succeed: true, data: notify });
});

// CREATE
exports.createNotify = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const body = req.body || {};

  const required = ["notifyFor", "notes"];
  for (const k of required) {
    if (!body[k]) return next(new ErrorResponse(`${k} is required`, 400));
  }

  // validate resourceId if provided
  if (body.resourceId && !isValidId(body.resourceId)) {
    return next(new ErrorResponse("Invalid resourceId", 400));
  }

  const notify = await Notify.create({
    client,
    branch,
    notifyFor: body.notifyFor,
    notes: body.notes,
    resourceType: body.resourceType,
    resourceId: body.resourceId,
    documents: Array.isArray(body.documents) ? body.documents : [],
    isActive: true,
    metadata: body.metadata || {},
    createdBy: req.user?.id || null,
  });

  // workflow history
  notify.metadata.workflowHistory = notify.metadata.workflowHistory || [];
  notify.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id || null,
    action: "created",
    notes: body.metadata?.notes || "Created via API",
  });

  await notify.save();

  void (async () => {
    try {
      const notifyPopulateObject = await Notify.findById(notify._id).populate('createdBy updatedBy resourceId');
      const reportApiEndPoint = `${reportAPI_risk}/risk/alert`;
      const doc = Array.isArray(notifyPopulateObject.documents) ? notifyPopulateObject.documents[0] ?? null : null
      let payload = {
        customer: {},
        transaction: {},
        notes: body.notes ?? "",
        docs: doc?.url ?? '',
      };
      if (notifyPopulateObject.resourceType === "Transaction") payload.transaction = notifyPopulateObject.resourceId;
      else payload.customer = notifyPopulateObject.resourceId;

      // console.log(payload)

      const response = await axios.post(reportApiEndPoint, payload, { timeout: 10000 });
      const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data || {};
      const { caseType, riskScore, riskLabel } = data;

      const alertPayload = {
        customerId: notifyPopulateObject?.resourceId?.customer ?? notifyPopulateObject?.resourceId?._id ?? null,
        analyst: null,
        transaction: notifyPopulateObject.resourceType === "Transaction" ? notifyPopulateObject?.resourceId?._id : null,
        caseType: caseType || "Fraud",
        riskScore: riskScore ?? 0,
        riskLabel: riskLabel || "Unknown",
        activity: [{ title: "Initial Review", details: "Reviewed the transaction for possible fraud" }],
        activityNote: [{ note: "Customer contacted for verification" }],
        status: "Active",
        settings: { priority: "urgent" },
        metadata: { ...payload, source: "system" },
      };

      const alert = await Alert.create(alertPayload);
      const alertPopulate = await Alert.findById(alert._id)
        .populate("customer")
        .populate("analyst")
        .populate("transaction");
      const reportApiEndPointForEcdd = `${reportAPI_eccd}/ecdd_report_v2`;
      const ecddPayload = {
        alert: alertPopulate
      }
      await axios.post(reportApiEndPointForEcdd, ecddPayload, { timeout: 10000 });

    } catch (err) {
      if (err.code === 'ECONNREFUSED') {
        console.error('Risk API is unreachable:');
      } else if (err.response) {
        console.error('Risk API error response:', err.response.data);
      } else {
        console.error('Unexpected background error:', err.message);
      }
    }
  })();
  res.status(201).json({
    succeed: true,
    data: notify,
    // alert,
    id: notify._id,
  });
});

// CREATE DUMMY
exports.createDummyNotify = asyncHandler(async (req, res, next) => {
  const {
    notifyFor = "Transaction",
    notes = "Dummy notify",
    resourceType,
    resourceId,
  } = req.body;

  const notify = await Notify.create({
    notifyFor,
    notes,
    resourceType,
    resourceId,
    documents: [],
    isActive: false,
    metadata: { createdBy: req.user?.id, isDummy: true },
    createdBy: req.user?.id,
  });

  notify.metadata = notify.metadata || {};
  notify.metadata.workflowHistory = notify.metadata.workflowHistory || [];
  notify.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created_dummy",
    notes: `Dummy created for ${notifyFor}`,
  });
  await notify.save();

  res.status(201).json({ succeed: true, data: notify, id: notify._id });
});

// UPDATE (partial replace)
exports.updateNotify = asyncHandler(async (req, res, next) => {
  const notify = await Notify.findById(req.params.id);
  if (!notify)
    return next(
      new ErrorResponse(`Notify not found with id ${req.params.id}`, 404)
    );

  // apply body fields (careful with arrays)
  const updatable = [
    "notifyFor",
    "notes",
    "resourceType",
    "resourceId",
    "documents",
    "isActive",
    "metadata",
  ];
  updatable.forEach((k) => {
    if (typeof req.body[k] !== "undefined") notify[k] = req.body[k];
  });

  notify.updatedBy = req.user?.id;
  notify.metadata = notify.metadata || {};
  notify.metadata.workflowHistory = notify.metadata.workflowHistory || [];
  notify.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "updated",
    notes: req.body.metadata?.notes || "Updated via API",
  });

  await notify.save();
  res.status(200).json({ succeed: true, data: notify });
});

// DELETE
exports.deleteNotify = asyncHandler(async (req, res, next) => {
  const notify = await Notify.findById(req.params.id);
  if (!notify)
    return next(
      new ErrorResponse(`Notify not found with id ${req.params.id}`, 404)
    );
  await notify.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});

// TOGGLE active (and record workflow)
exports.toggleNotifyActive = asyncHandler(async (req, res, next) => {
  const notify = await Notify.findById(req.params.id);
  if (!notify)
    return next(
      new ErrorResponse(`Notify not found with id ${req.params.id}`, 404)
    );

  notify.isActive = !!req.body.isActive;
  notify.updatedBy = req.user?.id;
  notify.metadata = notify.metadata || {};
  notify.metadata.workflowHistory = notify.metadata.workflowHistory || [];
  notify.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: notify.isActive ? "activated" : "deactivated",
    notes: req.body.notes || "",
  });

  await notify.save();
  res.status(200).json({ succeed: true, data: notify });
});

// ADD document
exports.addDocument = asyncHandler(async (req, res, next) => {
  const notify = await Notify.findById(req.params.id);
  if (!notify)
    return next(
      new ErrorResponse(`Notify not found with id ${req.params.id}`, 404)
    );

  const { name, url, mimeType, type, docType } = req.body;
  if (!name || !url)
    return next(new ErrorResponse("name and url required for document", 400));

  const doc = {
    name,
    url,
    mimeType,
    type,
    docType,
    uploadedAt: new Date(),
    uploadedBy: req.user?.id,
  };

  notify.documents = notify.documents || [];
  notify.documents.push(doc);

  notify.metadata = notify.metadata || {};
  notify.metadata.workflowHistory = notify.metadata.workflowHistory || [];
  notify.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "document_added",
    notes: `Document ${name} added`,
  });

  await notify.save();
  res.status(201).json({ succeed: true, data: notify, document: doc });
});

// REMOVE document by index or by uploadedAt + name match
exports.removeDocument = asyncHandler(async (req, res, next) => {
  const { id, docIndex } = req.params;
  const notify = await Notify.findById(id);
  if (!notify)
    return next(new ErrorResponse(`Notify not found with id ${id}`, 404));

  if (typeof docIndex === "undefined") {
    return next(new ErrorResponse("docIndex required (zero-based index)", 400));
  }

  const idx = parseInt(docIndex, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= (notify.documents || []).length) {
    return next(new ErrorResponse("Invalid docIndex", 400));
  }

  const removed = notify.documents.splice(idx, 1);

  notify.metadata = notify.metadata || {};
  notify.metadata.workflowHistory = notify.metadata.workflowHistory || [];
  notify.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "document_removed",
    notes: `Document removed: ${removed[0]?.name || "unknown"}`,
  });

  await notify.save();
  res.status(200).json({ succeed: true, data: notify, removed: removed[0] });
});
