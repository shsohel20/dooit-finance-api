"use strict";

/**
 * checkDocxEngine.js
 * ──────────────────
 * Verifies the DOCX import pipeline on the current host:
 *   1. Which conversion engine is active — LibreOffice (high fidelity) or the
 *      mammoth fallback (structure only).
 *   2. (Optional) Runs a real conversion of a .docx and prints a fidelity summary.
 *
 * Usage:
 *   node api/scripts/checkDocxEngine.js
 *   node api/scripts/checkDocxEngine.js path/to/file.docx
 *
 * No DB, no network. Exit 0 = LibreOffice active; 0 with warning = fallback only.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../config/config.env") });

const fs   = require("fs");
const path = require("path");
const {
  resolveSoffice,
  importDocxToHtml,
} = require("../utils/docxImportService");

function count(html, re) {
  return (html.match(re) || []).length;
}

async function main() {
  console.log("── DOCX import engine check ───────────────────────────────");

  const bin = await resolveSoffice();
  if (bin) {
    console.log(`✅ LibreOffice detected: ${bin}`);
    console.log("   Tier 1 active — fonts, sizes, alignment, colours preserved.");
  } else {
    console.log("⚠️  LibreOffice NOT found — running on the mammoth fallback.");
    console.log("   Structure (headings, tables, lists, images) is preserved,");
    console.log("   but fonts / alignment / colours are NOT guaranteed.");
    console.log("   Install: winget install TheDocumentFoundation.LibreOffice");
    console.log("   Or set LIBREOFFICE_PATH in api/config/config.env");
    console.log(`   Probed: LIBREOFFICE_PATH=${process.env.LIBREOFFICE_PATH || "(unset)"}, soffice, libreoffice, Program Files`);
  }

  // Optional fidelity run against a sample file
  const arg = process.argv[2];
  const sample =
    arg ||
    (() => {
      const dir = path.join(__dirname, "../../docs/amldocs");
      if (!fs.existsSync(dir)) return null;
      const f = fs.readdirSync(dir).find((x) => x.endsWith(".docx"));
      return f ? path.join(dir, f) : null;
    })();

  if (!sample) {
    console.log("\nNo .docx to test (pass a path to run a conversion). Done.");
    return;
  }
  if (!fs.existsSync(sample)) {
    console.error(`\n❌ File not found: ${sample}`);
    process.exit(1);
  }

  console.log(`\n── Converting: ${path.basename(sample)} ───────────────────`);
  const buffer = fs.readFileSync(sample);
  const { html, engine, fallbackReason } = await importDocxToHtml(buffer);

  console.log(`Engine used      : ${engine}${fallbackReason ? `  (fallback: ${fallbackReason})` : ""}`);
  console.log(`Output HTML size : ${(html.length / 1024).toFixed(1)} KB`);
  console.log("Fidelity summary :");
  console.log(`  headings h1-h6 : ${count(html, /<h[1-6][ >]/g)}`);
  console.log(`  paragraphs     : ${count(html, /<p[ >]/g)}`);
  console.log(`  bold / italic  : ${count(html, /<(strong|b)[ >]/g)} / ${count(html, /<(em|i)[ >]/g)}`);
  console.log(`  underline <u>  : ${count(html, /<u[ >]/g)}`);
  console.log(`  tables / cells : ${count(html, /<table[ >]/g)} / ${count(html, /<t[dh][ >]/g)}`);
  console.log(`  merged cells   : ${count(html, /colspan=|rowspan=/g)}`);
  console.log(`  lists ul/ol    : ${count(html, /<(ul|ol)[ >]/g)}`);
  console.log(`  links / images : ${count(html, /<a [^>]*href/g)} / ${count(html, /<img[ >]/g)}`);
  console.log(`  inline style=  : ${count(html, /style=/g)}`);
  // LibreOffice expresses fonts via <font face/color/size> tags AND inline styles;
  // count both so the summary reflects actual fidelity regardless of engine.
  console.log(`  font family    : ${count(html, /face=/gi) + count(html, /font-family/gi)}  (<font face> + css font-family)`);
  console.log(`  font size      : ${count(html, /<font[^>]*size=/gi) + count(html, /font-size/gi)}`);
  console.log(`  font colour    : ${count(html, /<font[^>]*color=/gi) + count(html, /color\s*:/gi)}`);
  console.log(`  alignment      : ${count(html, /text-align/gi) + count(html, /align=/gi)}`);
  console.log(`  <script> (must be 0): ${count(html, /<script/gi)}`);

  if (engine === "mammoth") {
    console.log("\n⚠️  Fallback engine: install LibreOffice for full styling fidelity.");
  } else {
    console.log("\n✅ LibreOffice conversion succeeded — high-fidelity import confirmed.");
  }
}

main().catch((e) => {
  console.error("❌ Check failed:", e.message);
  process.exit(1);
});
