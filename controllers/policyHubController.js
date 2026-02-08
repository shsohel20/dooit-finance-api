const { default: axios } = require("axios");
const asyncHandler = require("../middleware/async");
const PolicyHub = require("../models/PolicyHub");
const ErrorResponse = require("../utils/errorResponse");
const htmlPdf = require("html-pdf");
const fs = require("fs/promises");
const { marked } = require("marked");
const Diff = require("diff");
const PolicyHubVersion = require("../models/PolicyHubVersion");
const sanitizeHtml = require("sanitize-html");

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

  const {
    docs,
    filePath = "",
    generatedBy = req.user?._id,
    metadata = {},
    isActive = false,
  } = req.body;

  // create the main PolicyHub (leave versions empty — we'll create a separate version doc)
  const policyHub = await PolicyHub.create({
    client,
    branch,
    docs,
    filePath,
    generatedBy,
    metadata,
    isActive,
    versionNumber: 1,
    versions: [], // will hold ObjectId refs to PolicyHubVersion
  });

  // create a PolicyHubVersion document for version 1
  const versionDoc = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: 1,
    docs: docs || "",
    filePath: filePath || "",
    metadata: metadata || {},
    isActive: Boolean(isActive),
    editedBy: generatedBy,
    editReason: "initial-create",
  });

  // attach the version ref to the PolicyHub and save
  policyHub.versions = policyHub.versions || [];
  policyHub.versions.push(versionDoc._id);
  await policyHub.save();

  res.status(201).json({ success: true, data: policyHub });
});

// @desc    Generate policy hub
// @route   POST /api/v1/policy-hub/generate
// @access  Private (Admin)
exports.generatePolicyHub = asyncHandler(async (req, res, next) => {
  const policyAMLApi = process.env.REPORT_AI_API_AML;

  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  const payload = { ...req.body };
  const policyAiEndPoint = `${policyAMLApi}/api/v1/generate-document/demo`;

  let response;
  try {
    response = await axios.post(policyAiEndPoint, payload, { timeout: 10000 });
  } catch (err) {
    return next(
      new ErrorResponse("Error calling document generation API", 500),
    );
  }

  const data =
    typeof response.data === "string"
      ? JSON.parse(response.data)
      : response.data || {};

  let filePath = data?.file_path || data?.filePath || null;
  if (!filePath) {
    return next(
      new ErrorResponse("Generated file path not found in AI response", 500),
    );
  }

  // Replace root path with safer relative path (only if present)
  filePath = filePath.replace(
    "/root/strikeo/strikeo-afc-ai/afc-document-generation/app/output",
    "/app/output",
  );

  // Read Markdown file
  let markdownContent;
  try {
    markdownContent = await fs.readFile(filePath, "utf8");
  } catch (err) {
    return next(new ErrorResponse("Failed to read generated file", 500));
  }

  const unsafeHtml = marked.parse(markdownContent);

  // Convert Markdown → sanitized HTML
  const htmlContent = sanitizeHtml(unsafeHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "h1",
      "h2",
      "h3",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ]),
    allowedAttributes: {
      a: ["href", "name", "target"],
      img: ["src", "alt", "width", "height"],
    },
  });

  // Build metadata for the policyHub
  const combinedMetadata = {
    source: "ai",
    model: data?.model || "unknown",
    promptVersion: "v1",
    requestedBy: req.user?._id,
    generatedAt: new Date(),
    ...req.body,
    ...data,
  };

  // Create the main PolicyHub document (versions kept empty — version stored separately)
  const policyHub = await PolicyHub.create({
    client,
    branch,
    docs: htmlContent,
    filePath,
    generatedBy: req.user?._id,
    metadata: combinedMetadata,
    isActive: true,
    versionNumber: 1,
    versions: [], // will store ObjectId ref to PolicyHubVersion
  });

  // Create the separate PolicyHubVersion document for version 1
  const versionDoc = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: 1,
    docs: htmlContent,
    filePath,
    metadata: data,
    isActive: true,
    editedBy: req.user?._id,
    editReason: "ai-generation",
  });

  // Attach version ref to main doc and save
  policyHub.versions = policyHub.versions || [];
  policyHub.versions.push(versionDoc._id);
  await policyHub.save();

  // Return populated PolicyHub (with the new version populated)
  const populated = await PolicyHub.findById(policyHub._id)
    .populate({
      path: "versions",
      populate: { path: "editedBy", select: "name email" },
    })
    .populate("generatedBy", "name email");

  res.status(201).json({ success: true, data: populated });
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
    return next(
      new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404),
    );
  }

  res.status(200).json({ success: true, data: policyHub });
});

// @desc    Update policy hub
// @route   PUT /api/v1/policy-hub/:id
// @access  Private (Admin)
// controllers/policyHubController.js (updated updatePolicyHub)
exports.updatePolicyHub = asyncHandler(async (req, res, next) => {
  const policyHub = await PolicyHub.findById(req.params.id);
  if (!policyHub)
    return next(
      new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404),
    );

  // Snapshot current state to new version document
  const snapshot = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: policyHub.versionNumber || 1,
    docs: policyHub.docs,
    filePath: policyHub.filePath,
    metadata: policyHub.metadata,
    isActive: policyHub.isActive,
    editedBy: req.user?._id || null,
    editReason: req.body.editReason || "update-snapshot",
  });

  // push snapshot id
  policyHub.versions = policyHub.versions || [];
  policyHub.versions.push(snapshot._id);

  // Apply incoming updates
  const { docs, filePath, metadata, isActive } = req.body;
  if (docs !== undefined) policyHub.docs = docs;
  if (filePath !== undefined) policyHub.filePath = filePath;
  if (metadata !== undefined)
    policyHub.metadata = {
      ...policyHub.metadata,
      ...metadata,
      editedBy: req.user?._id || null,
    };
  if (isActive !== undefined) policyHub.isActive = isActive;

  // increment version number for the changed main doc
  policyHub.versionNumber = (policyHub.versionNumber || 1) + 1;

  await policyHub.save();

  res.status(200).json({ success: true, data: policyHub });
});

// controllers/policyHubController.js (new functions)

// GET /api/v1/policy-hub/:id/versions
exports.listPolicyHubVersions = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  // basic pagination
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  const query = { policyHub: id };
  const total = await PolicyHubVersion.countDocuments(query);
  const versions = await PolicyHubVersion.find(query)
    .sort({ versionNumber: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate("editedBy", "name email");

  res.status(200).json({ success: true, data: versions, total, page, limit });
});

// GET /api/v1/policy-hub/:id/versions/:versionNumber
exports.getPolicyHubVersion = asyncHandler(async (req, res, next) => {
  const { id, versionNumber } = req.params;
  const version = await PolicyHubVersion.findOne({
    policyHub: id,
    versionNumber,
  }).populate("editedBy", "name email");
  if (!version) return next(new ErrorResponse("Version not found", 404));
  res.status(200).json({ success: true, data: version });
});

// POST /api/v1/policy-hub/:id/restore/:versionNumber
exports.restorePolicyHubVersion = asyncHandler(async (req, res, next) => {
  const { id, versionNumber } = req.params;
  const policyHub = await PolicyHub.findById(id);
  if (!policyHub) return next(new ErrorResponse("Not found", 404));

  const version = await PolicyHubVersion.findOne({
    policyHub: id,
    versionNumber,
  });
  if (!version) return next(new ErrorResponse("Version not found", 404));

  // snapshot current state
  const snapshot = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: policyHub.versionNumber || 1,
    docs: policyHub.docs,
    filePath: policyHub.filePath,
    metadata: policyHub.metadata,
    isActive: policyHub.isActive,
    editedBy: req.user?._id || null,
    editReason: `auto-restore-snapshot-from-${versionNumber}`,
  });
  policyHub.versions = policyHub.versions || [];
  policyHub.versions.push(snapshot._id);

  // apply selected version to main document
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
  const { v1, v2 } = req.query;

  // fetch policyHub for current if needed
  const policyHub = await PolicyHub.findById(id).select("docs versionNumber");
  if (!policyHub) return next(new ErrorResponse("Not found id", 404));

  const getVersionContent = async (num) => {
    if (String(num) === String(policyHub.versionNumber)) return policyHub.docs;
    const v = await PolicyHubVersion.findOne({
      policyHub: id,
      versionNumber: num,
    });
    return v ? v.docs : null;
  };

  const left = await getVersionContent(v1);
  const right = await getVersionContent(v2);
  if (left === null || right === null)
    return next(new ErrorResponse("One or both versions not found", 404));

  const diff = Diff.createPatch("docs", left, right);
  res.status(200).json({ success: true, data: { patch: diff } });
});

// @desc    Delete policy hub
// @route   DELETE /api/v1/policy-hub/:id
// @access  Private (Admin)
exports.deletePolicyHub = asyncHandler(async (req, res, next) => {
  const policyHub = await PolicyHub.findById(req.params.id);

  if (!policyHub) {
    return next(
      new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404),
    );
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
    return next(
      new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404),
    );
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
      `attachment; filename=policyhub-${policyHub._id}.pdf`,
    );

    pdfStream.pipe(res);
  });
});
