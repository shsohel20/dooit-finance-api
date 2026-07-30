// controllers/gfsController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const GFS = require("../models/gfsReport");
const { resolveCaseLinkage, hasLinkageRef, linkageOverrides } = require("../utils/resolveCaseLinkage");
const sendEmail = require("../utils/sendEmail");

/**
 * Helper: try to parse stringified JSON input for fields that might arrive as strings.
 * (Same approach recommended earlier.)
 */
function tryParseJSON(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
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
 * Basic normalization for array/object fields that are often stringified by clients.
 */
function normalizeInput(body) {
  if (!body || typeof body !== "object") return body;
  const normalized = { ...body };

  // parse arrays/objects commonly stringified
  const fieldsToTry = [
    "transactions",
    "ofis",
    "pois",
    "cryptoAddresses",
    "ipAddresses",
    "attachments",
  ];

  fieldsToTry.forEach((f) => {
    if (normalized[f] !== undefined) {
      const parsed = tryParseJSON(normalized[f]);
      // wrap single object into array when appropriate
      if (
        parsed &&
        !Array.isArray(parsed) &&
        f !== "cryptoAddresses" &&
        f !== "attachments"
      ) {
        normalized[f] = [parsed];
      } else if (parsed !== undefined) {
        normalized[f] = parsed;
      } else {
        normalized[f] = normalized[f];
      }
    }
  });

  return normalized;
}

/* Filter helper for advancedResults POST filtering */
exports.filterGFSSection = (doc, requestBody = {}) => {
  if (!requestBody) return true;
  if (requestBody.customerName) {
    return (
      doc.customerName &&
      doc.customerName
        .toLowerCase()
        .includes(requestBody.customerName.toLowerCase())
    );
  }
  if (requestBody.customerUID) {
    return doc.customerUID && doc.customerUID === requestBody.customerUID;
  }
  return true;
};

// @desc Get list (via advancedResults)
exports.getGFSList = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// @desc POST search list (body filter)
exports.getGFSListPost = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// @desc Create new GFS
exports.createGFS = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const body = normalizeInput(req.body || {});

  // minimal server-side validation - ensure customerName or customerUID present
  if (!body.customerName && !body.customerUID) {
    return next(
      new ErrorResponse("customerName or customerUID is required", 400)
    );
  }

  const link = await resolveCaseLinkage({
    caseId: body.caseId || body.case,
    caseNumber: body.caseNumber || body.referenceNumber,
  });

  // create document
  const gfs = await GFS.create({
    ...body,
    client,
    branch,
    customer: body.customer || link.customer,
    case: link.caseId, // Case hub (null until the alert is escalated)
    alert: link.alert, // originating Alert (provenance)
    // ensure numeric defaults
    totalDeposited: Number(body.totalDeposited) || 0,
    totalWithdrawn: Number(body.totalWithdrawn) || 0,
    totalSuspicionAmount: Number(body.totalSuspicionAmount) || 0,
    metadata: {
      ...body.metadata,
      createdBy: req.user?.id || body.metadata?.createdBy,
    },
  });

  res.status(201).json({ succeed: true, data: gfs, id: gfs._id });
});

// @desc Create dummy GFS (quickly create a test record)
exports.createDummyGFS = asyncHandler(async (req, res, next) => {
  const {
    customerName = "John Doe",
    customerUID = `DUMMY_${Date.now()}`,
    companyName = "Acme Bank",
  } = req.body || {};

  const gfs = await GFS.create({
    customerName,
    customerUID,
    companyName,
    suspicionReason: "Unusually large transfer",
    reviewStartDate: new Date(),
    reviewEndDate: new Date(),
    totalDeposited: 10000,
    totalSuspicionAmount: 10000,
    ofis: [
      {
        id: Date.now().toString(),
        name: "Reporting Bank",
        reportDate: new Date(),
        scamType: "Fraud",
      },
    ],
    transactions: [
      {
        id: Date.now().toString(),
        date: new Date(),
        amount: 10000,
        type: "transfer",
        fromBank: "XYZ Bank",
        fromAccount: "123456",
        fromName: "Unknown",
        toAccount: customerUID,
        reference: "TX-12345",
      },
    ],
    metadata: {
      createdBy: req.user?.id || null,
    },
    status: "draft",
  });

  res.status(201).json({ succeed: true, data: gfs, id: gfs._id });
});

// @desc Get single GFS by id
exports.getGFS = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: gfs });
});

// @desc Update GFS
exports.updateGFS = asyncHandler(async (req, res, next) => {
  const gfsId = req.params.id;
  let gfs = await GFS.findById(gfsId);
  if (!gfs)
    return next(new ErrorResponse(`GFS not found with id ${gfsId}`, 404));

  const body = normalizeInput(req.body || {});

  // merge updates
  Object.assign(gfs, body);
  if (hasLinkageRef(body)) Object.assign(gfs, await linkageOverrides(body, "case"));
  gfs.metadata = gfs.metadata || {};
  gfs.metadata.updatedBy = req.user?.id || gfs.metadata.updatedBy;

  await gfs.save();

  res.status(200).json({ succeed: true, data: gfs });
});

// @desc Delete GFS
exports.deleteGFS = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );
  await gfs.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});

/**
 * @desc Generate a plain-text report from stored GFS data (and optionally store it)
 * @route PUT /api/v1/gfs/:id/generate-report
 * @body { save: boolean } -> if save true store generatedReport in doc
 */
exports.generateReport = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );

  // build report text similar to client-side generator
  const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString() : n || 0);
  const ofiText = (gfs.ofis || [])
    .map(
      (ofi) =>
        `On ${
          ofi.reportDate
            ? new Date(ofi.reportDate).toISOString().split("T")[0]
            : "N/A"
        }, "${gfs.companyName}" received multiple third-party requests from ${
          ofi.name
        } pertaining to fraudulent transactions related to ${ofi.scamType}.`
    )
    .join("\n\n");

  const txText = (gfs.transactions || [])
    .map((t) => {
      const dateStr = t.date
        ? new Date(t.date).toISOString().split("T")[0]
        : "N/A";
      const reportedBy = gfs.ofis && gfs.ofis[0] ? gfs.ofis[0].name : "OFI";
      return `• ${t.type || "Transaction"} of $${fmtNum(t.amount)} from ${
        t.fromBank || "N/A"
      } account ${t.fromAccount || "N/A"} in the name of "${
        t.fromName || "N/A"
      }" to "${gfs.companyName}" account "${
        t.toAccount || gfs.customerUID
      }" on "${dateStr}"${
        t.reference
          ? ` which was reported as a fraudulent transaction by ${reportedBy} with reference number "${t.reference}"`
          : ""
      }.`;
    })
    .join("\n\n");

  const cryptoList = (gfs.cryptoAddresses || [])
    .map((a) => `"${a}"`)
    .join(", ");
  const ipNote =
    gfs.ipAddresses && gfs.ipAddresses.length > 0
      ? `In addition, IP addresses used were located within ${
          gfs.ipAddresses[0].country || "N/A"
        } whereas identification is from ${gfs.customerCountry || "N/A"}.`
      : "";

  const report = `This report relates to suspicion: ${
    gfs.suspicionReason || "(not specified)"
  } for "${gfs.customerName || "(unknown)"}".
It appears the customer's identity might have been used to attempt to transfer funds of fraudulent origin.

Customer Profile:
"${gfs.companyName || ""}" account "${gfs.customerUID || ""}" in the name of "${
    gfs.customerName || ""
  }", aged ${gfs.customerAge || "N/A"} years, opened on "${
    gfs.accountOpeningDate
      ? new Date(gfs.accountOpeningDate).toISOString().split("T")[0]
      : "N/A"
  }".
Source of funds: ${gfs.sourceOfFunds || "N/A"}. Account opening purpose: ${
    gfs.accountOpeningPurpose || "N/A"
  }.

Transaction Analysis:
Review period: ${
    gfs.reviewStartDate
      ? new Date(gfs.reviewStartDate).toISOString().split("T")[0]
      : "N/A"
  } to ${
    gfs.reviewEndDate
      ? new Date(gfs.reviewEndDate).toISOString().split("T")[0]
      : "N/A"
  }.
Total deposited: $${fmtNum(gfs.totalDeposited)}. ${
    gfs.transactions && gfs.transactions.length > 0
      ? "Key transactions:\n\n" + txText
      : "No transactions recorded."
  }

${ofiText ? ofiText + "\n\n" : ""}

All funds were transferred to ${
    gfs.cryptoAddresses.length
  } crypto wallet address(es): ${cryptoList}.

Conclusion:
It was reported by ${
    (gfs.ofis || []).map((o) => `"${o.name}"`).join(", ") || "N/A"
  } that the account held by "${
    gfs.customerName || ""
  }" is the recipient of funds of suspected fraudulent origin totalling $${fmtNum(
    gfs.totalSuspicionAmount
  )}.

${ipNote}

${gfs.additionalNotes ? "Additional Notes:\n" + gfs.additionalNotes : ""}`;

  // optionally save generated report into doc
  if (req.body && req.body.save) {
    gfs.generatedReport = report;
    gfs.metadata = gfs.metadata || {};
    gfs.metadata.updatedBy = req.user?.id || gfs.metadata.updatedBy;
    await gfs.save();
  }

  res
    .status(200)
    .json({ succeed: true, data: { report, saved: !!req.body?.save } });
});

/**
 * Submit GFS
 * PUT /api/v1/gfs/:id/submit
 * Body (optional): { notes: string, notify: boolean, notifyEmail: string }
 */
exports.submitGFS = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );

  // prevent re-submitting closed records
  if (
    gfs.status === "submitted" ||
    gfs.status === "closed" ||
    gfs.status === "review"
  ) {
    return next(
      new ErrorResponse(`GFS already submitted / in review or closed`, 400)
    );
  }

  const fromStatus = gfs.status;
  gfs.status = "submitted";
  gfs.metadata = gfs.metadata || {};
  gfs.metadata.submissionDate = new Date();
  gfs.metadata.updatedBy = req.user?.id || gfs.metadata.updatedBy;

  // append workflow event
  gfs.metadata.workflowHistory = gfs.metadata.workflowHistory || [];
  gfs.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "submitted",
    fromStatus,
    toStatus: gfs.status,
    notes: req.body?.notes || "Submitted via API",
  });

  await gfs.save();

  // optional notify email (basic)
  if (req.body?.notify && req.body?.notifyEmail) {
    try {
      const subject = `GFS submitted — ${
        gfs.customerName || gfs.customerUID || gfs.uid
      }`;
      const text = `GFS ${gfs.uid || ""} for ${
        gfs.customerName || gfs.customerUID || "unknown"
      } has been submitted by ${
        req.user?.name || req.user?.id || "system"
      }.\n\nNotes: ${req.body?.notes || ""}\n\nView in the admin panel.`;
      await sendEmail({
        to: req.body.notifyEmail,
        subject,
        text,
      });
    } catch (err) {
      // don't fail the submission due to email failure; log and continue
      console.warn("GFS submit: notify email failed", err);
    }
  }

  res.status(200).json({ succeed: true, data: gfs });
});

/**
 * Approve GFS
 * PUT /api/v1/gfs/:id/approve
 * Body (optional): { notes: string, notify: boolean, notifyEmail: string, finalStatus: "closed"|"review" }
 *
 * - this will set status to 'closed' by default and record approvedBy/approvedAt
 */
exports.approveGFS = asyncHandler(async (req, res, next) => {
  const gfs = await GFS.findById(req.params.id);
  if (!gfs)
    return next(
      new ErrorResponse(`GFS not found with id ${req.params.id}`, 404)
    );

  // Only allow approve if submitted or in review (you can relax/adjust logic)
  if (!["submitted", "review"].includes(gfs.status)) {
    return next(
      new ErrorResponse(
        `Only submitted/review GFS can be approved. Current status: ${gfs.status}`,
        400
      )
    );
  }

  const fromStatus = gfs.status;
  const finalStatus = req.body?.finalStatus || "closed"; // default to closed
  gfs.status = finalStatus;
  gfs.metadata = gfs.metadata || {};
  gfs.metadata.approvedBy = req.user?.id;
  gfs.metadata.approvedAt = new Date();
  gfs.metadata.updatedBy = req.user?.id;

  // append workflow event
  gfs.metadata.workflowHistory = gfs.metadata.workflowHistory || [];
  gfs.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "approved",
    fromStatus,
    toStatus: gfs.status,
    notes: req.body?.notes || "Approved via API",
  });

  await gfs.save();

  // optional notify email
  if (req.body?.notify && req.body?.notifyEmail) {
    try {
      const subject = `GFS approved — ${
        gfs.customerName || gfs.customerUID || gfs.uid
      }`;
      const text = `GFS ${gfs.uid || ""} for ${
        gfs.customerName || gfs.customerUID || "unknown"
      } has been approved by ${
        req.user?.name || req.user?.id || "system"
      }.\n\nNotes: ${req.body?.notes || ""}\n\nStatus: ${gfs.status}`;
      await sendMail({
        to: req.body.notifyEmail,
        subject,
        text,
      });
    } catch (err) {
      console.warn("GFS approve: notify email failed", err);
    }
  }

  res.status(200).json({ succeed: true, data: gfs });
});
