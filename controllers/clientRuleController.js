// controllers/clientRuleController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const ClientRule = require("../models/ClientRule");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const { Parser } = require("json2csv");
const { Readable } = require("stream");
const csv = require("csv-parser");

function bufferToStream(buffer) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}

// CSV column → schema field mapping
const CSV_HEADERS = {
    "Rule ID": "ruleId",
    "Rule Name": "ruleName",
    "Rule Condition (Logic Summary)": "ruleCondition",
    "Descriptive Explanation": "descriptiveExplanation",
    "Rule Domain_subdomain": "ruleDomainSubdomain",
    "main_domain": "mainDomain",
    "Case Type": "caseType",
    "Risk Score": "riskScore",
    "Risk Label": "riskLabel",
    "Is Active": "isActive",
};

const VALID_CASE_TYPES = new Set(["Fraud", "AML", "Compliance", "TF"]);
const VALID_RISK_LABELS = new Set(["Low", "Medium", "High", "Critical", "Info"]);

/**
 * Filter helper (used by advancedResults POST search)
 */
exports.filterClientRuleSection = (doc, requestBody, req) => {
    if (requestBody.ruleName) {
        return doc.ruleName
            ?.toLowerCase()
            .includes(requestBody.ruleName.toLowerCase());
    }
    return true;
};

// @desc    Get all rules
// @route   GET /api/v1/client-rules
// @access  Private (Admin)
exports.getClientRules = asyncHandler(async (req, res) => {
    res.status(200).json(res.advancedResults);
});

// @desc    Get all rules (POST filter)
// @route   POST /api/v1/client-rules
// @access  Private (Admin)
exports.getClientRulesPost = asyncHandler(async (req, res) => {
    res.status(200).json(res.advancedResults);
});

// @desc    Create rule
// @route   POST /api/v1/client-rules/new
// @access  Private (Admin)
exports.createClientRule = asyncHandler(async (req, res, next) => {
    const client = req?.user?.client?._id || null;
    const branch = req?.user?.branch?._id || null;

    if (!client) {
        return next(new ErrorResponse("Unauthorized client", 401));
    }

    const {

        ruleId,
        ruleName,
        ruleCondition,
        descriptiveExplanation,
        ruleDomainSubdomain,
        mainDomain,
        caseType,
        riskScore,
        riskLabel,
        isActive = true,
    } = req.body;



    const rule = await ClientRule.create({
        client,
        branch,
        ruleId,
        ruleName,
        ruleCondition,
        descriptiveExplanation,
        ruleDomainSubdomain,
        mainDomain,
        caseType,
        riskScore,
        riskLabel,
        isActive,
    });



    res.status(201).json({
        success: true,
        data: rule,
    });
});

// @desc    Get single rule
// @route   GET /api/v1/client-rules/:id
// @access  Private
exports.getClientRule = asyncHandler(async (req, res, next) => {
    const rule = await ClientRule.findById(req.params.id)
        .populate("client", "name")
        .populate("branch", "name");

    if (!rule) {
        return next(
            new ErrorResponse(`Rule not found with id ${req.params.id}`, 404)
        );
    }

    res.status(200).json({
        success: true,
        data: rule,
    });
});

// @desc    Update rule
// @route   PUT /api/v1/client-rules/:id
// @access  Private (Admin)
exports.updateClientRule = asyncHandler(async (req, res, next) => {
    let rule = await ClientRule.findById(req.params.id);

    if (!rule) {
        return next(
            new ErrorResponse(`Rule not found with id ${req.params.id}`, 404)
        );
    }

    rule = await ClientRule.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
    });

    res.status(200).json({
        success: true,
        data: rule,
    });
});

// @desc    Delete rule
// @route   DELETE /api/v1/client-rules/:id
// @access  Private (Admin)
exports.deleteClientRule = asyncHandler(async (req, res, next) => {
    const rule = await ClientRule.findById(req.params.id);

    if (!rule) {
        return next(
            new ErrorResponse(`Rule not found with id ${req.params.id}`, 404)
        );
    }

    await rule.deleteOne();

    res.status(200).json({
        success: true,
        data: req.params.id,
    });
});

// @desc    Export client rules as CSV
// @route   GET /api/v1/client-rules/export
// @access  Private
exports.exportClientRulesCsv = asyncHandler(async (req, res, next) => {
    const client = req?.user?.client?._id || null;

    const filter = client ? { client } : {};
    const rules = await ClientRule.find(filter).lean();

    if (!rules.length) {
        return next(new ErrorResponse("No rules found to export", 404));
    }

    const fields = [
        { label: "Rule ID",                        value: "ruleId" },
        { label: "Rule Name",                      value: "ruleName" },
        { label: "Rule Condition (Logic Summary)", value: "ruleCondition" },
        { label: "Descriptive Explanation",        value: "descriptiveExplanation" },
        { label: "Rule Domain_subdomain",          value: "ruleDomainSubdomain" },
        { label: "main_domain",                    value: "mainDomain" },
        { label: "Case Type",                      value: "caseType" },
        { label: "Risk Score",                     value: "riskScore" },
        { label: "Risk Label",                     value: "riskLabel" },
        { label: "Is Active",                      value: "isActive" },
    ];

    const parser = new Parser({ fields });
    const csvData = parser.parse(rules);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="client-rules.csv"');
    return res.send(csvData);
});

// @desc    Import client rules from CSV
// @route   POST /api/v1/client-rules/import
// @access  Private
exports.importClientRulesCsv = asyncHandler(async (req, res, next) => {
    if (!req.file) {
        return next(new ErrorResponse("CSV file is required", 400));
    }

    const client = req?.user?.client?._id || null;
    const branch = req?.user?.branch?._id || null;

    const rows = [];
    const skipped = [];

    await new Promise((resolve, reject) => {
        bufferToStream(req.file.buffer)
            .pipe(csv())
            .on("data", (row) => {
                const ruleId             = (row[CSV_HEADERS["Rule ID"]] || row["Rule ID"] || "").trim();
                const ruleName           = (row[CSV_HEADERS["Rule Name"]] || row["Rule Name"] || "").trim();
                const ruleCondition      = (row[CSV_HEADERS["Rule Condition (Logic Summary)"]] || row["Rule Condition (Logic Summary)"] || "").trim();
                const descriptiveExplanation = (row["Descriptive Explanation"] || "").trim();
                const ruleDomainSubdomain = (row["Rule Domain_subdomain"] || "").trim();
                const mainDomain         = (row["main_domain"] || "").trim();
                const rawCaseType        = (row["Case Type"] || "").trim();
                const rawRiskScore       = (row["Risk Score"] || "").toString().trim();
                const rawRiskLabel       = (row["Risk Label"] || "").toString().trim();
                const rawIsActive        = (row["Is Active"] || "").toString().trim().toUpperCase();

                // Skip rows missing required fields
                if (!ruleId || !ruleName || !ruleCondition) {
                    if (ruleId) skipped.push({ ruleId, reason: "Missing ruleName or ruleCondition" });
                    return;
                }
                if (!VALID_CASE_TYPES.has(rawCaseType)) {
                    skipped.push({ ruleId, reason: `Invalid caseType: "${rawCaseType}"` });
                    return;
                }
                const riskScore = Number(rawRiskScore);
                if (isNaN(riskScore) || riskScore < 0 || riskScore > 100) {
                    skipped.push({ ruleId, reason: `Invalid riskScore: "${rawRiskScore}"` });
                    return;
                }
                if (!VALID_RISK_LABELS.has(rawRiskLabel)) {
                    skipped.push({ ruleId, reason: `Invalid riskLabel: "${rawRiskLabel}"` });
                    return;
                }

                rows.push({
                    ruleId,
                    ruleName,
                    ruleCondition,
                    descriptiveExplanation,
                    ruleDomainSubdomain,
                    mainDomain,
                    caseType:  rawCaseType,
                    riskScore,
                    riskLabel: rawRiskLabel,
                    isActive:  rawIsActive === "TRUE" || rawIsActive === "1" || rawIsActive === "YES",
                    client,
                    branch,
                });
            })
            .on("end", resolve)
            .on("error", reject);
    });

    if (!rows.length) {
        return next(new ErrorResponse("No valid rows found in CSV", 400));
    }

    // Upsert each rule by ruleId
    const bulkOps = rows.map((rule) => ({
        updateOne: {
            filter: { ruleId: rule.ruleId },
            update: { $set: rule },
            upsert: true,
        },
    }));

    const result = await ClientRule.bulkWrite(bulkOps, { ordered: false });

    res.status(200).json({
        success: true,
        inserted: result.upsertedCount,
        updated:  result.modifiedCount,
        total:    rows.length,
        skipped:  skipped.length,
        skippedDetails: skipped,
    });
});
