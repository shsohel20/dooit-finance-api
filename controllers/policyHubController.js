const { default: axios } = require("axios");
const asyncHandler = require("../middleware/async");
const PolicyHub = require("../models/PolicyHub");
const ErrorResponse = require("../utils/errorResponse");
const htmlPdf = require("html-pdf");
import fs from "fs/promises";
/**
 * Filter helper for POST search
 */
exports.filterPolicyHubSection = (doc, requestBody, req) => {
    if (requestBody.docs) {
        return doc.docs?.toLowerCase().includes(requestBody.docs.toLowerCase());
    }
    return true;
};

// @desc    Get all policy hubs
// @route   GET /api/v1/policy-hub
// @access  Private (Admin)
exports.getPolicyHubs = asyncHandler(async (req, res) => {
    res.status(200).json(res.advancedResults);
});

// @desc    Get all policy hubs (POST filter)
// @route   POST /api/v1/policy-hub
// @access  Private (Admin)
exports.getPolicyHubsPost = asyncHandler(async (req, res) => {
    res.status(200).json(res.advancedResults);
});

// @desc    Create policy hub
// @route   POST /api/v1/policy-hub/new
// @access  Private (Admin)
exports.createPolicyHub = asyncHandler(async (req, res, next) => {
    const client = req?.user?.client?._id || null;
    const branch = req?.user?.branch?._id || null;

    if (!client) {
        return next(new ErrorResponse("Unauthorized client", 401));
    }

    const { docs, generatedBy = req.user?._id, metadata = {}, isActive = false } = req.body;

    const policyHub = await PolicyHub.create({
        client,
        branch,
        docs,
        generatedBy,
        metadata,
        isActive,
    });

    res.status(201).json({ success: true, data: policyHub });
});
// @desc    Create policy hub
// @route   POST /api/v1/policy-hub/generate
// @access  Private (Admin)
exports.generatePolicyHub = asyncHandler(async (req, res, next) => {

    const policyAMLApi = process.env.REPORT_AI_API_AML;

    const client = req?.user?.client?._id || null;
    const branch = req?.user?.branch?._id || null;



    if (!client) {
        return next(new ErrorResponse("Unauthorized client", 401));


    }
    const payload = {
        ...req.body
    }
    const policyAiEndPoint = `${policyAMLApi}/api/v1/generate-document/demo`;
    const response = await axios.post(policyAiEndPoint, payload, { timeout: 10000 });
    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data || {};
    const filePath = data?.file_path;
    console.log(data);

    // const { docs, generatedBy = req.user?._id, metadata = {}, isActive = false } = req.body;
    const content = await fs.readFile(filePath, "utf8");
    const policyHub = await PolicyHub.create({
        client,
        branch,
        docs: content,
        filePath: filePath,
        generatedBy: req.user?._id,
        metadata: {
            ...req.body,
            ...data
        },
        isActive: true,
    });

    res.status(201).json({ success: true, data: policyHub });
});

// @desc    Get single policy hub
// @route   GET /api/v1/policy-hub/:id
// @access  Private (Admin)
exports.getPolicyHub = asyncHandler(async (req, res, next) => {
    const policyHub = await policyHub.findById(req.params.id)
        .populate("client", "name")
        .populate("branch", "name")
        .populate("generatedBy", "name email");

    if (!policyHub) {
        return next(new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404));
    }

    res.status(200).json({ success: true, data: policyHub });
});

// @desc    Update policy hub
// @route   PUT /api/v1/policy-hub/:id
// @access  Private (Admin)
exports.updatePolicyHub = asyncHandler(async (req, res, next) => {
    let policyHub = await PolicyHub.findById(req.params.id);

    if (!policyHub) {
        return next(new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404));
    }

    policyHub = await PolicyHub.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
    });

    res.status(200).json({ success: true, data: policyHub });
});

// @desc    Delete policy hub
// @route   DELETE /api/v1/policy-hub/:id
// @access  Private (Admin)
exports.deletePolicyHub = asyncHandler(async (req, res, next) => {
    const policyHub = await PolicyHub.findById(req.params.id);

    if (!policyHub) {
        return next(new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404));
    }

    await policyHub.deleteOne();

    res.status(200).json({ success: true, data: req.params.id });
});


// @desc    Generate PDF from PolicyHub docs
// @route   GET /api/v1/policy-hub/:id/download
// @access  Private (Admin)
exports.downloadPolicyHubPDF = asyncHandler(async (req, res, next) => {
    const policyHub = await PolicyHub.findById(req.params.id);

    if (!policyHub) {
        return next(new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404));
    }

    // Get the rich text HTML
    const htmlContent = `
      <html>
        <head>
          <meta charset="utf-8">
          <title>PolicyHub Document</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            h1 { text-align: center; }
          </style>
        </head>
        <body>
          <h1>PolicyHub Document</h1>
          <div>${policyHub.docs}</div>
        </body>
      </html>
    `;

    const options = { format: "A4" };

    htmlPdf.create(htmlContent, options).toStream((err, pdfStream) => {
        if (err) {
            return next(new ErrorResponse("Error generating PDF", 500));
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=policyhub-${policyHub._id}.pdf`
        );

        pdfStream.pipe(res);
    });
});