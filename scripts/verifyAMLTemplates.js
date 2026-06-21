"use strict";

/**
 * verifyAMLTemplates.js
 *
 * Static validator — NO database, NO network. Renders each local AML/CTF .docx
 * against the seed's variableMap + the canonical buildRenderPayload and reports:
 *   • UNFILLED  — a placeholder in the .docx with no matching variableMap entry
 *   • UNUSED    — a variableMap entry whose placeholder is absent from the .docx
 *   • EMPTY     — a mapped placeholder whose payload value resolved to ""
 *
 * Run after editing any .docx template or the variableMap:
 *   node api/scripts/verifyAMLTemplates.js
 *
 * Exit code 1 if any UNFILLED placeholders are found (CI-friendly).
 */

const fs            = require("fs");
const path          = require("path");
const PizZip        = require("pizzip");
const Docxtemplater = require("docxtemplater");

const { TEMPLATES, DOCS_DIR } = require("./seedAMLTemplates");
const { buildRenderPayload }  = require("../utils/amlDocGenService");
const { buildRenderData }     = require("../utils/docxTemplateService");

// Fake client exercising every payload field
const SAMPLE_CLIENT = {
  name: "Acme Sample Pty Ltd",
  registrationNumber: "12 345 678 901",
  taxId: "123 456 789",
  address: { state: "NSW" },
  legalRepresentative: { name: "Jane Smith" },
  riskQuestions: {
    co_name: "Jane Smith",
    austracEnrolmentRef: "ENR-2026-0001 (enrolled 1 July 2026)",
    ds_virtual_assets: "Yes",
  },
};

function docTags(buffer) {
  const tags = new Set();
  const doc = new Docxtemplater(new PizZip(buffer), {
    delimiters: { start: "[", end: "]" },
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: (part) => { if (part && part.value) tags.add(part.value); return ""; },
  });
  doc.render({});
  return tags;
}

function main() {
  const payload = buildRenderPayload(SAMPLE_CLIENT);
  let totalUnfilled = 0;

  for (const tmpl of TEMPLATES) {
    const filePath = path.join(DOCS_DIR, tmpl.docFile);
    if (!fs.existsSync(filePath)) {
      console.log(`\n❌ ${tmpl.templateKey} — file missing: ${tmpl.docFile}`);
      continue;
    }

    const buffer    = fs.readFileSync(filePath);
    const tagsInDoc = docTags(buffer);                                  // exact placeholders the doc contains
    const mapped    = new Set(tmpl.variableMap.map(m => m.placeholder.replace(/^\[|\]$/g, "")));
    const renderEnv = buildRenderData(payload, tmpl.variableMap);       // placeholder-name → value

    const unfilled = [...tagsInDoc].filter(t => !mapped.has(t));
    const unused   = [...mapped].filter(t => !tagsInDoc.has(t));
    const empty    = [...tagsInDoc].filter(t => mapped.has(t) && renderEnv[t] === "");

    totalUnfilled += unfilled.length;

    const status = unfilled.length ? "❌" : "✅";
    console.log(`\n${status} ${tmpl.templateKey} (${tmpl.docFile}) — ${tagsInDoc.size} tags`);
    if (unfilled.length) console.log(`   UNFILLED (no mapping): ${unfilled.map(t => `[${t}]`).join(" | ")}`);
    if (empty.length)    console.log(`   EMPTY value (mapped, blank): ${empty.map(t => `[${t}]`).join(" | ")}`);
    if (unused.length)   console.log(`   UNUSED mapping (not in doc): ${unused.map(t => `[${t}]`).join(" | ")}`);
  }

  console.log(`\n${"─".repeat(60)}`);
  if (totalUnfilled === 0) {
    console.log("✅ All placeholders in every template have a variableMap entry.");
    process.exit(0);
  } else {
    console.log(`❌ ${totalUnfilled} unmapped placeholder(s) found — add them to seedAMLTemplates.js`);
    process.exit(1);
  }
}

main();
