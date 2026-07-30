const { default: axios } = require("axios");
const asyncHandler = require("../middleware/async");
const PolicyHub = require("../models/PolicyHub");
const ErrorResponse = require("../utils/errorResponse");
const { launchPdfBrowser } = require("../utils/puppeteerLaunch");
const fs = require("fs/promises");
const { marked } = require("marked");
const Diff = require("diff");
const PolicyHubVersion = require("../models/PolicyHubVersion");
const { importDocxToHtml, sanitizeForEditor } = require("../utils/docxImportService");
const { convertHtmlToDocx } = require("../utils/docxExportService");

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

// @desc    Trigger AI document generation, returns a pending PolicyHub immediately
// @route   POST /api/v1/policy-hub/generate
// @access  Private (Admin)
exports.generatePolicyHub = asyncHandler(async (req, res, next) => {
  const policyAMLApi = process.env.REPORT_AI_API_AML;
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  // Return existing pending record if one already exists for the same client + key fields
  const duplicateFilter = { client, status: "pending" };
  if (req.body.document_type) duplicateFilter["metadata.document_type"] = req.body.document_type;
  if (req.body.name)          duplicateFilter["metadata.name"]          = req.body.name;
  if (req.body.industry)      duplicateFilter["metadata.industry"]      = req.body.industry;
  const existing = await PolicyHub.findOne(duplicateFilter);
  if (existing) {
    return res
      .status(200)
      .json({ success: true, data: existing, pending: true });
  }

  // Create a pending record so the client has an ID to poll/track
  const policyHub = await PolicyHub.create({
    client,
    branch,
    docs: "",
    filePath: "",
    generatedBy: req.user?._id,
    metadata: {
      source: "ai",
      promptVersion: "v1",
      requestedBy: req.user?._id,
      generatedAt: new Date(),
      ...req.body,
    },
    status: "pending",
    isActive: false,
    versionNumber: 1,
    versions: [],
  });

  // Build webhook callback URL so the AI service can POST results back
  const webhookUrl = `${process.env.BASE_URL}/api/v1/policy-hub/${policyHub._id}/webhook`;
  const policyAiEndPoint = `${policyAMLApi}/api/v1/generate-document`;

  try {
    await axios.post(
      policyAiEndPoint,
      { ...req.body, webhook_url: webhookUrl },
      { timeout: 15000 },
    );
  } catch (err) {
    policyHub.status = "failed";
    await policyHub.save();
    return next(
      new ErrorResponse("Error calling document generation API", 500),
    );
  }

  res.status(201).json({ success: true, data: policyHub });
});

// @desc    Receive AI-generated document via webhook and update the PolicyHub
// @route   POST /api/v1/policy-hub/:id/webhook
// @access  Public (webhook secret required)
exports.generatePolicyHubWebHook = asyncHandler(async (req, res, next) => {
  // Validate webhook secret to ensure the call is from the AI service
  // const secret =
  //   req.headers["x-webhook-secret"] || req.query.token;
  // if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
  //   return next(new ErrorResponse("Unauthorized webhook request", 401));
  // }

  const policyHub = await PolicyHub.findById(req.params.id);
  if (!policyHub) {
    return next(new ErrorResponse("PolicyHub not found", 404));
  }

  const { file_path, content_md, metadata } = req.body;

  if (!content_md) {
    return next(
      new ErrorResponse("Missing content_md in webhook payload", 400),
    );
  }

  // Convert Markdown → sanitized HTML (shared formatting-preserving sanitizer)
  const unsafeHtml = marked.parse(content_md);
  const htmlContent = sanitizeForEditor(unsafeHtml);

  // Create a version document for the generated content
  const versionDoc = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: policyHub.versionNumber || 1,
    docs: htmlContent,
    filePath: file_path || "",
    metadata: metadata || {},
    isActive: true,
    editedBy: policyHub.generatedBy,
    editReason: "ai-generation",
  });

  // Update the PolicyHub with the generated content
  policyHub.docs = htmlContent;
  policyHub.filePath = file_path || "";
  policyHub.metadata = { ...policyHub.metadata, ...(metadata || {}) };
  policyHub.status = "completed";
  policyHub.isActive = true;
  policyHub.versions = policyHub.versions || [];
  policyHub.versions.push(versionDoc._id);
  await policyHub.save();

  const populated = await PolicyHub.findById(policyHub._id)
    .populate({
      path: "versions",
      populate: { path: "editedBy", select: "name email" },
    })
    .populate("generatedBy", "name email");

  res.status(200).json({ success: true, data: populated });
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
const nextVersionNumberFor = async (policyHubId) => {
  const latest = await PolicyHubVersion.findOne({ policyHub: policyHubId })
    .sort({ versionNumber: -1 })
    .select("versionNumber")
    .lean();
  return (latest?.versionNumber || 0) + 1;
};

exports.updatePolicyHub = asyncHandler(async (req, res, next) => {
  const policyHub = await PolicyHub.findById(req.params.id);
  if (!policyHub)
    return next(
      new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404),
    );

  // Use the actual next available version to avoid duplicate key on the unique index
  const nextVN = await nextVersionNumberFor(policyHub._id);

  const snapshot = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: nextVN,
    docs: policyHub.docs,
    filePath: policyHub.filePath,
    metadata: policyHub.metadata,
    isActive: policyHub.isActive,
    editedBy: req.user?._id || null,
    editReason: req.body.editReason || "update-snapshot",
  });

  policyHub.versions = policyHub.versions || [];
  policyHub.versions.push(snapshot._id);

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

  policyHub.versionNumber = nextVN;

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
  const nextVN = await nextVersionNumberFor(policyHub._id);

  const snapshot = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: nextVN,
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
  policyHub.versionNumber = nextVN;

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

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({ format: "A4" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=policyhub-${policyHub._id}.pdf`,
    );
    res.send(pdfBuffer);
  } catch (err) {
    return next(new ErrorResponse("Error generating PDF", 500));
  } finally {
    if (browser) await browser.close();
  }
});

// @desc    Export PolicyHub docs as a .docx file
// @route   GET /api/v1/policy-hub/:id/export-docx
// @access  Private (Admin)
exports.exportPolicyHubDocx = asyncHandler(async (req, res, next) => {
  const policyHub = await PolicyHub.findById(req.params.id);
  if (!policyHub) {
    return next(new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404));
  }

  const { buffer: docxBuffer } = await convertHtmlToDocx(policyHub.docs, {
    title: policyHub.metadata?.name || "Policy",
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename=policyhub-${policyHub._id}.docx`);
  res.send(docxBuffer);
});

// @desc    Import a .docx file and create a new PolicyHub from it
// @route   POST /api/v1/policy-hub/import-docx
// @access  Private (Admin)
exports.importPolicyHubDocx = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  if (!req.file) {
    return next(new ErrorResponse("No .docx file uploaded", 400));
  }

  // Convert .docx buffer → fidelity-preserving HTML (shared import pipeline)
  const { html: htmlContent } = await importDocxToHtml(req.file.buffer);

  const metadata = req.body.metadata
    ? (typeof req.body.metadata === "string" ? JSON.parse(req.body.metadata) : req.body.metadata)
    : {};

  const policyHub = await PolicyHub.create({
    client,
    branch,
    docs: htmlContent,
    filePath: "",
    generatedBy: req.user?._id,
    metadata: { source: "docx-import", ...metadata },
    isActive: false,
    status: "completed",
    versionNumber: 1,
    versions: [],
  });

  const versionDoc = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: 1,
    docs: htmlContent,
    filePath: "",
    metadata: policyHub.metadata,
    isActive: false,
    editedBy: req.user?._id,
    editReason: "docx-import",
  });

  policyHub.versions.push(versionDoc._id);
  await policyHub.save();

  res.status(201).json({ success: true, data: policyHub });
});
