// controllers/iftiController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const IFTI = require("../models/IftiReport");
const { resolveCaseLinkage, hasLinkageRef, linkageOverrides } = require("../utils/resolveCaseLinkage");
const sendEmail = require("../utils/sendEmail");

/* -- Helpers -- */
function ensureString(v) {
  return v === undefined || v === null ? "" : String(v);
}

function tryParseJSON(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    // attempt sloppy single-quote fix
    try {
      const fixed = trimmed
        .replace(/(\r\n|\n|\r)/gm, " ")
        .replace(/(\s)+/g, " ")
        .replace(/'/g, '"');
      return JSON.parse(fixed);
    } catch (err2) {
      return value;
    }
  }
}

/**
 * Normalize client payload:
 * - parse stringified JSON arrays/objects
 * - convert intermediaries map to array of { key, present, ... }
 */
function normalizeInput(body = {}) {
  const normalized = { ...body };

  // parse transaction, persons
  [
    "transaction",
    "orderingCustomer",
    "beneficiaryCustomer",
    "reportCompletion",
  ].forEach((k) => {
    if (normalized[k] !== undefined) {
      const parsed = tryParseJSON(normalized[k]);
      normalized[k] = parsed !== undefined ? parsed : normalized[k];
    }
  });

  // parse attachments
  if (normalized.attachments !== undefined) {
    const parsed = tryParseJSON(normalized.attachments);
    normalized.attachments =
      parsed !== undefined ? parsed : normalized.attachments;
  }

  // intermediaries: support object map or array
  if (normalized.intermediaries !== undefined) {
    let inter = tryParseJSON(normalized.intermediaries);
    if (!inter) inter = normalized.intermediaries;

    if (!Array.isArray(inter) && typeof inter === "object") {
      // convert map to array
      normalized.intermediaries = Object.keys(inter).map((key) => {
        const item = inter[key] || {};
        return {
          key,
          present: !!item.present || !!item,
          fullName: item.fullName || item.name || "",
          address: item.address || "",
          city: item.city || "",
          state: item.state || "",
          postcode: item.postcode || "",
          country: item.country || "",
        };
      });
    } else if (Array.isArray(inter)) {
      normalized.intermediaries = inter;
    } else {
      normalized.intermediaries = [];
    }
  }

  return normalized;
}

/* -- Filter helper for advancedResults POST filtering -- */
exports.filterIFTISection = (doc, requestBody = {}) => {
  if (!requestBody) return true;
  if (requestBody.uid) {
    return (
      doc.uid && doc.uid.toLowerCase().includes(requestBody.uid.toLowerCase())
    );
  }
  if (requestBody.orderingName) {
    return (
      doc.orderingCustomer?.fullName &&
      doc.orderingCustomer.fullName
        .toLowerCase()
        .includes(requestBody.orderingName.toLowerCase())
    );
  }
  return true;
};

/* -- Controllers -- */

// list (GET)
exports.getIFTIs = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});
exports.getIFTIsPost = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// create
exports.createIFTI = asyncHandler(async (req, res, next) => {
  const body = normalizeInput(req.body || {});

  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  // minimal validation
  if (
    !body.transaction ||
    (!body.orderingCustomer?.fullName && !body.beneficiaryCustomer?.fullName)
  ) {
    return next(
      new ErrorResponse(
        "transaction and either orderingCustomer.fullName or beneficiaryCustomer.fullName required",
        400
      )
    );
  }

  // coerce numeric totalAmount
  if (body.transaction && body.transaction.totalAmount) {
    body.transaction.totalAmount = Number(body.transaction.totalAmount) || 0;
  }

  const link = await resolveCaseLinkage({
    caseId: body.caseId || body.case,
    caseNumber: body.caseNumber || body.referenceNumber,
  });

  const doc = await IFTI.create({
    client: client || link.client,
    branch: branch || link.branch,
    customer: body.customer || link.customer,
    case: link.caseId, // Case hub (null until the alert is escalated)
    alert: link.alert, // originating Alert (provenance)
    transaction: body.transaction,
    orderingCustomer: body.orderingCustomer,
    beneficiaryCustomer: body.beneficiaryCustomer,
    intermediaries: body.intermediaries || [],
    reportCompletion: body.reportCompletion || {},
    attachments: body.attachments || [],
    metadata: {
      ...(body.metadata || {}),
      createdBy: req.user?.id || body.metadata?.createdBy,
    },
    status: body.status || "draft",
  });

  // add workflow history
  doc.metadata = doc.metadata || {};
  doc.metadata.workflowHistory = doc.metadata.workflowHistory || [];
  doc.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created",
    fromStatus: null,
    toStatus: doc.status,
    notes: "Created via API",
  });
  await doc.save();

  res.status(201).json({ succeed: true, data: doc, id: doc._id });
});

// create dummy
exports.createDummyIFTI = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const { orderingName = "Test Sender", beneficiaryName = "Test Receiver" } =
    req.body || {};
  const doc = await IFTI.create({
    client,
    branch,
    transaction: {
      dateReceived: new Date(),
      dateAvailable: new Date(),
      currencyCode: "USD",
      totalAmount: 1000,
      transferType: "Wire Transfer",
      propertyDescription: "",
      referenceNumber: `REF-${Date.now()}`,
    },
    orderingCustomer: { fullName: orderingName, country: "Australia" },
    beneficiaryCustomer: { fullName: beneficiaryName, country: "Singapore" },
    reportCompletion: {
      transferReason: "Test transfer",
      completedBy: {
        fullName: req.user?.name || "System",
        jobTitle: "Analyst",
        phone: "",
        email: req.user?.email || "",
      },
    },
    metadata: { createdBy: req.user?.id },
    status: "draft",
  });

  doc.metadata = doc.metadata || {};
  doc.metadata.workflowHistory = doc.metadata.workflowHistory || [];
  doc.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created_dummy",
    fromStatus: null,
    toStatus: doc.status,
    notes: "Dummy created",
  });
  await doc.save();

  res.status(201).json({ succeed: true, data: doc, id: doc._id });
});

// get single
exports.getIFTI = asyncHandler(async (req, res, next) => {
  const doc = await IFTI.findById(req.params.id);
  if (!doc)
    return next(
      new ErrorResponse(`IFTI not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: doc });
});

// update
exports.updateIFTI = asyncHandler(async (req, res, next) => {
  const id = req.params.id;
  let doc = await IFTI.findById(id);
  if (!doc) return next(new ErrorResponse(`IFTI not found with id ${id}`, 404));

  const body = normalizeInput(req.body || {});
  // merge
  Object.assign(doc, body);
  if (hasLinkageRef(body)) Object.assign(doc, await linkageOverrides(body, "case"));
  doc.metadata = doc.metadata || {};
  doc.metadata.updatedBy = req.user?.id;
  doc.metadata.workflowHistory = doc.metadata.workflowHistory || [];
  doc.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "updated",
    fromStatus: doc.status,
    toStatus: doc.status,
    notes: body.metadata?.notes || "Updated via API",
  });

  await doc.save();
  res.status(200).json({ succeed: true, data: doc });
});

// delete
exports.deleteIFTI = asyncHandler(async (req, res, next) => {
  const doc = await IFTI.findById(req.params.id);
  if (!doc)
    return next(
      new ErrorResponse(`IFTI not found with id ${req.params.id}`, 404)
    );
  await doc.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});

/* generateReport - returns plain-text and optionally saves */
exports.generateReport = asyncHandler(async (req, res, next) => {
  const doc = await IFTI.findById(req.params.id);
  if (!doc)
    return next(
      new ErrorResponse(`IFTI not found with id ${req.params.id}`, 404)
    );

  const tx = doc.transaction || {};
  const oc = doc.orderingCustomer || {};
  const bc = doc.beneficiaryCustomer || {};
  const rc = doc.reportCompletion || {};
  const completedBy = rc.completedBy || {};

  const dateStr = (d) => (d ? new Date(d).toISOString().split("T")[0] : "N/A");
  const report = [
    `INTERNATIONAL FUNDS TRANSFER INSTRUCTION REPORT`,
    `Generated: ${new Date().toLocaleString()}`,
    ``,
    `SECTION 1: TRANSACTION DETAILS`,
    `Date Money/Property Received: ${dateStr(tx.dateReceived)}`,
    `Date Made Available to Beneficiary: ${dateStr(tx.dateAvailable)}`,
    `Currency Code: ${ensureString(tx.currencyCode)}`,
    `Total Amount/Value: ${ensureString(tx.totalAmount)}`,
    `Type of Transfer: ${ensureString(tx.transferType)}`,
    tx.propertyDescription
      ? `Property Description: ${tx.propertyDescription}`
      : ``,
    `Transaction Reference Number: ${ensureString(tx.referenceNumber)}`,
    ``,
    `SECTION 2: ORDERING CUSTOMER (SENDER)`,
    `Full Name: ${ensureString(oc.fullName)}`,
    oc.otherName ? `Other Name: ${oc.otherName}` : ``,
    oc.dateOfBirth ? `Date of Birth: ${dateStr(oc.dateOfBirth)}` : ``,
    `Address: ${ensureString(oc.address)}`,
    `City: ${ensureString(oc.city)}`,
    `State: ${ensureString(oc.state)}`,
    `Postcode: ${ensureString(oc.postcode)}`,
    `Country: ${ensureString(oc.country)}`,
    oc.phone ? `Phone: ${oc.phone}` : ``,
    oc.email ? `Email: ${oc.email}` : ``,
    oc.occupation ? `Occupation: ${oc.occupation}` : ``,
    oc.abnAcnArbn ? `ABN/ACN/ARBN: ${oc.abnAcnArbn}` : ``,
    oc.customerNumber ? `Customer Number: ${oc.customerNumber}` : ``,
    oc.accountNumber ? `Account Number: ${oc.accountNumber}` : ``,
    oc.businessStructure ? `Business Structure: ${oc.businessStructure}` : ``,
    ``,
    `SECTION 3: BENEFICIARY CUSTOMER (RECEIVER)`,
    `Full Name: ${ensureString(bc.fullName)}`,
    bc.dateOfBirth ? `Date of Birth: ${dateStr(bc.dateOfBirth)}` : ``,
    bc.businessName ? `Business Name: ${bc.businessName}` : ``,
    `Address: ${ensureString(bc.address)}`,
    `City: ${ensureString(bc.city)}`,
    `State: ${ensureString(bc.state)}`,
    `Postcode: ${ensureString(bc.postcode)}`,
    `Country: ${ensureString(bc.country)}`,
    bc.phone ? `Phone: ${bc.phone}` : ``,
    bc.email ? `Email: ${bc.email}` : ``,
    bc.occupation ? `Occupation: ${bc.occupation}` : ``,
    bc.abnAcnArbn ? `ABN/ACN/ARBN: ${bc.abnAcnArbn}` : ``,
    bc.accountNumber ? `Account Number: ${bc.accountNumber}` : ``,
    bc.institutionName ? `Institution Name: ${bc.institutionName}` : ``,
    bc.institutionCity ? `Institution City: ${bc.institutionCity}` : ``,
    bc.institutionCountry
      ? `Institution Country: ${bc.institutionCountry}`
      : ``,
    ``,
    `SECTION 4: INTERMEDIARY PARTIES`,
    doc.intermediaries && doc.intermediaries.length > 0
      ? doc.intermediaries
          .map(
            (i) =>
              `${i.key}: ${i.fullName || "(no name)"} - ${i.address || ""} ${
                i.city || ""
              } ${i.country || ""}`
          )
          .join("\n")
      : "No intermediaries recorded.",
    ``,
    `SECTION 5: REPORT COMPLETION`,
    `Reason for Transfer: ${ensureString(rc.transferReason)}`,
    `Report Completed By:`,
    `Name: ${ensureString(completedBy.fullName)}`,
    `Job Title: ${ensureString(completedBy.jobTitle)}`,
    `Phone: ${ensureString(completedBy.phone)}`,
    `Email: ${ensureString(completedBy.email)}`,
    ``,
    `End of Report`,
  ]
    .filter(Boolean)
    .join("\n");

  // optionally save
  if (req.body?.save) {
    doc.generatedReport = report;
    doc.metadata = doc.metadata || {};
    doc.metadata.updatedBy = req.user?.id || doc.metadata.updatedBy;
    doc.metadata.workflowHistory = doc.metadata.workflowHistory || [];
    doc.metadata.workflowHistory.push({
      timestamp: new Date(),
      user: req.user?.id,
      action: "generate_report",
      fromStatus: doc.status,
      toStatus: doc.status,
      notes: "Generated report via API",
    });
    await doc.save();
  }

  res
    .status(200)
    .json({ succeed: true, data: { report, saved: !!req.body?.save } });
});

/* Submit IFTI - move to 'submitted' */
exports.submitIFTI = asyncHandler(async (req, res, next) => {
  const doc = await IFTI.findById(req.params.id);
  if (!doc)
    return next(
      new ErrorResponse(`IFTI not found with id ${req.params.id}`, 404)
    );

  if (["submitted", "approved", "closed"].includes(doc.status)) {
    return next(new ErrorResponse(`IFTI already submitted/processed`, 400));
  }

  const from = doc.status;
  doc.status = "submitted";
  doc.metadata = doc.metadata || {};
  doc.metadata.submissionDate = new Date();
  doc.metadata.updatedBy = req.user?.id;

  doc.metadata.workflowHistory = doc.metadata.workflowHistory || [];
  doc.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "submitted",
    fromStatus: from,
    toStatus: doc.status,
    notes: req.body?.notes || "Submitted via API",
  });

  await doc.save();

  // optional notify
  if (req.body?.notify && req.body?.notifyEmail) {
    try {
      await sendEmail({
        to: req.body.notifyEmail,
        subject: `IFTI submitted — ${doc.uid}`,
        text: `IFTI ${doc.uid} for ${
          doc.orderingCustomer?.fullName || "unknown"
        } submitted by ${req.user?.name || req.user?.id || "system"}`,
      });
    } catch (err) {
      console.warn("IFTI submit: notify email failed", err);
    }
  }

  res.status(200).json({ succeed: true, data: doc });
});

/* Approve IFTI - move to 'approved' or 'closed' */
exports.approveIFTI = asyncHandler(async (req, res, next) => {
  const doc = await IFTI.findById(req.params.id);
  if (!doc)
    return next(
      new ErrorResponse(`IFTI not found with id ${req.params.id}`, 404)
    );

  if (!["submitted", "review"].includes(doc.status)) {
    return next(
      new ErrorResponse(`Only submitted/review IFTIs can be approved`, 400)
    );
  }

  const from = doc.status;
  const finalStatus = req.body?.finalStatus || "approved";
  doc.status = finalStatus;
  doc.metadata = doc.metadata || {};
  doc.metadata.approvedBy = req.user?.id;
  doc.metadata.approvedAt = new Date();
  doc.metadata.updatedBy = req.user?.id;

  doc.metadata.workflowHistory = doc.metadata.workflowHistory || [];
  doc.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "approved",
    fromStatus: from,
    toStatus: doc.status,
    notes: req.body?.notes || "Approved via API",
  });

  await doc.save();

  if (req.body?.notify && req.body?.notifyEmail) {
    try {
      await sendMail({
        to: req.body.notifyEmail,
        subject: `IFTI approved — ${doc.uid}`,
        text: `IFTI ${doc.uid} has been approved by ${
          req.user?.name || req.user?.id || "system"
        }.`,
      });
    } catch (err) {
      console.warn("IFTI approve: notify email failed", err);
    }
  }

  res.status(200).json({ succeed: true, data: doc });
});
