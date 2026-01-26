const { default: axios } = require("axios");
const asyncHandler = require("../middleware/async");
const PolicyHub = require("../models/PolicyHub");
const ErrorResponse = require("../utils/errorResponse");
const htmlPdf = require("html-pdf");
const fs = require("fs/promises");
const { marked } = require("marked");
const Diff = require("diff");
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
        versionNumber: 1,
        versions: [
            {
                versionNumber: 1,
                docs,
                metadata,
                isActive,
                editedBy: generatedBy,
                editReason: "initial-create",
            },
        ],
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
    let filePath = data?.file_path;

    // Replace root path with safer relative path
    filePath = filePath.replace(
        "/root/strikeo/strikeo-afc-ai/afc-document-generation/app/output",
        "/app/output"
    );
    console.log(data);

    //PathReplacing
    ///root/strikeo/strikeo-afc-ai/afc-document-generation/app/output
    //app/outpu instead of /root/strikeo/strikeo-afc-ai/afc-document-generation/app/output
    // 📄 Read Markdown file
    const markdownContent = await fs.readFile(filePath, "utf8");

    // 🔥 Convert Markdown → HTML (string)
    const htmlContent = marked.parse(markdownContent);

    // const { docs, generatedBy = req.user?._id, metadata = {}, isActive = false } = req.body;
    // const content = await fs.readFile(filePath, "utf8");
    const policyHub = await PolicyHub.create({
        client,
        branch,
        docs: htmlContent,
        filePath,
        generatedBy: req.user?._id,
        metadata: {
            source: "ai",
            model: data?.model || "unknown",
            promptVersion: "v1",
            requestedBy: req.user?._id,
            generatedAt: new Date(),
            ...req.body,
            ...data,
        },
        isActive: true,
        versionNumber: 1,
        versions: [
            {
                versionNumber: 1,
                docs: htmlContent,
                filePath,
                metadata: data,
                editedBy: req.user?._id,
                editReason: "ai-generation",
            },
        ],
    });

    res.status(201).json({ success: true, data: policyHub });
});

// @desc    Get single policy hub
// @route   GET /api/v1/policy-hub/:id
// @access  Private (Admin)
exports.getPolicyHub = asyncHandler(async (req, res, next) => {
    const policyHub = await PolicyHub.findById(req.params.id)
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
// controllers/policyHubController.js (updated updatePolicyHub)
exports.updatePolicyHub = asyncHandler(async (req, res, next) => {
    const policyHub = await PolicyHub.findById(req.params.id);
    if (!policyHub) {
        return next(new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404));
    }

    // Create a version snapshot of the current state
    const nextVersionNumber = (policyHub.versionNumber || 1) + 1;
    const snapshot = {
        versionNumber: policyHub.versionNumber || 1,
        docs: policyHub.docs,
        filePath: policyHub.filePath,
        metadata: policyHub.metadata,
        isActive: policyHub.isActive,
        createdAt: new Date(),
        editedBy: req.user?._id || null,
        editReason: req.body.editReason || "update", // allow client to pass reason
    };

    // Push snapshot then update fields
    policyHub.versions = policyHub.versions || [];
    policyHub.versions.push(snapshot);

    // Apply incoming updates (only allowed fields)
    const allowed = ["docs", "filePath", "metadata", "isActive"];
    allowed.forEach((k) => {
        if (req.body[k] !== undefined) policyHub[k] = req.body[k];
    });

    policyHub.versionNumber = nextVersionNumber;

    await policyHub.save();

    res.status(200).json({ success: true, data: policyHub });
});

// controllers/policyHubController.js (new functions)

// GET /api/v1/policy-hub/:id/versions
exports.listPolicyHubVersions = asyncHandler(async (req, res, next) => {
    const policyHub = await PolicyHub.findById(req.params.id).select("versions versionNumber");
    console.log({ policyHub })
    if (!policyHub) return next(new ErrorResponse("Not found", 404));
    res.status(200).json({ success: true, data: policyHub.versions || [], currentVersion: policyHub.versionNumber });
});

// GET /api/v1/policy-hub/:id/versions/:versionNumber
exports.getPolicyHubVersion = asyncHandler(async (req, res, next) => {
    const { id, versionNumber } = req.params;
    const policyHub = await PolicyHub.findById(id).select("versions versionNumber");
    if (!policyHub) return next(new ErrorResponse("Not found", 404));
    const version = policyHub.versions.find(v => String(v.versionNumber) === String(versionNumber));
    if (!version) return next(new ErrorResponse("Version not found", 404));
    res.status(200).json({ success: true, data: version });
});

// POST /api/v1/policy-hub/:id/restore/:versionNumber
exports.restorePolicyHubVersion = asyncHandler(async (req, res, next) => {
    const { id, versionNumber } = req.params;
    const policyHub = await PolicyHub.findById(id);
    if (!policyHub) return next(new ErrorResponse("Not found", 404));

    const version = policyHub.versions.find(v => String(v.versionNumber) === String(versionNumber));
    if (!version) return next(new ErrorResponse("Version not found", 404));

    // Push current into versions as snapshot before restore
    const snapshot = {
        versionNumber: policyHub.versionNumber || 1,
        docs: policyHub.docs,
        filePath: policyHub.filePath,
        metadata: policyHub.metadata,
        isActive: policyHub.isActive,
        createdAt: new Date(),
        editedBy: req.user?._id || null,
        editReason: `auto-restore-from-${versionNumber}`,
    };

    policyHub.versions.push(snapshot);

    // Restore fields from selected version
    policyHub.docs = version.docs;
    policyHub.filePath = version.filePath;
    policyHub.metadata = version.metadata;
    policyHub.isActive = version.isActive;
    policyHub.versionNumber = (policyHub.versionNumber || 1) + 1;

    await policyHub.save();

    res.status(200).json({ success: true, data: policyHub });
});



exports.diffPolicyHubVersions = asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    const { v1, v2 } = req.query; // pass ?v1=1&v2=3

    const policyHub = await PolicyHub.findById(id).select("versions docs versionNumber");
    if (!policyHub) return next(new ErrorResponse("Not found id", 404));

    const getVersionContent = (num) => {
        if (String(num) === String(policyHub.versionNumber)) return policyHub.docs;
        const v = policyHub.versions.find(pv => String(pv.versionNumber) === String(num));
        return v ? v.docs : null;
    };

    const left = getVersionContent(v1);
    const right = getVersionContent(v2);
    if (left === null || right === null) return next(new ErrorResponse("One or both versions not found", 404));

    const diff = Diff.createPatch("docs", left, right);
    res.status(200).json({ success: true, data: { patch: diff } });
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