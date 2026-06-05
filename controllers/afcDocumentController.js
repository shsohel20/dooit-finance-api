const asyncHandler = require("../middleware/async");
const AfcDocument = require("../models/AfcDocument");
const PolicyHub = require("../models/PolicyHub");
const PolicyHubVersion = require("../models/PolicyHubVersion");
const ErrorResponse = require("../utils/errorResponse");
const puppeteer = require("puppeteer");
const { marked } = require("marked");
const HTMLtoDOCX = require("html-to-docx");
const mammoth = require("mammoth");
const sanitizeHtml = require("sanitize-html");

const SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "h2", "h3", "img", "table", "thead", "tbody", "tr", "th", "td"]),
  allowedAttributes: {
    a: ["href", "name", "target"],
    img: ["src", "alt", "width", "height"],
  },
};

const normalizeMetadata = (metadata = {}) => ({
  company: metadata.company || "",
  industry: metadata.industry || "",
  documentType: metadata.document_type || metadata.documentType || "",
  complianceOfficer: metadata.compliance_officer || metadata.complianceOfficer || "",
  version: metadata.version || 1,
  model: metadata.model || "",
  generatedAt: metadata.generated_at || metadata.generatedAt || null,
});

exports.filterAfcDocumentSection = (doc, requestBody) => {
  if (requestBody.contentMd) {
    return doc.contentMd?.toLowerCase().includes(requestBody.contentMd.toLowerCase());
  }
  return true;
};

// @desc    Get all AFC documents
// @route   GET /api/v1/afc-documents
// @access  Private (Admin)
exports.getAfcDocuments = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

// @desc    Get all AFC documents (POST filter)
// @route   POST /api/v1/afc-documents
// @access  Private (Admin)
exports.getAfcDocumentsPost = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

// @desc    Create AFC document
// @route   POST /api/v1/afc-documents/new
// @access  Private (Admin)
exports.createAfcDocument = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  const {
    file_path, filePath,
    content_md, contentMd,
    content_b64, contentB64,
    metadata = {},
    status = "completed",
  } = req.body;

  const doc = await AfcDocument.create({
    client,
    branch,
    filePath: file_path || filePath || "",
    contentMd: content_md || contentMd || "",
    contentB64: content_b64 || contentB64 || "",
    metadata: normalizeMetadata(metadata),
    status,
    createdBy: req.user?._id,
  });

  res.status(201).json({ success: true, data: doc });
});

// @desc    Get single AFC document
// @route   GET /api/v1/afc-documents/:id
// @access  Private (Admin)
exports.getAfcDocument = asyncHandler(async (req, res, next) => {
  const doc = await AfcDocument.findById(req.params.id)
    .populate("client", "name")
    .populate("branch", "name")
    .populate("createdBy", "name email");

  if (!doc) {
    return next(new ErrorResponse(`AFC document not found with id ${req.params.id}`, 404));
  }

  res.status(200).json({ success: true, data: doc });
});

// @desc    Update AFC document
// @route   PUT /api/v1/afc-documents/:id
// @access  Private (Admin)
exports.updateAfcDocument = asyncHandler(async (req, res, next) => {
  const doc = await AfcDocument.findById(req.params.id);

  if (!doc) {
    return next(new ErrorResponse(`AFC document not found with id ${req.params.id}`, 404));
  }

  const {
    file_path, filePath,
    content_md, contentMd,
    content_b64, contentB64,
    metadata,
    status,
  } = req.body;

  if (file_path !== undefined || filePath !== undefined)
    doc.filePath = file_path || filePath;
  if (content_md !== undefined || contentMd !== undefined)
    doc.contentMd = content_md || contentMd;
  if (content_b64 !== undefined || contentB64 !== undefined)
    doc.contentB64 = content_b64 || contentB64;
  if (status !== undefined) doc.status = status;
  if (metadata !== undefined) {
    doc.metadata = {
      company:           metadata.company           ?? doc.metadata.company,
      industry:          metadata.industry          ?? doc.metadata.industry,
      documentType:      metadata.document_type     ?? metadata.documentType      ?? doc.metadata.documentType,
      complianceOfficer: metadata.compliance_officer ?? metadata.complianceOfficer ?? doc.metadata.complianceOfficer,
      version:           metadata.version           ?? doc.metadata.version,
      model:             metadata.model             ?? doc.metadata.model,
      generatedAt:       metadata.generated_at      ?? metadata.generatedAt       ?? doc.metadata.generatedAt,
    };
  }

  await doc.save();

  res.status(200).json({ success: true, data: doc });
});

// @desc    Delete AFC document
// @route   DELETE /api/v1/afc-documents/:id
// @access  Private (Admin)
exports.deleteAfcDocument = asyncHandler(async (req, res, next) => {
  const doc = await AfcDocument.findById(req.params.id);

  if (!doc) {
    return next(new ErrorResponse(`AFC document not found with id ${req.params.id}`, 404));
  }

  await doc.deleteOne();

  res.status(200).json({ success: true, data: req.params.id });
});

// @desc    Download AFC document as PDF
// @route   GET /api/v1/afc-documents/:id/download
// @access  Private (Admin)
exports.downloadAfcDocumentPDF = asyncHandler(async (req, res, next) => {
  const doc = await AfcDocument.findById(req.params.id);
  if (!doc) {
    return next(new ErrorResponse(`AFC document not found with id ${req.params.id}`, 404));
  }

  const htmlBody = marked.parse(doc.contentMd || "");
  const html = `
    <html>
      <head>
        <meta charset="utf-8">
        <title>AFC Document</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; line-height: 1.6; }
          h1, h2, h3 { color: #1a1a1a; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
        </style>
      </head>
      <body>${htmlBody}</body>
    </html>
  `;

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({ format: "A4" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=afc-document-${doc._id}.pdf`);
    res.send(pdfBuffer);
  } catch (err) {
    return next(new ErrorResponse("Error generating PDF", 500));
  } finally {
    if (browser) await browser.close();
  }
});

// @desc    Export AFC document as .docx
// @route   GET /api/v1/afc-documents/:id/export-docx
// @access  Private (Admin)
exports.exportAfcDocumentDocx = asyncHandler(async (req, res, next) => {
  const doc = await AfcDocument.findById(req.params.id);
  if (!doc) {
    return next(new ErrorResponse(`AFC document not found with id ${req.params.id}`, 404));
  }

  const htmlBody = marked.parse(doc.contentMd || "");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${htmlBody}</body></html>`;

  const docxBuffer = await HTMLtoDOCX(html, null, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename=afc-document-${doc._id}.docx`);
  res.send(docxBuffer);
});

// @desc    Import a .docx and create a new AFC document
// @route   POST /api/v1/afc-documents/import-docx
// @access  Private (Admin)
exports.importAfcDocumentDocx = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  if (!req.file) {
    return next(new ErrorResponse("No .docx file uploaded", 400));
  }

  const result = await mammoth.convertToHtml({ buffer: req.file.buffer });
  const htmlContent = sanitizeHtml(result.value, SANITIZE_OPTIONS);

  const metadata = req.body.metadata
    ? (typeof req.body.metadata === "string" ? JSON.parse(req.body.metadata) : req.body.metadata)
    : {};

  const doc = await AfcDocument.create({
    client,
    branch,
    filePath: "",
    contentMd: htmlContent,
    contentB64: Buffer.from(htmlContent).toString("base64"),
    metadata: normalizeMetadata({ source: "docx-import", ...metadata }),
    status: "completed",
    createdBy: req.user?._id,
  });

  res.status(201).json({ success: true, data: doc });
});

// @desc    Upsert by filePath — used by the AI service webhook
// @route   POST /api/v1/afc-documents/upsert
// @access  Public (webhook)
exports.upsertAfcDocument = asyncHandler(async (req, res, next) => {
  const { _id, file_path, content_md, content_b64, metadata = {} } = req.body;

  const filePath = _id || file_path;
  if (!filePath) {
    return next(new ErrorResponse("file_path or _id is required", 400));
  }

  const update = {
    filePath,
    contentMd: content_md || "",
    contentB64: content_b64 || "",
    metadata: normalizeMetadata(metadata),
    status: "completed",
  };

  const doc = await AfcDocument.findOneAndUpdate(
    { filePath },
    { $set: update },
    { new: true, upsert: true, runValidators: true }
  );

  res.status(200).json({ success: true, data: doc });
});

// @desc    Push AFC document content into a new PolicyHub
// @route   POST /api/v1/afc-documents/:id/to-policy-hub
// @access  Private (Admin)
exports.afcDocumentToPolicyHub = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  if (!client) {
    return next(new ErrorResponse("Unauthorized client", 401));
  }

  const afcDoc = await AfcDocument.findById(req.params.id);
  if (!afcDoc) {
    return next(new ErrorResponse(`AFC document not found with id ${req.params.id}`, 404));
  }

  // Convert markdown → sanitized HTML
  const rawHtml = marked.parse(afcDoc.contentMd || "");
  const htmlContent = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);

  const {
    isActive = false,
    editReason = "afc-import",
    company,
    industry,
    documentType,
    complianceOfficer,
    model,
  } = req.body;

  const policyHub = await PolicyHub.create({
    client,
    branch,
    docs: htmlContent,
    filePath: afcDoc.filePath || "",
    generatedBy: req.user?._id,
    metadata: {
      source: "afc-document",
      afcDocumentId: afcDoc._id,
      company:           company           ?? afcDoc.metadata?.company,
      industry:          industry          ?? afcDoc.metadata?.industry,
      documentType:      documentType      ?? afcDoc.metadata?.documentType,
      complianceOfficer: complianceOfficer ?? afcDoc.metadata?.complianceOfficer,
      model:             model             ?? afcDoc.metadata?.model,
      generatedAt:       afcDoc.metadata?.generatedAt,
    },
    isActive,
    status: "completed",
    versionNumber: 1,
    versions: [],
  });

  const versionDoc = await PolicyHubVersion.create({
    policyHub: policyHub._id,
    versionNumber: 1,
    docs: htmlContent,
    filePath: afcDoc.filePath || "",
    metadata: policyHub.metadata,
    isActive,
    editedBy: req.user?._id,
    editReason,
  });

  policyHub.versions.push(versionDoc._id);
  await policyHub.save();

  res.status(201).json({ success: true, data: policyHub });
});
