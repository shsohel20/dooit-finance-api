"use strict";

/**
 * amlDocGenService.js
 * Shared utility for generating AML/CTF compliance documents.
 * Used by:
 *   - clientController  → background auto-generation after riskQuestions saved
 *   - amlDocumentController → on-demand single-template generation
 */

const Client             = require("../models/Client");
const EntityType         = require("../models/EntityType");
const TemplateConfig     = require("../models/TemplateConfig");
const PolicyHubTemplate  = require("../models/PolicyHubTemplate");
const fileVaultService   = require("./fileVaultService");
const { generateDocument } = require("./docxTemplateService");

// ── Render payload ────────────────────────────────────────────────────────────

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
    abn:                        rq.abn                 || client.registrationNumber || "",
    acn:                        client.taxId           || "",
    state:                      client.address?.state  || "",
    complianceOfficerName:      rq.co_name             || client.legalRepresentative?.name || "",
    complianceOfficerNameTitle: rq.co_name             || "",
    austracEnrolmentRef:        rq.austracEnrolmentRef || "",
    effectiveDate:              rq.effectiveDate       || "",
    documentDate:               rq.documentDate        || "",
    hasDesignatedServices,
    designatedServicesText:     rq.designatedServicesText || "",
    agencyLicenseNumber:        rq.abn                 || client.registrationNumber || "",
  };
}


// ── Public: generate all eligible docs for a client ──────────────────────────

/**
 * Generate all active TemplateConfig docs that match the client's entity type.
 * Uploads each generated .docx to FileVault and saves a PolicyHubTemplate record.
 *
 * @param {string|ObjectId} clientId
 * @param {string|ObjectId} [userId]   — createdBy reference
 * @returns {Promise<void>}
 */
async function generateAMLDocsForClient(clientId, userId = null) {
  const client = await Client.findById(clientId);
  if (!client) return;

  const entityTypeName = client.riskQuestions?.entity_type;
  if (!entityTypeName) return;

  const entityType = await EntityType.findOne({ name: entityTypeName });
  if (!entityType) return;

  const templates = await TemplateConfig.find({
    isActive:      true,
    eligibleTypes: entityType._id,
  });
  if (!templates.length) return;

  const payload  = buildRenderPayload(client);
  const safeName = client.name.replace(/[^a-zA-Z0-9]/g, "_");

  for (const tmpl of templates) {
    try {
      const docBuffer  = await generateDocument(payload, tmpl);
      const fileName   = `${safeName}_${tmpl.templateKey}.docx`;
      const uploadResult = await fileVaultService.uploadFile(
        docBuffer,
        fileName,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );

      await PolicyHubTemplate.create({
        client:                clientId,
        sourceTemplateConfig:  tmpl._id,
        name:                  `${tmpl.label} — ${client.name}`,
        generatedFileVaultId:  uploadResult?.file?.id  || uploadResult?.file?._id  || null,
        generatedFileUrl:      uploadResult?.file?.publicUrl || null,
        generatedSnapshotData: payload,
        createdBy:             userId,
      });
    } catch (err) {
      // Log but don't throw — one failed template should not block the others
      console.error(`[amlDocGenService] Failed to generate ${tmpl.templateKey} for client ${clientId}:`, err.message);
    }
  }
}

module.exports = { generateAMLDocsForClient, buildRenderPayload };
