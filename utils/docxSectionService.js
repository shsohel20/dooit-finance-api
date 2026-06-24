"use strict";

/**
 * docxSectionService.js
 * Header/footer round-trip for the DOCX <-> TinyMCE pipeline.
 *
 * HTML has no page-header/footer concept, so LibreOffice/mammoth drop Word
 * headers & footers on import. This module bridges that gap:
 *
 *   extractHeaderFooter(buffer)  -> { headerHtml, footerHtml }
 *       Reads the DEFAULT header/footer parts from the .docx (via sectPr
 *       references) and converts the OOXML to editable HTML for TinyMCE.
 *
 *   injectHeaderFooter(bodyDocxBuffer, { headerHtml, footerHtml }) -> Buffer
 *       Adds Word header/footer parts (generated from the edited HTML) back into
 *       a body .docx produced by LibreOffice, preserving body fidelity while
 *       restoring the header/footer.
 *
 * Page-number fields (PAGE / NUMPAGES) survive both ways: extracted as editable
 * tokens (<span data-field="PAGE">[Page]</span>) and re-emitted as real Word
 * fields on export.
 */

const PizZip     = require("pizzip");
const HTMLtoDOCX = require("html-to-docx");

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// ── OOXML (header/footer part) -> HTML ──────────────────────────────────────

function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function decodeXmlText(s = "") {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function fieldToken(type) {
  return `<span class="docx-field" data-field="${type}">${type === "PAGE" ? "[Page]" : "[Pages]"}</span>`;
}

// Plain text/structure of a run (handles <w:t>, tabs, breaks)
function runText(rXml) {
  let text = "";
  const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
  let m;
  while ((m = tokenRe.exec(rXml)) !== null) {
    if (m[1] !== undefined) text += esc(decodeXmlText(m[1]));
    else if (m[0].startsWith("<w:tab")) text += " ";
    else text += "<br/>";
  }
  return text;
}

// Render a <w:r> run -> HTML (bold / italic / underline + text)
function runToHtml(rXml) {
  const rPr = (rXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/) || [""])[0];
  const boldTag   = rPr.match(/<w:b\b[^>]*>/)?.[0] || "";
  const bold      = /<w:b\b/.test(rPr) && !/w:val="(?:false|0|off|none)"/.test(boldTag);
  const italic    = /<w:i\b(?![a-zA-Z])/.test(rPr);
  const underline = /<w:u\b/.test(rPr) && !/<w:u\b[^>]*w:val="none"/.test(rPr);

  const text = runText(rXml);
  if (!text) return "";
  let html = text;
  if (bold)      html = `<strong>${html}</strong>`;
  if (italic)    html = `<em>${html}</em>`;
  if (underline) html = `<u>${html}</u>`;
  return html;
}

// Render a <w:p> paragraph -> HTML. Field-state aware so PAGE/NUMPAGES collapse
// to one clean token and the cached field result (e.g. "1", "63") is skipped.
function paragraphToHtml(pXml) {
  const align = (pXml.match(/<w:jc\b[^>]*w:val="([^"]+)"/) || [])[1];
  let inner = "";
  let inField = false, inResult = false, fieldType = null;

  const tokRe = /<w:fldSimple\b[^>]*>[\s\S]*?<\/w:fldSimple>|<w:r\b[\s\S]*?<\/w:r>/g;
  let m;
  while ((m = tokRe.exec(pXml)) !== null) {
    const x = m[0];

    if (x.startsWith("<w:fldSimple")) {
      const instr = (x.match(/w:instr="([^"]*)"/) || [])[1] || "";
      if (/NUMPAGES/.test(instr))  inner += fieldToken("NUMPAGES");
      else if (/PAGE/.test(instr)) inner += fieldToken("PAGE");
      else                         inner += runText(x);
      continue;
    }

    if (/<w:fldChar[^>]*w:fldCharType="begin"/.test(x)) { inField = true; inResult = false; fieldType = null; continue; }
    if (inField && /<w:instrText/.test(x)) {
      const t = (x.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/) || [])[1] || "";
      if (/NUMPAGES/.test(t)) fieldType = "NUMPAGES";
      else if (/PAGE/.test(t)) fieldType = "PAGE";
      continue;
    }
    if (/<w:fldChar[^>]*w:fldCharType="separate"/.test(x)) { inResult = true; continue; }
    if (/<w:fldChar[^>]*w:fldCharType="end"/.test(x)) {
      if (fieldType) inner += fieldToken(fieldType);
      inField = false; inResult = false; fieldType = null; continue;
    }
    if (inResult) continue; // skip cached field result text

    inner += runToHtml(x);
  }

  if (!inner.trim()) inner = "&nbsp;";
  const style = align ? ` style="text-align:${align === "both" ? "justify" : esc(align)}"` : "";
  return `<p${style}>${inner}</p>`;
}

function paragraphsToHtml(chunk = "") {
  let out = "";
  const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = pRe.exec(chunk)) !== null) out += paragraphToHtml(m[0]);
  return out;
}

function tableToHtml(tblXml) {
  let rows = "";
  const trRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  let tr;
  while ((tr = trRe.exec(tblXml)) !== null) {
    let cells = "";
    const tcRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
    let tc;
    while ((tc = tcRe.exec(tr[0])) !== null) {
      cells += `<td style="border:none;padding:0 6px">${paragraphsToHtml(tc[0]) || "&nbsp;"}</td>`;
    }
    rows += `<tr>${cells}</tr>`;
  }
  return `<table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>`;
}

// Convert a header/footer part (<w:hdr>/<w:ftr>) to HTML (tables + paragraphs in order)
function ooxmlPartToHtml(xml = "") {
  const wrap = xml.match(/<w:(?:hdr|ftr)\b[^>]*>([\s\S]*?)<\/w:(?:hdr|ftr)>/);
  const inner = wrap ? wrap[1] : xml;
  let out = "";
  let lastIndex = 0;
  const tblRe = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
  let m;
  while ((m = tblRe.exec(inner)) !== null) {
    out += paragraphsToHtml(inner.slice(lastIndex, m.index));
    out += tableToHtml(m[0]);
    lastIndex = tblRe.lastIndex;
  }
  out += paragraphsToHtml(inner.slice(lastIndex));
  return out.trim();
}

// ── Extract default header & footer from a .docx buffer ─────────────────────

function resolveDefaultPart(documentXml, relsXml, refTag) {
  const refRe = new RegExp(`<w:${refTag}\\b[^>]*w:type="([^"]+)"[^>]*r:id="([^"]+)"[^>]*/?>`, "g");
  let chosen = null, first = null, m;
  while ((m = refRe.exec(documentXml)) !== null) {
    if (!first) first = m[2];
    if (m[1] === "default") { chosen = m[2]; break; }
  }
  const relId = chosen || first;
  if (!relId) return null;
  const target = (relsXml.match(new RegExp(`<Relationship\\b[^>]*Id="${relId}"[^>]*Target="([^"]+)"`)) || [])[1];
  return target ? target.replace(/^\/?word\//, "").replace(/^\//, "") : null;
}

function extractHeaderFooter(buffer) {
  try {
    const zip = new PizZip(buffer);
    const documentXml = zip.file("word/document.xml")?.asText() || "";
    const relsXml     = zip.file("word/_rels/document.xml.rels")?.asText() || "";
    const result = { headerHtml: "", footerHtml: "" };

    const headerTarget = resolveDefaultPart(documentXml, relsXml, "headerReference");
    const footerTarget = resolveDefaultPart(documentXml, relsXml, "footerReference");
    if (headerTarget && zip.file(`word/${headerTarget}`)) {
      result.headerHtml = ooxmlPartToHtml(zip.file(`word/${headerTarget}`).asText());
    }
    if (footerTarget && zip.file(`word/${footerTarget}`)) {
      result.footerHtml = ooxmlPartToHtml(zip.file(`word/${footerTarget}`).asText());
    }
    return result;
  } catch (e) {
    console.warn("[docxSectionService] header/footer extraction failed:", e.message);
    return { headerHtml: "", footerHtml: "" };
  }
}

// ── Inject header/footer into a (LibreOffice) body .docx ────────────────────

const CT_HDR  = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const CT_FTR  = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
const REL_HDR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header";
const REL_FTR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";

const PAGE_SENTINEL = "PAGE";
const PAGES_SENTINEL = "NUMPAGES";

// Editor field tokens -> sentinels (so html-to-docx carries them as plain text)
function tokensToSentinels(html = "") {
  return html
    .replace(/<span\b[^>]*data-field="PAGE"[^>]*>[\s\S]*?<\/span>/gi, PAGE_SENTINEL)
    .replace(/<span\b[^>]*data-field="NUMPAGES"[^>]*>[\s\S]*?<\/span>/gi, PAGES_SENTINEL);
}

// Sentinels in generated part XML -> real Word fields (namespace-safe: declares
// xmlns:w on fldSimple so w:instr is correct even in a default-namespace part)
function sentinelsToFields(xml = "") {
  const field = (instr) =>
    `</t></r><fldSimple xmlns:w="${W_NS}" w:instr=" ${instr} \\* MERGEFORMAT "><r><t>1</t></r></fldSimple><r><t xml:space="preserve">`;
  return xml
    .split(PAGE_SENTINEL).join(field("PAGE"))
    .split(PAGES_SENTINEL).join(field("NUMPAGES"));
}

function nextRelId(relsXml) {
  let max = 0;
  const re = /Id="rId(\d+)"/g;
  let m;
  while ((m = re.exec(relsXml)) !== null) max = Math.max(max, Number(m[1]));
  return max;
}

// Build header/footer OOXML parts from HTML by reusing html-to-docx
async function generateParts({ headerHtml, footerHtml }) {
  const buf = await HTMLtoDOCX(
    "<p></p>",
    headerHtml ? tokensToSentinels(headerHtml) : undefined,
    { header: !!headerHtml, footer: !!footerHtml, pageNumber: false },
    footerHtml ? tokensToSentinels(footerHtml) : undefined,
  );
  const zip = new PizZip(buf);
  const hdr = headerHtml ? zip.file("word/header1.xml")?.asText() : null;
  const ftr = footerHtml ? zip.file("word/footer1.xml")?.asText() : null;
  return {
    headerXml: hdr ? sentinelsToFields(hdr) : null,
    footerXml: ftr ? sentinelsToFields(ftr) : null,
  };
}

// Insert refs into the LAST <w:sectPr ...> (header/footer refs precede other children)
function insertSectRefs(documentXml, refs) {
  const re = /<w:sectPr\b[^>]*>/g;
  let last = null, m;
  while ((m = re.exec(documentXml)) !== null) last = m;
  if (!last) return documentXml;
  const idx = last.index + last[0].length;
  return documentXml.slice(0, idx) + refs + documentXml.slice(idx);
}

// LibreOffice exports header/footer distances as 0; reserve a little space
function ensureHeaderFooterMargins(documentXml) {
  return documentXml.replace(/<w:pgMar\b([^>]*)\/>/g, (full, attrs) => {
    let a = attrs;
    a = /w:header="0"/.test(a) ? a.replace(/w:header="0"/, 'w:header="567"') : (/w:header=/.test(a) ? a : a + ' w:header="567"');
    a = /w:footer="0"/.test(a) ? a.replace(/w:footer="0"/, 'w:footer="567"') : (/w:footer=/.test(a) ? a : a + ' w:footer="567"');
    return `<w:pgMar${a}/>`;
  });
}

async function injectHeaderFooter(bodyDocxBuffer, { headerHtml = "", footerHtml = "" } = {}) {
  if (!headerHtml && !footerHtml) return bodyDocxBuffer;

  const { headerXml, footerXml } = await generateParts({ headerHtml, footerHtml });
  if (!headerXml && !footerXml) return bodyDocxBuffer;

  const zip = new PizZip(bodyDocxBuffer);
  let documentXml = zip.file("word/document.xml").asText();
  let relsXml     = zip.file("word/_rels/document.xml.rels").asText();
  let ctXml       = zip.file("[Content_Types].xml").asText();

  let rid = nextRelId(relsXml);
  const newRels = [], newOverrides = [];
  let refs = "";

  if (headerXml) {
    rid += 1; const id = `rId${rid}`;
    zip.file("word/header1.xml", headerXml);
    newRels.push(`<Relationship Id="${id}" Type="${REL_HDR}" Target="header1.xml"/>`);
    newOverrides.push(`<Override PartName="/word/header1.xml" ContentType="${CT_HDR}"/>`);
    refs += `<w:headerReference w:type="default" r:id="${id}"/>`;
  }
  if (footerXml) {
    rid += 1; const id = `rId${rid}`;
    zip.file("word/footer1.xml", footerXml);
    newRels.push(`<Relationship Id="${id}" Type="${REL_FTR}" Target="footer1.xml"/>`);
    newOverrides.push(`<Override PartName="/word/footer1.xml" ContentType="${CT_FTR}"/>`);
    refs += `<w:footerReference w:type="default" r:id="${id}"/>`;
  }

  relsXml = relsXml.replace("</Relationships>", `${newRels.join("")}</Relationships>`);
  ctXml   = ctXml.replace("</Types>", `${newOverrides.join("")}</Types>`);
  documentXml = ensureHeaderFooterMargins(insertSectRefs(documentXml, refs));

  zip.file("word/document.xml", documentXml);
  zip.file("word/_rels/document.xml.rels", relsXml);
  zip.file("[Content_Types].xml", ctXml);

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { extractHeaderFooter, injectHeaderFooter, ooxmlPartToHtml };
