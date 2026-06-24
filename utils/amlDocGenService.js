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
const { importDocxToHtml } = require("./docxImportService");
const { extractHeaderFooter } = require("./docxSectionService");

// AML/CTF compliance document color scheme — matches the .docx template design:
//   Primary navy #1B3A5C for headings/table-headers, steel blue #2B5496 for h3,
//   alternating table rows #F3F6FA, light borders #D1D5DB.
// Stored inside `docs` so the HTML is self-contained for PDF/DOCX export.
const AML_DOC_STYLES = `<style>
.aml-doc{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#1F2937;line-height:1.65}
.aml-doc h1{font-size:16pt;font-weight:700;color:#1B3A5C;border-bottom:2px solid #1B3A5C;padding-bottom:6px;margin:24px 0 12px}
.aml-doc h2{font-size:13pt;font-weight:700;color:#1B3A5C;margin:18px 0 8px}
.aml-doc h3{font-size:11pt;font-weight:600;color:#2B5496;margin:14px 0 6px}
.aml-doc h4,.aml-doc h5,.aml-doc h6{font-weight:600;color:#2B5496;margin:12px 0 6px}
.aml-doc p{margin:0 0 8px}
.aml-doc strong,.aml-doc b{color:#1B3A5C;font-weight:700}
.aml-doc table{border-collapse:collapse;width:100%;margin:12px 0}
.aml-doc th{background:#1B3A5C;color:#fff;padding:8px 10px;font-weight:600;text-align:left;border:1px solid #1B3A5C}
.aml-doc td{padding:7px 10px;border:1px solid #D1D5DB;vertical-align:top}
.aml-doc tr:nth-child(even) td{background:#F3F6FA}
.aml-doc ul,.aml-doc ol{margin:0 0 8px;padding-left:24px}
.aml-doc li{margin-bottom:4px}
.aml-doc a{color:#2B5496;text-decoration:underline}
</style>`;

// ── Render payload ────────────────────────────────────────────────────────────

const DS_FIELDS = [
  "ds_high_value_unfinanced", "ds_high_currency", "ds_intl_transfers",
  "ds_anonymous_clients",     "ds_virtual_assets", "ds_complex_structures",
  "ds_unusual_services",
];

function formatAU(date) {
  return new Date(date).toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric" });
}

// Format a stored date value to AU long form. The questionnaire's date fields now
// store ISO (YYYY-MM-DD) from the date picker; legacy records may hold free text
// like "1 July 2026". Returns the raw value if it isn't a parseable date, or
// `fallback` when empty.
function formatAUDate(value, fallback = "") {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : formatAU(d);
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
    effectiveDate:              formatAUDate(rq.effectiveDate, todayStr),
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
 * Idempotent: upserts the PolicyHubTemplate per (client, sourceTemplateConfig) so
 * re-running (onboarding re-save, or an explicit regenerate) refreshes the existing
 * generated docs instead of piling up duplicates.
 *
 * @param {string|ObjectId} clientId
 * @param {string|ObjectId} [userId]   — createdBy reference (set on first insert only)
 * @returns {Promise<{ generated: number, total: number, reason: string|null }>}
 */
async function generateAMLDocsForClient(clientId, userId = null) {
  const client = await Client.findById(clientId);
  if (!client) return { generated: 0, total: 0, reason: "client_not_found" };

  const entityTypeName = client.riskQuestions?.entity_type;
  if (!entityTypeName) return { generated: 0, total: 0, reason: "no_entity_type" };

  // Exact name match first; fall back to matchKeywords for fuzzy values like "Financial"
  let entityType = await EntityType.findOne({ name: entityTypeName });
  if (!entityType) {
    entityType = await EntityType.findOne({ matchKeywords: entityTypeName.toLowerCase().trim() });
  }
  if (!entityType) {
    console.warn(`[amlDocGenService] No EntityType matched "${entityTypeName}" — skipping doc gen for client ${clientId}`);
    return { generated: 0, total: 0, reason: "no_entity_match" };
  }

  const templates = await TemplateConfig.find({
    isActive:      true,
    eligibleTypes: entityType._id,
  });
  if (!templates.length) return { generated: 0, total: 0, reason: "no_templates" };

  const riskRegister = await fetchLatestRiskRegister(client);
  const payload      = buildRenderPayload(client, riskRegister);
  const safeName     = client.name.replace(/[^a-zA-Z0-9]/g, "_");

  let generated = 0;
  for (const tmpl of templates) {
    try {
      const docBuffer = await generateDocument(payload, tmpl);

      // Convert the rendered .docx to HTML for the body, and pull header/footer
      // separately — same high-fidelity pipeline as a manual import, so
      // auto-generated templates open in the 3-region TinyMCE editor and export
      // with real Word header/footer parts (incl. firm name + page numbers).
      let htmlContent = "";
      let headerHtml = "";
      let footerHtml = "";
      try {
        const { html, engine } = await importDocxToHtml(docBuffer);
        // LibreOffice output already carries full styling; only the bare mammoth
        // fallback needs the AML colour-scheme wrapper to be self-contained.
        htmlContent = engine === "libreoffice"
          ? html
          : (html ? `${AML_DOC_STYLES}<div class="aml-doc">${html}</div>` : "");
        ({ headerHtml, footerHtml } = extractHeaderFooter(docBuffer));
      } catch (convErr) {
        console.warn(`[amlDocGenService] docx→HTML conversion failed for ${tmpl.templateKey}:`, convErr.message);
      }

      const fileName     = `${safeName}_${tmpl.templateKey}.docx`;
      const uploadResult = await fileVaultService.uploadFile(
        docBuffer,
        fileName,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );

      // Upsert by (client, sourceTemplateConfig): refresh the existing generated
      // doc in place, or create it the first time. createdBy is preserved on
      // re-generation (set only on insert).
      await PolicyHubTemplate.findOneAndUpdate(
        { client: clientId, sourceTemplateConfig: tmpl._id },
        {
          $set: {
            name:                  `${tmpl.label} — ${client.name}`,
            docs:                  htmlContent,
            headerHtml,
            footerHtml,
            generatedFileVaultId:  uploadResult?.file?.id  || uploadResult?.file?._id  || null,
            generatedFileUrl:      uploadResult?.file?.publicUrl || null,
            generatedSnapshotData: payload,
          },
          $setOnInsert: { createdBy: userId },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      generated++;
    } catch (err) {
      console.error(`[amlDocGenService] Failed to generate ${tmpl.templateKey} for client ${clientId}:`, err.message);
    }
  }

  return { generated, total: templates.length, reason: null };
}

module.exports = { generateAMLDocsForClient, buildRenderPayload, fetchLatestRiskRegister };
