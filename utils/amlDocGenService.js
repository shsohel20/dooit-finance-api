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
const RiskRegister       = require("../models/RiskRegister");
const fileVaultService   = require("./fileVaultService");
const { generateDocument } = require("./docxTemplateService");

// ── Render payload ────────────────────────────────────────────────────────────

const DS_FIELDS = [
  "ds_high_value_unfinanced", "ds_high_currency", "ds_intl_transfers",
  "ds_anonymous_clients",     "ds_virtual_assets", "ds_complex_structures",
  "ds_unusual_services",
];

function formatAU(date) {
  return new Date(date).toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric" });
}

function escapeRegex(str = "") {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the most recent RiskRegister for a client.
 * RiskRegister is not linked to Client._id by a foreign key — it stores the
 * entity's name in `entityName` — so we match on name (case-insensitive, exact).
 * @param {Object} client - Client document
 * @returns {Promise<Object|null>}
 */
async function fetchLatestRiskRegister(client) {
  if (!client?.name) return null;
  return RiskRegister.findOne({
    entityName: { $regex: `^${escapeRegex(client.name)}$`, $options: "i" },
  })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Build the EWRA overall-risk-rating sentence from a RiskRegister.
 * Maps to the [INSERT — Low / Medium / High …] placeholder.
 * @returns {string|null} null when no register/label available (caller falls back)
 */
function formatRiskRating(register) {
  if (!register?.overallResidualLabel) return null;
  const total  = register.rowCount    || 0;
  const action = register.actionCount || 0;
  const detail = total
    ? ` (${total} risk${total === 1 ? "" : "s"} assessed${action ? `, ${action} requiring action` : ""})`
    : "";
  return `${register.overallResidualLabel} — based on the entity's most recent EWRA${detail}`;
}

/**
 * Build the flat render payload from a Client record.
 * Every field here corresponds to a placeholder present in the AML/CTF .docx
 * templates (see scripts/seedAMLTemplates.js variableMap). Keep the two aligned.
 * Canonical builder — also imported by amlDocumentController for on-demand generation.
 * @param {Object} client        - Client document
 * @param {Object} [riskRegister] - latest RiskRegister (from fetchLatestRiskRegister)
 *                                  used to derive overallRiskRating
 */
function buildRenderPayload(client, riskRegister = null) {
  const rq = client.riskQuestions || {};
  const hasDesignatedServices = DS_FIELDS.some(k => rq[k] && rq[k] !== "No");

  const now        = new Date();
  const todayStr   = formatAU(now);
  const reviewStr  = formatAU(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()));

  return {
    // Entity identity (placeholder name varies per template: FIRM/BANK/ENTITY/BUSINESS/AGENCY/OPERATOR NAME)
    firmName:                   client.name,
    abn:                        rq.abn                 || client.registrationNumber || "",
    acn:                        client.taxId           || "",

    // Officer
    complianceOfficerName:      rq.co_name             || client.legalRepresentative?.name || "",
    complianceOfficerNameTitle: rq.co_name_title       || (rq.co_name ? `${rq.co_name}, AML/CTF Compliance Officer` : ""),

    // Dates & enrolment
    austracEnrolmentRef:        rq.austracEnrolmentRef || "",
    effectiveDate:              rq.effectiveDate       || todayStr,
    reviewDate:                 rq.reviewDate          || reviewStr,

    // Entity-specific / choice fields
    thresholdAmount:            rq.thresholdAmount     || "$10,000",
    governanceBody:             rq.governanceBody      || "Board",
    overallRiskRating:          rq.overallRiskRating   || formatRiskRating(riskRegister) || "Medium — based on the entity's most recent EWRA",
    reportingGroupDetails:      rq.reportingGroupDetails || "Not applicable — the entity is not part of a Reporting Group",
    designatedGroupStatus:      rq.designatedGroupStatus || "does not currently form part of",

    hasDesignatedServices,
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

  // Exact name match first; fall back to matchKeywords for fuzzy values like "Financial"
  let entityType = await EntityType.findOne({ name: entityTypeName });
  if (!entityType) {
    entityType = await EntityType.findOne({ matchKeywords: entityTypeName.toLowerCase().trim() });
  }
  if (!entityType) {
    console.warn(`[amlDocGenService] No EntityType matched "${entityTypeName}" — skipping doc gen for client ${clientId}`);
    return;
  }

  const templates = await TemplateConfig.find({
    isActive:      true,
    eligibleTypes: entityType._id,
  });
  if (!templates.length) return;

  const riskRegister = await fetchLatestRiskRegister(client);
  const payload      = buildRenderPayload(client, riskRegister);
  const safeName     = client.name.replace(/[^a-zA-Z0-9]/g, "_");

  for (const tmpl of templates) {
    try {
      const docBuffer    = await generateDocument(payload, tmpl);
      const fileName     = `${safeName}_${tmpl.templateKey}.docx`;
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
      console.error(`[amlDocGenService] Failed to generate ${tmpl.templateKey} for client ${clientId}:`, err.message);
    }
  }
}

module.exports = { generateAMLDocsForClient, buildRenderPayload, fetchLatestRiskRegister };
