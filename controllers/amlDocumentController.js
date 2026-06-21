"use strict";

const asyncHandler          = require("../middleware/async");
const ErrorResponse         = require("../utils/errorResponse");
const Client                = require("../models/Client");
const TemplateConfig        = require("../models/TemplateConfig");
const EntityType            = require("../models/EntityType");
const PolicyHubTemplate     = require("../models/PolicyHubTemplate");
const { generateDocument }  = require("../utils/docxTemplateService");
const fileVaultService      = require("../utils/fileVaultService");
const { resolveEntityType } = require("../utils/entityTypeResolver");
const { buildRenderPayload, fetchLatestRiskRegister } = require("../utils/amlDocGenService");

// ── Helpers ───────────────────────────────────────────────────────────────────

// Render payload comes from the canonical buildRenderPayload in amlDocGenService.
// Entity-type name (used only for the eligibility check) is resolved separately.
async function resolveEntityTypeName(client) {
  return client.riskQuestions?.entity_type || await resolveEntityType(client.clientType);
}

function resolveClientId(req, source = "query") {
  const params = source === "query" ? req.query : req.body;
  if (params.client) return params.client;
  return req.user?.client?._id ?? req.user?.client ?? null;
}

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/aml-document/templates
 * Query: ?entityTypeName=Lawyers%2FConveyancers
 * Returns all active templates, optionally filtered by entity type name.
 */
exports.listTemplates = asyncHandler(async (req, res) => {
  const { entityTypeName } = req.query;
  const filter = { isActive: true };

  if (entityTypeName) {
    const et = await EntityType.findOne({ name: { $regex: entityTypeName, $options: "i" } });
    if (et) filter.eligibleTypes = et._id;
  }

  const templates = await TemplateConfig.find(filter)
    .populate("eligibleTypes", "name category")
    .select("templateKey label eligibleTypes fileVaultUrl variableMap");

  res.status(200).json({ success: true, data: templates });
});

/**
 * POST /api/v1/aml-document/generate
 * Body: { client: "<clientId>", templateKey: "AML_PROGRAM_LAW" }
 * Generates the .docx, uploads to FileVault, saves a PolicyHubTemplate record,
 * and returns the file as a download.
 */
exports.generateDoc = asyncHandler(async (req, res, next) => {
  const { templateKey } = req.body;
  if (!templateKey) return next(new ErrorResponse("templateKey is required", 400));

  const clientId = resolveClientId(req, "body");
  if (!clientId) return next(new ErrorResponse("client is required", 400));

  const [client, templateConfig] = await Promise.all([
    Client.findById(clientId),
    TemplateConfig.findOne({ templateKey, isActive: true }).populate("eligibleTypes"),
  ]);

  if (!client)         return next(new ErrorResponse("Client not found", 404));
  if (!templateConfig) return next(new ErrorResponse(`Template "${templateKey}" not found or inactive`, 404));

  const riskRegister   = await fetchLatestRiskRegister(client);
  const payload        = buildRenderPayload(client, riskRegister);
  const entityTypeName = await resolveEntityTypeName(client);

  const eligible = templateConfig.eligibleTypes.some(et => et.name === entityTypeName);
  if (!eligible) {
    return next(new ErrorResponse(
      `Template "${templateKey}" is not available for entity type "${entityTypeName || "unknown"}"`,
      403
    ));
  }

  const docBuffer  = await generateDocument(payload, templateConfig);
  const safeName   = client.name.replace(/[^a-zA-Z0-9]/g, "_");
  const fileName   = `${safeName}_${templateKey}.docx`;

  const uploadResult = await fileVaultService.uploadFile(
    docBuffer,
    fileName,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );

  const generatedFileVaultId = uploadResult?.file?.id  || uploadResult?.file?._id  || null;
  const generatedFileUrl     = uploadResult?.file?.publicUrl || null;

  await PolicyHubTemplate.create({
    client:                clientId,
    sourceTemplateConfig:  templateConfig._id,
    name:                  `${templateConfig.label} — ${client.name}`,
    generatedFileVaultId,
    generatedFileUrl,
    generatedSnapshotData: payload,
    createdBy:             req.user?.id || null,
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(docBuffer);
});
