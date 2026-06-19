"use strict";

const asyncHandler          = require("../middleware/async");
const ErrorResponse         = require("../utils/errorResponse");
const Client                = require("../models/Client");
const TemplateConfig        = require("../models/TemplateConfig");
const EntityType            = require("../models/EntityType");
const PolicyHubTemplate     = require("../models/PolicyHubTemplate");
const { generateDocument }  = require("../utils/docxTemplateService");
const fileVaultService      = require("../utils/fileVaultService");
const { resolveEntityType } = require("./riskRegisterController");

// ── Helpers ───────────────────────────────────────────────────────────────────

const DS_FIELDS = [
  "ds_high_value_unfinanced", "ds_high_currency", "ds_intl_transfers",
  "ds_anonymous_clients",     "ds_virtual_assets", "ds_complex_structures",
  "ds_unusual_services",
];

function buildRenderPayload(client) {
  const rq = client.riskQuestions || {};
  const hasDesignatedServices = DS_FIELDS.some(k => rq[k] && rq[k] !== "No");

  return {
    firmName:                   client.name,
    abn:                        rq.abn                    || client.registrationNumber || "",
    acn:                        client.taxId              || "",
    state:                      client.address?.state     || "",
    complianceOfficerName:      rq.co_name                || client.legalRepresentative?.name || "",
    complianceOfficerNameTitle: rq.co_name                || "",
    austracEnrolmentRef:        rq.austracEnrolmentRef    || "",
    effectiveDate:              rq.effectiveDate          || "",
    documentDate:               rq.documentDate           || "",
    hasDesignatedServices,
    designatedServicesText:     rq.designatedServicesText || "",
    agencyLicenseNumber:        rq.abn                    || client.registrationNumber || "",
    _entityTypeName:            rq.entity_type            || resolveEntityType(client.clientType),
  };
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

  const payload        = buildRenderPayload(client);
  const entityTypeName = payload._entityTypeName;

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

  const { _entityTypeName, ...snapshotData } = payload;

  await PolicyHubTemplate.create({
    client:                clientId,
    sourceTemplateConfig:  templateConfig._id,
    name:                  `${templateConfig.label} — ${client.name}`,
    generatedFileVaultId,
    generatedFileUrl,
    generatedSnapshotData: snapshotData,
    createdBy:             req.user?.id || null,
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(docBuffer);
});
