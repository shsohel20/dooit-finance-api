// controllers/ecddReport.js
const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const Alert = require("../models/Alert");
const EcddReport = require("../models/EcddReport");
const ErrorResponse = require("../utils/errorResponse");

const csvParser = require("csv-parser");
const { Parser: Json2CsvParser } = require("json2csv");
const stream = require("stream");

/**
 * Helper: map CSV row -> EcddReport document fields (whitelist)
 * Adjust keys to match your CSV header names (case-insensitive).
 */
const mapRowToDoc = (row) => {
  // Lowercase keys for tolerant matching
  const normalized = {};
  Object.keys(row).forEach(
    (k) => (normalized[k.trim().toLowerCase()] = row[k])
  );

  // Example mapping — update according to your CSV headers
  return {
    analystName:
      normalized["analyst name"] ||
      normalized["analystname"] ||
      normalized["analyst"] ||
      "",
    position: normalized["position"] || "",
    date: normalized["date"] ? new Date(normalized["date"]) : null,
    caseNumber: normalized["case number"] || normalized["case"] || "",
    userId: normalized["user id"] || normalized["userid"] || "",
    fullName: normalized["full name"] || normalized["fullname"] || "",
    customerName:
      normalized["customer name"] || normalized["customername"] || "",
    abn: normalized["abn"] || "",
    onboardingDate: normalized["onboarding date"]
      ? new Date(normalized["onboarding date"])
      : null,
    accountPurpose: normalized["account purpose"] || "",
    expectedVolume: normalized["expected volume"]
      ? Number(normalized["expected volume"])
      : undefined,
    annualIncome: normalized["annual income"]
      ? Number(normalized["annual income"])
      : undefined,
    beneficialOwner: normalized["beneficial owner"] || "",
    directors: normalized["directors"] || "",
    isPEP: (normalized["is pep"] || "No").trim() || "No",
    isSanctioned: (normalized["is sanctioned"] || "No").trim() || "No",
    relatedParty: normalized["related party"] || "N/A",
    accountCreationDate: normalized["account creation date"]
      ? new Date(normalized["account creation date"])
      : null,
    analysisEndDate: normalized["analysis end date"]
      ? new Date(normalized["analysis end date"])
      : null,
    totalDepositsAUD: normalized["total deposits aud"]
      ? Number(normalized["total deposits aud"])
      : 0,
    totalWithdrawalsUSDT: normalized["total withdrawals usdt"]
      ? Number(normalized["total withdrawals usdt"])
      : 0,
    totalWithdrawalsETH: normalized["total withdrawals eth"]
      ? Number(normalized["total withdrawals eth"])
      : 0,
    totalWithdrawalsBTC: normalized["total withdrawals btc"]
      ? Number(normalized["total withdrawals btc"])
      : 0,
    depositDetails: normalized["deposit details"] || "",
    withdrawalDetails: normalized["withdrawal details"] || "",
    additionalInfo: normalized["additional info"] || "",
    ipLocations: normalized["ip locations"]
      ? Number(normalized["ip locations"])
      : undefined,
    registeredAddress: normalized["registered address"] || "",
    profileSummary: normalized["profile summary"] || "",
    transactionAnalysis: normalized["transaction analysis"] || "",
    behavioralAnalysis: normalized["behavioral analysis"] || "",
    recommendation: normalized["recommendation"] || "",
  };
};
/**
 * Simple filter helper for front-end search (mirrors your user filter)
 * s: single EcddReport doc
 * requestBody: expected to contain { name: string } (will check against fullName / customerName)
 */
exports.filterEcddSection = (s, requestBody) => {
  const needle = (requestBody.name || "").toLowerCase().trim();
  if (!needle) return true;
  const hay = (
    (s.fullName || "") +
    " " +
    (s.customerName || "") +
    " " +
    (s.caseNumber || "")
  )
    .toLowerCase()
    .trim();
  return hay.includes(needle);
};

// @desc   Get all ECDD reports
// @route  GET /api/v1/ecdd
// @access Public (or protect with auth middleware in routes)
exports.getEcddReports = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['ECDD']
  #swagger.summary = 'Get All Reports'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // expected to be populated by advancedResults middleware
  res.status(200).json(res.advancedResults);
});

// @desc   Create a single ECDD report
// @route  POST /api/v1/ecdd
// @access Private (require authentication in routes)
exports.createEcddReport = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  const user = req?.user?._id || null;

  // whitelist allowed fields server-side if you prefer
  const payload = req.body || {};
  const { caseNumber, riskAssessment: riskAssessmentId } = payload;

  if (caseNumber) {
    const existing = await EcddReport.findOne({
      caseNumber: caseNumber,
    });

    if (existing) {
      return next(
        new ErrorResponse(
          `The caseNumber (${caseNumber}) is already used by another report.`,
          409
        )
      );
    }
  }

  // Two origins:
  //  • TM-origin (default): caseNumber must resolve to a TM Alert
  //  • CRA-origin: riskAssessment supplied — backs a CRA ECDD gate; no Alert needed
  let alert = null;
  let assessment = null;

  if (riskAssessmentId) {
    const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
    assessment = await IndividualRiskAssessment.findById(riskAssessmentId)
      .select("uid customer customerName client branch")
      .lean();
    if (!assessment) {
      return next(
        new ErrorResponse(`Risk assessment not found: ${riskAssessmentId}`, 404)
      );
    }
    if (caseNumber) alert = await Alert.findOne({ uid: caseNumber }); // optional here
  } else {
    alert = await Alert.findOne({ uid: caseNumber });

    if (!alert) {
      return next(
        new ErrorResponse(
          `Alert not found by CASE Number or Alert UID ${caseNumber}`,
          404
        )
      );
    }
  }

  const submitObj = {
    ...payload,
    client,
    branch,
    caseId: alert?._id || null,
    riskAssessment: assessment?._id || null,
    customer: payload.customer || assessment?.customer || null,
    generatedBy: user || null,
  };
  const report = await EcddReport.create(submitObj);

  // CRA-origin: back-link the assessment to its ECDD form + audit trail entry
  if (assessment) {
    const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
    const { logCraEvent } = require("../utils/craAudit");
    await IndividualRiskAssessment.updateOne(
      { _id: assessment._id },
      { $set: { ecddReport: report._id } }
    );
    await logCraEvent({
      req,
      assessment,
      action: "ECDD_REPORT_LINKED",
      after: { ecddReport: report.uid, analystName: report.analystName || "" },
      target: assessment.customerName,
    });
  }

  res.status(201).json({
    success: true,
    data: report,
    id: report._id,
  });
});
// @desc   Create a single ECDD report
// @route  POST /api/v1/ecdd
// @access Private (require authentication in routes)
exports.createPublicEcddReport = asyncHandler(async (req, res, next) => {
  const payload = req.body || {};

  const { caseNumber, generatedBy, analyst, transaction, customer, client, branch } = payload;



  const existing = await EcddReport.findOne({ caseNumber });
  if (existing) {
    return next(
      new ErrorResponse(
        `The caseNumber (${caseNumber}) is already used by another report.`,
        409
      )
    );
  }

  const alert = await Alert.findOne({ uid: caseNumber });
  if (!alert) {
    return next(
      new ErrorResponse(
        `Alert not found by CASE Number or Alert UID ${caseNumber}`,
        404
      )
    );
  }

  const submitObj = {
    ...payload,
    caseId: alert._id,
    client: alert?.client ?? null,
    branch: alert?.branch ?? null,
    analyst: alert?.analyst ?? null,
    customer: alert?.customer ?? null,
    transaction: alert?.transaction ?? null,
    generatedBy: alert?.createdBy || null

  };

  const report = await EcddReport.create(submitObj);

  res.status(201).json({
    success: true,
    data: report,
    id: report._id,
  });
});

// @desc   Fetch single ECDD report by id
// @route  GET /api/v1/ecdd/:id
// @access Public or Protected
exports.getEcddReport = asyncHandler(async (req, res, next) => {
  const report = await EcddReport.findById(req.params.id)
    .populate("customer")
    .populate("analyst")
    .populate("generatedBy")
    .populate("transaction");

  if (!report) {
    return next(
      new ErrorResponse(
        `ECDD Report not found with id of ${req.params.id}`,
        404
      )
    );
  }
  res.status(200).json({
    success: true,
    data: report,
  });
});

// @desc   Fetch single report by caseNumber
// @route  GET /api/v1/ecdd/case/:caseNumber
// @access Public or Protected
exports.getEcddReportByCaseNumber = asyncHandler(async (req, res, next) => {
  const report = await EcddReport.findOne({ caseNumber: req.params.caseNumber })
    .populate("customer")
    .populate("analyst")
    .populate("generatedBy")
    .populate("transaction");

  if (!report) {
    return next(
      new ErrorResponse(
        `ECDD Report not found with caseNumber ${req.params.caseNumber}`,
        404
      )
    );
  }
  res.status(200).json({
    success: true,
    data: report,
  });
});

// @desc   Update single ECDD report
// @route  PUT /api/v1/ecdd/:id
// @access Private
exports.updateEcddReport = asyncHandler(async (req, res, next) => {
  // optional duplicate check for caseNumber
  if (req.body.caseNumber) {
    const existing = await EcddReport.findOne({
      caseNumber: req.body.caseNumber,
    });
    if (existing && existing._id.toString() !== req.params.id) {
      return next(
        new ErrorResponse(
          `The caseNumber (${req.body.caseNumber}) is already used by another report.`,
          409
        )
      );
    }
  }

  const report = await EcddReport.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });

  if (!report) {
    return next(
      new ErrorResponse(
        `ECDD Report not found with id of ${req.params.id}`,
        404
      )
    );
  }

  res.status(200).json({
    success: true,
    data: report,
  });
});

// @desc   Delete single ECDD report
// @route  DELETE /api/v1/ecdd/:id
// @access Private
exports.deleteEcddReport = asyncHandler(async (req, res, next) => {
  const report = await EcddReport.findById(req.params.id);

  if (!report) {
    return next(
      new ErrorResponse(
        `ECDD Report not found with id of ${req.params.id}`,
        404
      )
    );
  }

  await report.deleteOne();

  res.status(200).json({
    success: true,
    data: req.params.id,
  });
});

// @desc   Import ECDD report(s) (single object or array)
// @route  POST /api/v1/ecdd/import
// @access Private
exports.importFromJsonEcddReports = asyncHandler(async (req, res, next) => {
  const payload = req.body;

  if (!payload) {
    return next(new ErrorResponse("Request body is empty", 400));
  }

  // If array — bulk create
  if (Array.isArray(payload)) {
    const inserted = [];
    for (const p of payload) {
      // optionally sanitize p here
      const doc = await EcddReport.create(p);
      inserted.push(doc);
    }
    return res.status(201).json({
      success: true,
      inserted: inserted.length,
      data: inserted,
    });
  }

  // Single object create
  const doc = await EcddReport.create(payload);
  return res.status(201).json({
    success: true,
    data: doc,
  });
});

/**
 * @route POST /api/v1/ecdd/import-csv
 * @desc Import CSV file, stream-parse and create documents (bulk)
 * @access Private
 * Multer upload should attach file in req.file
 */
exports.importEcddReportCsv = asyncHandler(async (req, res, next) => {
  if (!req.file) {
    return next(new ErrorResponse("No file uploaded", 400));
  }

  // stream from buffer
  const readStream = new stream.PassThrough();
  readStream.end(req.file.buffer);

  const createdDocs = [];
  let processed = 0;
  const errors = [];

  await new Promise((resolve, reject) => {
    readStream
      .pipe(csvParser({ skipLines: 0, strict: false }))
      .on("data", async (row) => {
        // Pause stream to allow async DB write (backpressure)
        readStream.pause();
        try {
          processed++;
          const mapped = mapRowToDoc(row);

          // Optional: basic validation — skip if required fields missing
          if (!mapped.caseNumber && !mapped.fullName) {
            errors.push({
              row: processed,
              reason: "missing caseNumber & fullName",
            });
            readStream.resume();
            return;
          }

          // Create document (you can use create() or insertMany for batches)
          const doc = await EcddReport.create(mapped);
          createdDocs.push(doc);
        } catch (err) {
          errors.push({ row: processed, error: err.message });
        } finally {
          readStream.resume();
        }
      })
      .on("end", () => resolve())
      .on("error", (err) => reject(err));
  });

  return res.status(201).json({
    success: true,
    processed,
    inserted: createdDocs.length,
    errors,
    data: createdDocs.slice(0, 20), // return a sample of created docs (avoid huge responses)
  });
});

/**
 * @route GET /api/v1/ecdd/export-csv
 * @desc Export ECDD reports as CSV (supports query filters via req.query)
 * @access Private
 * Streams CSV back to client
 */
exports.exportEcddReportCsv = asyncHandler(async (req, res, next) => {
  // Build query (whitelist)
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.caseNumber) filters.caseNumber = req.query.caseNumber;
  if (req.query.userId) filters.userId = req.query.userId;
  if (req.query.fullName)
    filters.fullName = { $regex: req.query.fullName, $options: "i" };

  const cursor = EcddReport.find(filters).cursor();

  const fields = [
    { label: "Case Number", value: "caseNumber" },
    { label: "Analyst Name", value: "analystName" },
    { label: "Position", value: "position" },
    {
      label: "Date",
      value: (row) => (row.date ? row.date.toISOString().split("T")[0] : ""),
    },
    { label: "User ID", value: "userId" },
    { label: "Full Name", value: "fullName" },
    { label: "Customer Name", value: "customerName" },
    { label: "ABN", value: "abn" },
    {
      label: "Onboarding Date",
      value: (row) =>
        row.onboardingDate
          ? row.onboardingDate.toISOString().split("T")[0]
          : "",
    },
    { label: "Account Purpose", value: "accountPurpose" },
    { label: "Expected Volume", value: "expectedVolume" },
    { label: "Annual Income", value: "annualIncome" },
    { label: "Total Deposits (AUD)", value: "totalDepositsAUD" },
    { label: "Total Withdrawals (USDT)", value: "totalWithdrawalsUSDT" },
    { label: "Total Withdrawals (ETH)", value: "totalWithdrawalsETH" },
    { label: "Total Withdrawals (BTC)", value: "totalWithdrawalsBTC" },
    { label: "Is PEP", value: "isPEP" },
    { label: "Is Sanctioned", value: "isSanctioned" },
    { label: "Recommendation", value: "recommendation" },
  ];

  const filename = `ecdd_export_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.csv`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/csv");

  // Parser to produce header using fields spec (label/value)
  const headerParser = new Json2CsvParser({ fields, header: true });
  const headerCsv = headerParser.parse([]); // header only
  const pass = new stream.PassThrough();
  pass.pipe(res);
  pass.write(headerCsv + "\n");

  // We'll use a different parser for rows: supply fields as label strings
  const labelFields = fields.map((f) => f.label);
  const rowParser = new Json2CsvParser({ fields: labelFields, header: false });

  for await (const doc of cursor) {
    // Build an object keyed by the label names (matching rowParser expectations)
    const rowObj = {};
    for (const f of fields) {
      const val = typeof f.value === "function" ? f.value(doc) : doc[f.value];
      // use the label as the key so rowParser picks the right column
      rowObj[f.label] = val !== undefined && val !== null ? val : "";
    }
    // parse the single-row object (header:false)
    const rowCsv = rowParser.parse([rowObj]);
    pass.write(rowCsv + "\n");
  }

  pass.end();
});
