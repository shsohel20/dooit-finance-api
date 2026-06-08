const asyncHandler = require("../middleware/async");
const PolicyHubTemplate = require("../models/PolicyHubTemplate");
const PolicyHub = require("../models/PolicyHub");
const PolicyHubVersion = require("../models/PolicyHubVersion");
const ErrorResponse = require("../utils/errorResponse");
const mammoth = require("mammoth");
const HTMLtoDOCX = require("html-to-docx");
const { docxToHtml } = require("../utils/docxToHtml");
const puppeteer = require("puppeteer");

/**
 * Filter helper for POST search on templates
 */
exports.filterPolicyHubTemplateSection = (doc, requestBody) => {
  if (requestBody.name) {
    return doc.name?.toLowerCase().includes(requestBody.name.toLowerCase());
  }
  if (requestBody.docs) {
    return doc.docs?.toLowerCase().includes(requestBody.docs.toLowerCase());
  }
  return true;
};

// @desc    Get all templates
// @route   GET /api/v1/policy-hub-templates
// @access  Private (Admin)
exports.getTemplates = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

// @desc    Get all templates (POST filter)
// @route   POST /api/v1/policy-hub-templates
// @access  Private (Admin)
exports.getTemplatesPost = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

// @desc    Get single template
// @route   GET /api/v1/policy-hub-templates/:id
// @access  Private (Admin)
exports.getTemplate = asyncHandler(async (req, res, next) => {
  const template = await PolicyHubTemplate.findById(req.params.id)
    .populate("client", "name")
    .populate("branch", "name")
    .populate("createdBy", "name email")
    .populate("sourcePolicyHub", "metadata versionNumber");

  if (!template) {
    return next(new ErrorResponse(`Template not found with id ${req.params.id}`, 404));
  }

  res.status(200).json({ success: true, data: template });
});

// @desc    Create template directly
// @route   POST /api/v1/policy-hub-templates/new
// @access  Private (Admin)
exports.createTemplate = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  const { name, description = "", docs = "", metadata = {}, tags = [], isGlobal = false } = req.body;

  if (!name) {
    return next(new ErrorResponse("Template name is required", 400));
  }

  const template = await PolicyHubTemplate.create({
    client,
    branch,
    name,
    description,
    docs,
    metadata,
    tags,
    isGlobal,
    createdBy: req.user?._id,
  });

  res.status(201).json({ success: true, data: template });
});

// @desc    Save existing PolicyHub as a template
// @route   POST /api/v1/policy-hub/:id/save-as-template
// @access  Private (Admin)
exports.saveAsTemplate = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  const policyHub = await PolicyHub.findById(req.params.id);
  if (!policyHub) {
    return next(new ErrorResponse(`PolicyHub not found with id ${req.params.id}`, 404));
  }

  const { name, description = "", tags = [], isGlobal = false } = req.body;

  if (!name) {
    return next(new ErrorResponse("Template name is required", 400));
  }

  const template = await PolicyHubTemplate.create({
    client,
    branch,
    name,
    description,
    docs: policyHub.docs,
    metadata: policyHub.metadata || {},
    tags,
    isGlobal,
    sourcePolicyHub: policyHub._id,
    createdBy: req.user?._id,
  });

  res.status(201).json({ success: true, data: template });
});

// @desc    Create a new PolicyHub from a template
// @route   POST /api/v1/policy-hub-templates/:id/use
// @access  Private (Admin)
exports.useTemplate = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  const template = await PolicyHubTemplate.findById(req.params.id);
  if (!template) {
    return next(new ErrorResponse(`Template not found with id ${req.params.id}`, 404));
  }

  // Merge template metadata with any overrides from request body
  const mergedMetadata = {
    ...template.metadata,
    ...(req.body.metadata || {}),
    source: "template",
    templateId: template._id,
    templateName: template.name,
  };

  const policyHub = await PolicyHub.create({
    client,
    branch,
    docs: template.docs,
    filePath: "",
    generatedBy: req.user?._id,
    metadata: mergedMetadata,
    isActive: false,
    status: "completed",
    versionNumber: 1,
    versions: [],
  });

  // Create initial version document
  const versionDoc = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: 1,
    docs: template.docs,
    filePath: "",
    metadata: mergedMetadata,
    isActive: false,
    editedBy: req.user?._id,
    editReason: `created-from-template:${template._id}`,
  });

  policyHub.versions.push(versionDoc._id);
  await policyHub.save();

  res.status(201).json({ success: true, data: policyHub });
});

// @desc    Update template
// @route   PUT /api/v1/policy-hub-templates/:id
// @access  Private (Admin)
exports.updateTemplate = asyncHandler(async (req, res, next) => {
  const template = await PolicyHubTemplate.findById(req.params.id);
  if (!template) {
    return next(new ErrorResponse(`Template not found with id ${req.params.id}`, 404));
  }

  const { name, description, docs, metadata, tags, isGlobal } = req.body;

  if (name !== undefined) template.name = name;
  if (description !== undefined) template.description = description;
  if (docs !== undefined) template.docs = docs;
  if (metadata !== undefined) template.metadata = { ...template.metadata, ...metadata };
  if (tags !== undefined) template.tags = tags;
  if (isGlobal !== undefined) template.isGlobal = isGlobal;

  await template.save();

  res.status(200).json({ success: true, data: template });
});

// @desc    Delete template
// @route   DELETE /api/v1/policy-hub-templates/:id
// @access  Private (Admin)
exports.deleteTemplate = asyncHandler(async (req, res, next) => {
  const template = await PolicyHubTemplate.findById(req.params.id);
  if (!template) {
    return next(new ErrorResponse(`Template not found with id ${req.params.id}`, 404));
  }

  await template.deleteOne();

  res.status(200).json({ success: true, data: req.params.id });
});

// @desc    Import a .docx file and create a template from it
// @route   POST /api/v1/policy-hub-templates/import-docx
// @access  Private (Admin)
exports.importFromDocx = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  if (!req.file) {
    return next(new ErrorResponse("No .docx file uploaded", 400));
  }

  const { name, description = "", tags = [], isGlobal = false, metadata = {} } = req.body;

  if (!name) {
    return next(new ErrorResponse("Template name is required", 400));
  }

  // Convert .docx buffer → pixel-faithful HTML (inline styles, images, tables)
  const { html: htmlContent, warnings } = await docxToHtml(req.file.buffer);
  if (!htmlContent) {
    return next(new ErrorResponse("Failed to parse .docx file", 422));
  }

  const template = await PolicyHubTemplate.create({
    client,
    branch,
    name,
    description,
    docs: htmlContent,
    metadata: typeof metadata === "string" ? JSON.parse(metadata) : metadata,
    tags: typeof tags === "string" ? JSON.parse(tags) : tags,
    isGlobal: isGlobal === "true" || isGlobal === true,
    createdBy: req.user?._id,
  });

  res.status(201).json({ success: true, data: template });
});

// @desc    Export a template's docs as a .docx file
// @route   GET /api/v1/policy-hub-templates/:id/export-docx
// @access  Private (Admin)
exports.exportToDocx = asyncHandler(async (req, res, next) => {
  const template = await PolicyHubTemplate.findById(req.params.id);
  if (!template) {
    return next(new ErrorResponse(`Template not found with id ${req.params.id}`, 404));
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${template.docs}</body></html>`;

  const docxBuffer = await HTMLtoDOCX(html, null, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  });

  const filename = `template-${template._id}.docx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(docxBuffer);
});

// @desc    Export a template's docs as a PDF file
// @route   GET /api/v1/policy-hub-templates/:id/export-pdf
// @access  Private (Admin)
exports.exportToPdf = asyncHandler(async (req, res, next) => {
  const template = await PolicyHubTemplate.findById(req.params.id);
  if (!template) {
    return next(new ErrorResponse(`Template not found with id ${req.params.id}`, 404));
  }

  const htmlContent = `
    <html>
      <head>
        <meta charset="utf-8">
        <title>${template.name}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          h1 { text-align: center; }
        </style>
      </head>
      <body>
        <h1>${template.name}</h1>
        <div>${template.docs}</div>
      </body>
    </html>
  `;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({ format: "A4" });

    const filename = `template-${template._id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    return next(new ErrorResponse("Error generating PDF", 500));
  } finally {
    if (browser) await browser.close();
  }
});
