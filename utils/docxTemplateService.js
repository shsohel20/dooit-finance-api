"use strict";

/**
 * docxTemplateService.js
 * Generic .docx template renderer — data-driven, no per-template if/else.
 * All placeholder→field mappings live in TemplateConfig.variableMap.
 */

const PizZip        = require("pizzip");
const Docxtemplater = require("docxtemplater");
const axios         = require("axios");

function applyTransform(value, transform) {
  if (value === undefined || value === null) return "";
  const str = String(value);
  switch (transform) {
    case "BOOL_YES_NO": return value ? "YES" : "NO";
    case "UPPER":       return str.toUpperCase();
    case "DATE_AU":     return str;
    default:            return str;
  }
}

function resolveField(obj, field) {
  return field.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function buildRenderData(payloadObj, variableMap) {
  return variableMap.reduce((acc, mapping) => {
    const raw = resolveField(payloadObj, mapping.field);
    const key = mapping.placeholder.replace(/^\[|\]$/g, "");
    acc[key]  = applyTransform(raw, mapping.transform);
    return acc;
  }, {});
}

/**
 * Fetch template buffer from fileVaultUrl, fill placeholders, return buffer.
 * @param {Object} payloadObj     - flat render data (from buildRenderPayload)
 * @param {Object} templateConfig - TemplateConfig doc (must have fileVaultUrl + variableMap)
 * @returns {Promise<Buffer>}
 */
async function generateDocument(payloadObj, templateConfig) {
  const response = await axios.get(templateConfig.fileVaultUrl, { responseType: "arraybuffer" });
  const buffer   = Buffer.from(response.data);

  const renderData = buildRenderData(payloadObj, templateConfig.variableMap);

  // Diagnose blank-doc issues: log mapping count and flag empty values
  const emptyKeys = Object.entries(renderData).filter(([, v]) => v === "").map(([k]) => k);
  console.log(`[docxTemplate] ${templateConfig.templateKey} — variableMap: ${templateConfig.variableMap.length} entries | renderData keys: ${Object.keys(renderData).length}`);
  if (emptyKeys.length) console.warn(`[docxTemplate] Empty values for: ${emptyKeys.join(", ")}`);
  if (!templateConfig.variableMap.length) console.warn(`[docxTemplate] variableMap is EMPTY — no placeholders will be filled`);

  const zip = new PizZip(buffer);
  const doc = new Docxtemplater(zip, {
    delimiters:    { start: "[", end: "]" },
    paragraphLoop: true,
    linebreaks:    true,
    nullGetter:    () => "",
  });

  doc.render(renderData);
  return doc.getZip().generate({ type: "nodebuffer" });
}

module.exports = { generateDocument, buildRenderData, applyTransform };
