"use strict";

/**
 * utils/docxToHtml.js
 *
 * Converts a .docx buffer to pixel-faithful HTML with inline styles.
 * Handles: headings, paragraphs, bold/italic/underline, font size/color/family,
 * text alignment, indentation, paragraph spacing, tables (borders, bg, colspan),
 * numbered & bulleted lists (nested), images (base64-embedded), hyperlinks.
 */

const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");

// ─── Namespace URIs ────────────────────────────────────────────────────────────

const W   = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R   = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A   = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP  = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";

const xmlParser = new DOMParser({ onError: () => {} });
const parseXml = (str) => xmlParser.parseFromString(str || "<empty/>", "text/xml");

// ─── DOM helpers ───────────────────────────────────────────────────────────────

function wA(el, name) {
  if (!el) return null;
  return el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`) ?? null;
}

function rA(el, name) {
  if (!el) return null;
  return el.getAttributeNS(R, name) ?? el.getAttribute(`r:${name}`) ?? null;
}

function kids(el) {
  const out = [];
  if (!el) return out;
  for (let i = 0; i < el.childNodes.length; i++) {
    if (el.childNodes[i].nodeType === 1) out.push(el.childNodes[i]);
  }
  return out;
}

function wKid(el, local) {
  if (!el) return null;
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === 1 && c.localName === local && (c.namespaceURI === W || c.prefix === "w")) {
      return c;
    }
  }
  return null;
}

function wKids(el, local) {
  const out = [];
  if (!el) return out;
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === 1 && c.localName === local && (c.namespaceURI === W || c.prefix === "w")) {
      out.push(c);
    }
  }
  return out;
}

function byTag(el, ns, local) {
  const a = el.getElementsByTagNameNS(ns, local);
  if (a && a.length > 0) return a[0];
  const b = el.getElementsByTagName(`${ns === W ? "w" : ns === R ? "r" : ns === A ? "a" : "wp"}:${local}`);
  return b && b.length > 0 ? b[0] : null;
}

function byTagAll(el, ns, local) {
  const a = el.getElementsByTagNameNS(ns, local);
  if (a && a.length > 0) return Array.from(a);
  const prefix = ns === W ? "w" : ns === R ? "r" : ns === A ? "a" : "wp";
  const b = el.getElementsByTagName(`${prefix}:${local}`);
  return b ? Array.from(b) : [];
}

// Check w: boolean flag (presence = true, w:val="false"/"0" = false)
function wFlag(el, name) {
  const c = wKid(el, name);
  if (!c) return false;
  const v = wA(c, "val");
  return v === null || v === "1" || v === "true" || v.toLowerCase() === "true";
}

// ─── Unit conversions ──────────────────────────────────────────────────────────

const halfPtToPt  = (v) => (Number(v) / 2);
const twipsToPx   = (v) => Math.round(Number(v) * 96 / 1440);
const emuToPx     = (v) => Math.round(Number(v) / 914400 * 96);

// ─── Color helpers ────────────────────────────────────────────────────────────

const HIGHLIGHT = {
  yellow:"#FFFF00", green:"#00FF00", cyan:"#00FFFF", magenta:"#FF00FF",
  blue:"#0000FF", red:"#FF0000", darkBlue:"#000080", darkCyan:"#008080",
  darkGreen:"#008000", darkMagenta:"#800080", darkRed:"#800000",
  darkYellow:"#808000", darkGray:"#808080", lightGray:"#C0C0C0", black:"#000000",
};

const IMAGE_MIME = {
  png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg",
  gif:"image/gif", svg:"image/svg+xml", webp:"image/webp", bmp:"image/bmp",
};

function safeHref(href) {
  if (!href) return "#";
  const lower = href.toLowerCase().trim();
  if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) return "#";
  return href;
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Run property parser ───────────────────────────────────────────────────────

function parseRunPr(rPr) {
  const pr = {};
  if (!rPr) return pr;

  if (wFlag(rPr, "b"))        pr.bold = true;
  if (wFlag(rPr, "i"))        pr.italic = true;
  if (wFlag(rPr, "strike"))   pr.strike = true;
  if (wFlag(rPr, "dstrike"))  pr.strike = true;

  const u = wKid(rPr, "u");
  if (u) {
    const uv = wA(u, "val");
    if (uv && uv !== "none") pr.underline = true;
  }

  const color = wKid(rPr, "color");
  if (color) { const v = wA(color, "val"); if (v && v !== "auto") pr.color = v; }

  const sz = wKid(rPr, "sz");
  if (sz) { const v = wA(sz, "val"); if (v) pr.fontSize = Number(v); }

  const fonts = wKid(rPr, "rFonts");
  if (fonts) {
    pr.fontFamily = wA(fonts, "ascii") || wA(fonts, "hAnsi") || wA(fonts, "cs") || wA(fonts, "eastAsia");
  }

  const hl = wKid(rPr, "highlight");
  if (hl) { const v = wA(hl, "val"); if (v && HIGHLIGHT[v]) pr.highlightColor = HIGHLIGHT[v]; }

  const shd = wKid(rPr, "shd");
  if (shd) {
    const fill = wA(shd, "fill");
    if (fill && fill !== "auto" && fill.toUpperCase() !== "FFFFFF") pr.bgColor = fill;
  }

  const va = wKid(rPr, "vertAlign");
  if (va) pr.vertAlign = wA(va, "val");

  return pr;
}

// ─── Paragraph property parser ────────────────────────────────────────────────

function parseParPr(pPr) {
  const pr = {};
  if (!pPr) return pr;

  const jc = wKid(pPr, "jc");
  if (jc) pr.align = wA(jc, "val");

  const ind = wKid(pPr, "ind");
  if (ind) {
    const left = wA(ind, "left") || wA(ind, "start");
    const right = wA(ind, "right") || wA(ind, "end");
    const fl = wA(ind, "firstLine");
    const hang = wA(ind, "hanging");
    if (left)  pr.indLeft     = Number(left);
    if (right) pr.indRight    = Number(right);
    if (fl)    pr.indFirst    = Number(fl);
    if (hang)  pr.indHanging  = Number(hang);
  }

  const spacing = wKid(pPr, "spacing");
  if (spacing) {
    const before = wA(spacing, "before");
    const after  = wA(spacing, "after");
    const line   = wA(spacing, "line");
    const rule   = wA(spacing, "lineRule");
    if (before) pr.spaceBefore = Number(before);
    if (after)  pr.spaceAfter  = Number(after);
    if (line)   { pr.lineSpacing = Number(line); pr.lineRule = rule || "auto"; }
  }

  const shd = wKid(pPr, "shd");
  if (shd) {
    const fill = wA(shd, "fill");
    if (fill && fill !== "auto") pr.bgColor = fill;
  }

  const numPr = wKid(pPr, "numPr");
  if (numPr) {
    const ilvlEl = wKid(numPr, "ilvl");
    const numIdEl = wKid(numPr, "numId");
    if (ilvlEl && numIdEl) {
      const nid = wA(numIdEl, "val");
      if (nid && nid !== "0") {
        pr.numId    = nid;
        pr.numLevel = Number(wA(ilvlEl, "val") || "0");
      }
    }
  }

  const rPrEl = wKid(pPr, "rPr");
  if (rPrEl) pr.runPr = parseRunPr(rPrEl);

  return pr;
}

// ─── Style sheet parser ────────────────────────────────────────────────────────

function parseStyles(xml) {
  const styles = { __defaults__: { run: {}, para: {} } };
  if (!xml) return styles;
  const doc = parseXml(xml);

  // Document defaults
  const defs = byTag(doc, W, "docDefaults");
  if (defs) {
    const rPrDef = byTag(defs, W, "rPr");
    if (rPrDef) styles.__defaults__.run = parseRunPr(rPrDef);
    const pPrDef = byTag(defs, W, "pPr");
    if (pPrDef) styles.__defaults__.para = parseParPr(pPrDef);
  }

  const styleEls = byTagAll(doc, W, "style");
  for (const el of styleEls) {
    const id = wA(el, "styleId");
    if (!id) continue;
    const nameEl = wKid(el, "name");
    const basedOnEl = wKid(el, "basedOn");
    const pPrEl = wKid(el, "pPr");
    const rPrEl = wKid(el, "rPr");
    styles[id] = {
      name:     nameEl ? wA(nameEl, "val") : null,
      type:     wA(el, "type"),
      basedOn:  basedOnEl ? wA(basedOnEl, "val") : null,
      para:     pPrEl ? parseParPr(pPrEl) : {},
      run:      rPrEl ? parseRunPr(rPrEl) : {},
    };
  }
  return styles;
}

function resolveStyle(styles, styleId) {
  const seen = new Set();
  const chain = [];
  let cur = styleId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const s = styles[cur];
    if (!s) break;
    chain.unshift(s);
    cur = s.basedOn;
  }
  const merged = { para: Object.assign({}, styles.__defaults__?.para), run: Object.assign({}, styles.__defaults__?.run), name: null };
  for (const s of chain) {
    Object.assign(merged.para, s.para);
    Object.assign(merged.run, s.run);
    if (s.name) merged.name = s.name;
  }
  return merged;
}

// ─── Numbering parser ─────────────────────────────────────────────────────────

function parseNumbering(xml) {
  if (!xml) return {};
  const doc = parseXml(xml);

  const abstractNums = {};
  for (const el of byTagAll(doc, W, "abstractNum")) {
    const id = wA(el, "abstractNumId");
    if (!id) continue;
    const levels = {};
    for (const lvl of byTagAll(el, W, "lvl")) {
      const ilvl = Number(wA(lvl, "ilvl") || 0);
      const fmtEl  = wKid(lvl, "numFmt");
      const fmt    = fmtEl ? (wA(fmtEl, "val") || "bullet") : "bullet";
      const startEl = wKid(lvl, "start");
      const pPrEl  = wKid(lvl, "pPr");
      const indEl  = pPrEl ? wKid(pPrEl, "ind") : null;
      const indLeft = indEl
        ? Number(wA(indEl, "left") || wA(indEl, "start") || 0)
        : 720 + ilvl * 360;
      const hanging = indEl ? Number(wA(indEl, "hanging") || 360) : 360;
      levels[ilvl] = {
        format:    fmt,
        isOrdered: !["bullet", "none"].includes(fmt),
        startVal:  startEl ? Number(wA(startEl, "val") || 1) : 1,
        indLeft,
        hanging,
      };
    }
    abstractNums[id] = levels;
  }

  const numMap = {};
  for (const el of byTagAll(doc, W, "num")) {
    const numId = wA(el, "numId");
    if (!numId) continue;
    const absEl = wKid(el, "abstractNumId");
    if (!absEl) continue;
    const absId = wA(absEl, "val");
    numMap[numId] = abstractNums[absId] || {};
  }
  return numMap;
}

// ─── Relationship parser ───────────────────────────────────────────────────────

function parseRelationships(xml) {
  if (!xml) return {};
  const doc = parseXml(xml);
  const rels = {};
  const els = doc.getElementsByTagName("Relationship");
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    rels[el.getAttribute("Id")] = {
      target: el.getAttribute("Target") || "",
      type:   el.getAttribute("Type") || "",
    };
  }
  return rels;
}

// ─── Image extractor ──────────────────────────────────────────────────────────

async function extractImages(zip) {
  const images = {};
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith("word/media/")) continue;
    const filename = path.split("/").pop();
    const ext = filename.split(".").pop().toLowerCase();
    const mime = IMAGE_MIME[ext] || "application/octet-stream";
    const data = await zip.file(path).async("base64");
    images[filename] = `data:${mime};base64,${data}`;
  }
  return images;
}

// ─── CSS generators ───────────────────────────────────────────────────────────

function runPrToCss(rPr) {
  const css = [];
  if (!rPr) return "";
  if (rPr.bold)        css.push("font-weight:bold");
  if (rPr.italic)      css.push("font-style:italic");
  if (rPr.underline && rPr.strike) css.push("text-decoration:underline line-through");
  else if (rPr.underline) css.push("text-decoration:underline");
  else if (rPr.strike)    css.push("text-decoration:line-through");
  if (rPr.color)         css.push(`color:#${rPr.color}`);
  if (rPr.fontSize)      css.push(`font-size:${halfPtToPt(rPr.fontSize)}pt`);
  if (rPr.fontFamily)    css.push(`font-family:"${rPr.fontFamily}",sans-serif`);
  if (rPr.highlightColor) css.push(`background-color:${rPr.highlightColor}`);
  else if (rPr.bgColor)   css.push(`background-color:#${rPr.bgColor}`);
  if (rPr.vertAlign === "superscript") css.push("vertical-align:super;font-size:smaller");
  if (rPr.vertAlign === "subscript")   css.push("vertical-align:sub;font-size:smaller");
  return css.join(";");
}

const ALIGN_MAP = { left:"left", center:"center", right:"right", both:"justify", distribute:"justify" };

function parPrToCss(pr) {
  const css = [];
  if (!pr) return "";
  if (pr.align && ALIGN_MAP[pr.align]) css.push(`text-align:${ALIGN_MAP[pr.align]}`);
  if (pr.indLeft)    css.push(`margin-left:${twipsToPx(pr.indLeft)}px`);
  if (pr.indRight)   css.push(`margin-right:${twipsToPx(pr.indRight)}px`);
  if (pr.indFirst)   css.push(`text-indent:${twipsToPx(pr.indFirst)}px`);
  else if (pr.indHanging) css.push(`text-indent:-${twipsToPx(pr.indHanging)}px`);
  if (pr.spaceBefore) css.push(`margin-top:${twipsToPx(pr.spaceBefore)}px`);
  if (pr.spaceAfter)  css.push(`margin-bottom:${twipsToPx(pr.spaceAfter)}px`);
  if (pr.lineSpacing) {
    if (pr.lineRule === "auto") {
      css.push(`line-height:${(pr.lineSpacing / 240).toFixed(2)}`);
    } else {
      css.push(`line-height:${twipsToPx(pr.lineSpacing)}px`);
    }
  }
  if (pr.bgColor) css.push(`background-color:#${pr.bgColor}`);
  return css.join(";");
}

// ─── Heading style map ────────────────────────────────────────────────────────

const HEADING_TAG = {
  "Heading1":"h1","Heading 1":"h1","heading 1":"h1","Title":"h1",
  "Heading2":"h2","Heading 2":"h2","heading 2":"h2","Subtitle":"h2",
  "Heading3":"h3","Heading 3":"h3","heading 3":"h3",
  "Heading4":"h4","Heading 4":"h4","heading 4":"h4",
  "Heading5":"h5","Heading 5":"h5","heading 5":"h5",
  "Heading6":"h6","Heading 6":"h6","heading 6":"h6",
};

function tagForStyle(id, name) {
  return HEADING_TAG[id] || HEADING_TAG[name] ||
    (id && /^[Hh]eading\s?([1-6])$/.test(id) ? `h${id.replace(/\D/g,"")}` : "p");
}

// ─── Run renderer ─────────────────────────────────────────────────────────────

function renderRun(runEl, styleRunPr, images, rels) {
  const rPrEl = wKid(runEl, "rPr");
  const directPr = rPrEl ? parseRunPr(rPrEl) : {};
  const mergedPr = Object.assign({}, styleRunPr, directPr);

  // Collect text
  let text = "";
  for (const c of kids(runEl)) {
    if (c.localName === "t") {
      text += c.textContent || "";
    } else if (c.localName === "br") {
      const type = wA(c, "type");
      if (!type || type === "textWrapping") text += "\n";
    } else if (c.localName === "tab") {
      text += "\t";
    }
  }

  // Image drawing
  if (!text) {
    const img = renderDrawing(runEl, images, rels);
    if (img) return img;
    // Check for VML image (legacy)
    const pict = kids(runEl).find(c => c.localName === "pict");
    if (pict) return renderVmlImage(pict, images, rels);
    return "";
  }

  let html = escHtml(text).replace(/\n/g, "<br>").replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;");
  const css = runPrToCss(mergedPr);
  return css ? `<span style="${css}">${html}</span>` : html;
}

function renderDrawing(el, images, rels) {
  const drawing = kids(el).find(c => c.localName === "drawing");
  if (!drawing) return null;

  // Size
  const extent = byTag(drawing, WP, "extent") || drawing.getElementsByTagName("wp:extent")[0];
  const cx = extent ? extent.getAttribute("cx") : 0;
  const cy = extent ? extent.getAttribute("cy") : 0;
  const w = cx ? emuToPx(cx) : 0;
  const h = cy ? emuToPx(cy) : 0;

  // Find blip (image reference)
  const blip = drawing.getElementsByTagName("a:blip")[0]
             || drawing.getElementsByTagNameNS(A, "blip")[0];
  if (!blip) return null;

  const rId = blip.getAttributeNS(R, "embed") || blip.getAttribute("r:embed");
  if (!rId || !rels[rId]) return null;

  const filename = rels[rId].target.replace(/^.*\//, "");
  const src = images[filename];
  if (!src) return null;

  const sizeStyle = w && h ? `width:${w}px;height:${h}px;max-width:100%` : "max-width:100%";
  return `<img src="${src}" style="${sizeStyle}" alt="">`;
}

function renderVmlImage(pict, images, rels) {
  const imgData = pict.getElementsByTagName("v:imagedata")[0];
  if (!imgData) return null;
  const rId = imgData.getAttributeNS(R, "id") || imgData.getAttribute("r:id");
  if (!rId || !rels[rId]) return null;
  const filename = rels[rId].target.replace(/^.*\//, "");
  const src = images[filename];
  if (!src) return null;
  return `<img src="${src}" style="max-width:100%" alt="">`;
}

// ─── Hyperlink renderer ───────────────────────────────────────────────────────

function renderHyperlink(hlEl, styleRunPr, images, rels) {
  const rId    = rA(hlEl, "id");
  const anchor = wA(hlEl, "anchor");
  let href = "#";
  if (rId && rels[rId]) href = safeHref(rels[rId].target);
  else if (anchor) href = `#${escHtml(anchor)}`;

  const inner = renderParagraphChildren(hlEl, styleRunPr, images, rels);
  return `<a href="${escHtml(href)}">${inner}</a>`;
}

// ─── Paragraph content renderer ───────────────────────────────────────────────

function renderParagraphChildren(el, styleRunPr, images, rels) {
  let html = "";
  for (const c of kids(el)) {
    switch (c.localName) {
      case "r":         html += renderRun(c, styleRunPr, images, rels); break;
      case "hyperlink": html += renderHyperlink(c, styleRunPr, images, rels); break;
      case "ins":
      case "del":       html += renderParagraphChildren(c, styleRunPr, images, rels); break;
      case "bookmarkStart":
      case "bookmarkEnd":
      case "proofErr":
      case "pPr":       break;
    }
  }
  return html;
}

// ─── Paragraph renderer ───────────────────────────────────────────────────────

function renderParagraph(paraEl, styles, images, rels, insideCell) {
  const pPrEl   = wKid(paraEl, "pPr");
  const pStyleEl = pPrEl ? wKid(pPrEl, "pStyle") : null;
  const styleId  = pStyleEl ? wA(pStyleEl, "val") : null;

  const resolved = styleId ? resolveStyle(styles, styleId) : { para: {}, run: {}, name: null };
  const directPr = pPrEl ? parseParPr(pPrEl) : {};
  const mergedPr = Object.assign({}, resolved.para, directPr);

  // Effective run properties: style chain + paragraph-level rPr override
  const styleRunPr = Object.assign({}, resolved.run, directPr.runPr || {});

  const isListItem = !!mergedPr.numId;

  const htmlTag = insideCell ? "p" : tagForStyle(styleId, resolved.name);

  const cssParts = [];
  const pCss = parPrToCss(mergedPr);
  if (pCss) cssParts.push(pCss);
  const rCss = runPrToCss(styleRunPr);
  if (rCss) cssParts.push(rCss);
  const css = cssParts.join(";");
  const styleAttr = css ? ` style="${css}"` : "";

  const content = renderParagraphChildren(paraEl, styleRunPr, images, rels);

  if (isListItem) {
    return {
      isListItem: true,
      numId:   mergedPr.numId,
      level:   mergedPr.numLevel || 0,
      content,
      styleAttr,
    };
  }

  if (!content.trim()) return `<${htmlTag}>&nbsp;</${htmlTag}>`;
  return `<${htmlTag}${styleAttr}>${content}</${htmlTag}>`;
}

// ─── Table renderer ───────────────────────────────────────────────────────────

function parseBorder(bordersEl, side) {
  if (!bordersEl) return null;
  const el = wKid(bordersEl, side);
  if (!el) return null;
  const val = wA(el, "val");
  if (!val || val === "none" || val === "nil") return "none";
  const sz    = Number(wA(el, "sz") || 8) / 8;
  const color = wA(el, "color");
  const hex   = color && color !== "auto" ? `#${color}` : "#000000";
  const type  = val === "dashed" ? "dashed" : val === "dotted" ? "dotted" : "solid";
  return `${Math.max(0.5, sz)}pt ${type} ${hex}`;
}

function renderTable(tblEl, styles, numbering, images, rels) {
  const tblPrEl   = wKid(tblEl, "tblPr");
  const tblBorders = tblPrEl ? wKid(tblPrEl, "tblBorders") : null;
  const defaultBorder = parseBorder(tblBorders, "insideH") || parseBorder(tblBorders, "top") || "1px solid #000";

  // Table width
  const tblWEl = tblPrEl ? wKid(tblPrEl, "tblW") : null;
  const tblWtype = tblWEl ? wA(tblWEl, "type") : null;
  const tblWval  = tblWEl ? Number(wA(tblWEl, "w") || 0) : 0;
  let tableWidth = "100%";
  if (tblWtype === "pct" && tblWval) tableWidth = `${tblWval / 50}%`;

  // Grid column widths (twips)
  const gridCols = wKids(wKid(tblEl, "tblGrid"), "gridCol").map(c => Number(wA(c, "w") || 0));
  const totalGridWidth = gridCols.reduce((a, b) => a + b, 0) || 1;

  let html = `<table style="border-collapse:collapse;width:${tableWidth};table-layout:fixed;margin:8pt 0">`;

  // Colgroup for proportional widths
  if (gridCols.length > 0) {
    html += "<colgroup>";
    for (const w of gridCols) {
      html += `<col style="width:${((w / totalGridWidth) * 100).toFixed(2)}%">`;
    }
    html += "</colgroup>";
  }

  const rows = wKids(tblEl, "tr");
  // Track vMerge: colIdx → remaining rowspan
  const vMergeCount = {};

  for (const row of rows) {
    const trPrEl = wKid(row, "trPr");
    const trHeight = trPrEl ? wKid(trPrEl, "trHeight") : null;
    const rowHeightCss = trHeight ? ` style="height:${twipsToPx(Number(wA(trHeight, "val") || 0))}px"` : "";

    html += `<tr${rowHeightCss}>`;
    let colIdx = 0;

    for (const cell of wKids(row, "tc")) {
      const tcPrEl = wKid(cell, "tcPr");

      // Skip columns occupied by active vMerge
      while (vMergeCount[colIdx] > 0) {
        vMergeCount[colIdx]--;
        colIdx++;
      }

      // Colspan
      const gridSpan = tcPrEl ? wKid(tcPrEl, "gridSpan") : null;
      const colspan  = gridSpan ? Number(wA(gridSpan, "val") || 1) : 1;

      // vMerge
      const vMerge = tcPrEl ? wKid(tcPrEl, "vMerge") : null;
      if (vMerge && !wA(vMerge, "val")) {
        // Continuation — skip this cell entirely
        colIdx += colspan;
        continue;
      }
      // vMerge restart — calculate rowspan
      let rowspan = 1;
      if (vMerge && wA(vMerge, "val") === "restart") {
        let ri = rows.indexOf(row) + 1;
        while (ri < rows.length) {
          const nextRow = rows[ri];
          const nextCells = wKids(nextRow, "tc");
          let ci = 0;
          let found = false;
          for (const nc of nextCells) {
            if (ci === colIdx) {
              const nPr = wKid(nc, "tcPr");
              const nVM = nPr ? wKid(nPr, "vMerge") : null;
              if (nVM && !wA(nVM, "val")) { rowspan++; found = true; }
              break;
            }
            ci += Number(wA(wKid(wKid(nc, "tcPr"), "gridSpan"), "val") || 1);
          }
          if (!found) break;
          ri++;
        }
        vMergeCount[colIdx] = rowspan - 1;
      }

      // Cell width
      const tcW = tcPrEl ? wKid(tcPrEl, "tcW") : null;
      let cellWidthCss = "";
      if (tcW) {
        const wv = Number(wA(tcW, "w") || 0);
        const wt = wA(tcW, "type");
        if (wt === "pct" && wv) cellWidthCss = `width:${wv / 50}%;`;
        else if (wt === "dxa" && wv) cellWidthCss = `width:${twipsToPx(wv)}px;`;
      }

      // Cell background
      const tcShd = tcPrEl ? wKid(tcPrEl, "shd") : null;
      let cellBgCss = "";
      if (tcShd) {
        const fill = wA(tcShd, "fill");
        if (fill && fill !== "auto" && fill.toUpperCase() !== "FFFFFF") {
          cellBgCss = `background-color:#${fill};`;
        }
      }

      // Cell borders
      const tcBorders = tcPrEl ? wKid(tcPrEl, "tcBorders") : null;
      const bTop    = parseBorder(tcBorders, "top")    || defaultBorder;
      const bBottom = parseBorder(tcBorders, "bottom") || defaultBorder;
      const bLeft   = parseBorder(tcBorders, "left")   || defaultBorder;
      const bRight  = parseBorder(tcBorders, "right")  || defaultBorder;
      const borderCss = `border-top:${bTop};border-bottom:${bBottom};border-left:${bLeft};border-right:${bRight};`;

      // Vertical align
      const vAlignEl = tcPrEl ? wKid(tcPrEl, "vAlign") : null;
      const vAlignVal = vAlignEl ? (wA(vAlignEl, "val") || "top") : "top";
      const vAlignCss = vAlignVal === "center" ? "middle" : vAlignVal === "bottom" ? "bottom" : "top";

      const cellStyle = `padding:4px 8px;${cellWidthCss}${cellBgCss}${borderCss}vertical-align:${vAlignCss};`;
      const colspanAttr = colspan > 1 ? ` colspan="${colspan}"` : "";
      const rowspanAttr = rowspan > 1 ? ` rowspan="${rowspan}"` : "";

      html += `<td${colspanAttr}${rowspanAttr} style="${cellStyle}">`;

      for (const child of kids(cell)) {
        if (child.localName === "p") {
          html += renderParagraph(child, styles, images, rels, true);
        } else if (child.localName === "tbl") {
          html += renderTable(child, styles, numbering, images, rels);
        }
      }

      html += "</td>";
      colIdx += colspan;
    }

    html += "</tr>";
  }

  html += "</table>";
  return html;
}

// ─── Body renderer ────────────────────────────────────────────────────────────

function renderBody(bodyEl, styles, numbering, images, rels) {
  const parts = [];
  const listStack = []; // { numId, level, tag }

  const closeLists = () => {
    while (listStack.length) parts.push(`</${listStack.pop().tag}>`);
  };

  const closeListsAbove = (level) => {
    while (listStack.length && listStack[listStack.length - 1].level > level) {
      parts.push(`</${listStack.pop().tag}>`);
    }
  };

  for (const child of kids(bodyEl)) {
    switch (child.localName) {
      case "p": {
        const result = renderParagraph(child, styles, images, rels, false);
        if (typeof result === "object" && result.isListItem) {
          const { numId, level, content, styleAttr } = result;
          const numDef = numbering[numId] || {};
          const lvlDef = numDef[level] || {};

          // Close lists that don't match current list or are deeper
          if (listStack.length && listStack[listStack.length - 1].numId !== numId) {
            closeLists();
          } else {
            closeListsAbove(level - 1);
          }

          // Open new list levels until we reach current level
          while (listStack.length === 0 || listStack[listStack.length - 1].level < level) {
            const newLevel = listStack.length ? listStack[listStack.length - 1].level + 1 : 0;
            const def = numDef[newLevel] || {};
            const tag = def.isOrdered ? "ol" : "ul";
            const startAttr = def.startVal > 1 ? ` start="${def.startVal}"` : "";
            const indStyle = def.indLeft ? ` style="padding-left:${twipsToPx(def.indLeft)}px"` : "";
            parts.push(`<${tag}${startAttr}${indStyle}>`);
            listStack.push({ numId, level: newLevel, tag });
          }

          parts.push(`<li${styleAttr}>${content}</li>`);
        } else {
          closeLists();
          if (result) parts.push(result);
        }
        break;
      }
      case "tbl":
        closeLists();
        parts.push(renderTable(child, styles, numbering, images, rels));
        break;
      case "sdt": {
        // Structured document tag — render its content
        const sdtContent = wKid(child, "sdtContent");
        if (sdtContent) {
          const inner = renderBody(sdtContent, styles, numbering, images, rels);
          parts.push(inner);
        }
        break;
      }
      case "sectPr":
      default:
        break;
    }
  }

  closeLists();
  return parts.join("\n");
}

// ─── Base Word stylesheet ─────────────────────────────────────────────────────

const WORD_BASE_CSS = `
.docx-content{font-family:Calibri,"Segoe UI",Arial,sans-serif;font-size:11pt;line-height:1.5;color:#000;word-wrap:break-word}
.docx-content h1{font-size:26pt;color:#2E74B5;margin:12pt 0 6pt;font-weight:bold}
.docx-content h2{font-size:20pt;color:#2E74B5;margin:10pt 0 6pt;font-weight:bold}
.docx-content h3{font-size:16pt;color:#1F4E79;margin:8pt 0 4pt;font-weight:bold}
.docx-content h4{font-size:14pt;color:#2E74B5;margin:8pt 0 4pt;font-weight:bold}
.docx-content h5{font-size:12pt;font-weight:bold;margin:6pt 0 4pt}
.docx-content h6{font-size:11pt;font-weight:bold;margin:6pt 0 4pt}
.docx-content p{margin:0 0 8pt}
.docx-content table{border-collapse:collapse;width:100%;margin:8pt 0}
.docx-content td,.docx-content th{padding:4px 8px;border:1px solid #000;word-break:break-word}
.docx-content ul,.docx-content ol{margin:0 0 8pt;padding-left:40px}
.docx-content li{margin-bottom:2pt}
.docx-content a{color:#0563C1;text-decoration:underline}
.docx-content img{max-width:100%;height:auto;display:inline-block}
`.trim();

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Convert a .docx buffer to HTML preserving Word formatting.
 * @param {Buffer} buffer
 * @returns {Promise<{html: string, warnings: string[]}>}
 */
async function docxToHtml(buffer) {
  const warnings = [];

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (e) {
    warnings.push("Failed to read docx archive: " + e.message);
    return { html: "", warnings };
  }

  const readXml = async (path) => {
    const f = zip.file(path);
    return f ? f.async("string") : "";
  };

  const [documentXml, stylesXml, numberingXml, relsXml] = await Promise.all([
    readXml("word/document.xml"),
    readXml("word/styles.xml"),
    readXml("word/numbering.xml"),
    readXml("word/_rels/document.xml.rels"),
  ]);

  if (!documentXml) {
    warnings.push("word/document.xml not found");
    return { html: "", warnings };
  }

  const styles     = parseStyles(stylesXml);
  const numbering  = parseNumbering(numberingXml);
  const rels       = parseRelationships(relsXml);
  const images     = await extractImages(zip);

  const docDom = parseXml(documentXml);
  const bodyEl = byTag(docDom, W, "body");

  if (!bodyEl) {
    warnings.push("Could not find w:body in document.xml");
    return { html: "", warnings };
  }

  const bodyHtml = renderBody(bodyEl, styles, numbering, images, rels);
  const html = `<style>${WORD_BASE_CSS}</style><div class="docx-content">${bodyHtml}</div>`;

  return { html, warnings };
}

module.exports = { docxToHtml };
