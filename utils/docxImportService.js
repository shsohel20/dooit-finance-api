"use strict";

/**
 * docxImportService.js
 * ────────────────────
 * Single, reusable DOCX → HTML import pipeline used by every import surface:
 *   - policyHubTemplateController  (Template import → TinyMCE)
 *   - afcDocumentController        (Generated/Imported doc → TinyMCE)
 *   - policyHubController          (Policy Hub import → Editor.js, HTML storage)
 *   - amlDocGenService            (generated .docx → docs HTML)
 *
 * Goal: keep the imported document looking like the original Word file —
 * fonts, sizes, alignment, colours, spacing, tables, images.
 *
 * Strategy (highest fidelity first):
 *   1. LibreOffice headless (`soffice --convert-to html`) — emits inline CSS for
 *      fonts/sizes/alignment/colours; closest to Word. Requires LibreOffice on
 *      the API host (set LIBREOFFICE_PATH or have soffice/libreoffice on PATH).
 *   2. Fallback: mammoth with a widened style map + inline images (semantic HTML;
 *      structure preserved, direct font/colour formatting not guaranteed).
 * Both outputs pass through a formatting-preserving sanitize (keeps style/class/
 * colspan/rowspan/alignment/underline; strips scripts + event handlers).
 *
 * Public API:
 *   importDocxToHtml(buffer)   → { html, engine, messages }  (convert + sanitize)
 *   convertDocxToHtml(buffer)  → { html, messages }          (mammoth only, raw)
 *   sanitizeForEditor(html)    → string                      (safe, formatting kept)
 */

const mammoth      = require("mammoth");
const sanitizeHtml = require("sanitize-html");
const { spawn } = require("child_process");
const { existsSync } = require("fs");
const fs   = require("fs/promises");
const os   = require("os");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

/**
 * Run a soffice command with stdin DETACHED (stdio stdin = "ignore").
 * Critical: LibreOffice may print a banner + "Press Enter to continue…" prompt;
 * with an open stdin pipe (execFile's default) that read blocks until timeout.
 * Routing stdin from /dev/null makes the prompt hit EOF and proceed immediately.
 * @returns {Promise<{ stderr: string }>}
 */
function runSoffice(bin, args, { timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // stdout MUST be piped (Windows soffice.exe needs it to exit); stdin
      // detached so any prompt hits EOF and proceeds instead of blocking.
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(Object.assign(new Error("soffice timed out"), { code: "ESOFFICE_TIMEOUT" }));
    }, timeout);

    child.stdout?.on("data", () => {}); // drain so the pipe never fills/blocks
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve({ stderr });
      else reject(Object.assign(new Error(`soffice exited ${code}: ${stderr.slice(0, 200)}`), { code: "ESOFFICE" }));
    });
  });
}

// ── Mammoth style map ───────────────────────────────────────────────────────
// includeDefaultStyleMap:true already covers Heading 1-6, lists, tables,
// hyperlinks, bold→strong, italic→em. We add the elements Word emits that the
// default map drops: underline, strikethrough, super/subscript, and the named
// Title/Subtitle/Quote paragraph styles.
const STYLE_MAP = [
  "u => u",
  "strike => s",
  "p[style-name='Title'] => h1.doc-title:fresh",
  "p[style-name='Subtitle'] => h2.doc-subtitle:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote.intense:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  "p[style-name='Heading 5'] => h5:fresh",
  "p[style-name='Heading 6'] => h6:fresh",
  "r[style-name='Strong'] => strong",
  "r[style-name='Emphasis'] => em",
];

// Inline embedded images as base64 data URIs so the document is self-contained
// (no external file dependency for preview/edit/export round-trips).
const convertImage = mammoth.images.imgElement((image) =>
  image.read("base64").then((b64) => ({
    src: `data:${image.contentType};base64,${b64}`,
  })),
);

const MAMMOTH_OPTIONS = {
  styleMap: STYLE_MAP,
  includeDefaultStyleMap: true,
  convertImage,
};

// ── Sanitize config (formatting-preserving) ─────────────────────────────────
// Keeps everything a compliance document needs; removes only active content.
const EDITOR_SANITIZE_OPTIONS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "h1", "h2", "img", "u", "s", "sup", "sub", "span", "section", "figure",
    "figcaption", "col", "colgroup", "br", "hr", "mark", "small", "font", "center",
  ],
  // Preserve inline formatting (text-align, font-weight, colours) + table structure
  allowedAttributes: {
    "*": ["style", "class", "align", "valign", "dir", "lang", "id", "bgcolor", "width", "height"],
    a: ["href", "name", "target", "rel", "title"],
    img: ["src", "alt", "title", "width", "height", "style"],
    font: ["color", "face", "size", "style"],
    td: ["colspan", "rowspan", "style", "align", "valign", "width", "height", "bgcolor", "nowrap"],
    th: ["colspan", "rowspan", "style", "align", "valign", "width", "height", "scope", "bgcolor"],
    table: ["style", "class", "width", "border", "cellpadding", "cellspacing", "bgcolor", "align"],
    col: ["span", "style", "width"],
    colgroup: ["span", "style"],
    ol: ["start", "type", "style"],
    ul: ["style"],
  },
  // data: required for inline base64 images
  allowedSchemes: ["http", "https", "mailto", "tel", "data"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  // Keep the full inline style string (no per-property whitelist → no loss)
  allowVulnerableTags: false,
  // Drop dangerous/active content entirely
  disallowedTagsMode: "discard",
  exclusiveFilter: () => false,
};

/**
 * Convert a .docx buffer to raw (unsanitized) HTML via mammoth.
 * @param {Buffer} buffer
 * @returns {Promise<{ html: string, messages: Array }>}
 */
async function convertDocxToHtml(buffer) {
  const result = await mammoth.convertToHtml({ buffer }, MAMMOTH_OPTIONS);
  return { html: result.value || "", messages: result.messages || [] };
}

// ── LibreOffice headless conversion (highest fidelity) ──────────────────────

// Candidate binaries tried in order; first that responds to --version is cached.
const SOFFICE_CANDIDATES = [
  process.env.LIBREOFFICE_PATH,
  "soffice",
  "libreoffice",
  "C:/Program Files/LibreOffice/program/soffice.exe",
  "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
].filter(Boolean);

let _sofficeBin; // undefined = not probed; null = unavailable; string = path

// Resolve a bare command (e.g. "soffice") via PATH without executing it.
// NOTE: we deliberately never run `soffice --version` — on Windows it prints a
// banner + "Press Enter to continue…" and hangs on stdin. Detection here is
// execution-free so it can never prompt or block.
function whichCmd(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    let child;
    try {
      child = spawn(finder, [cmd], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    } catch {
      return resolve(false);
    }
    const to = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 5000);
    child.on("error", () => { clearTimeout(to); resolve(false); });
    child.on("close", (code) => { clearTimeout(to); resolve(code === 0); });
  });
}

async function resolveSoffice() {
  if (_sofficeBin !== undefined) return _sofficeBin;
  for (const bin of SOFFICE_CANDIDATES) {
    const looksLikePath = path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\");
    if (looksLikePath) {
      if (existsSync(bin)) { _sofficeBin = bin; return bin; }
    } else if (await whichCmd(bin)) {
      _sofficeBin = bin;
      return bin;
    }
  }
  _sofficeBin = null;
  return null;
}

// LibreOffice headless does not handle concurrent invocations reliably (shared
// pipe/lock), so serialize all soffice spawns process-wide. Shared by the import
// and export services. Conversions are short and infrequent, so a simple queue is fine.
let _loChain = Promise.resolve();
function withLibreOfficeLock(fn) {
  const run = _loChain.then(fn, fn);
  _loChain = run.then(() => {}, () => {});
  return run;
}

const MIME_BY_EXT = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff",
};

// Inline LibreOffice's relative <img> file references as base64 data URIs so the
// stored HTML is self-contained (older LO versions write images as side files).
async function inlineRelativeImages(html, baseDir) {
  const srcs = new Set();
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (!/^(data:|https?:|file:)/i.test(src)) srcs.add(src);
  }
  let out = html;
  for (const src of srcs) {
    try {
      const buf = await fs.readFile(path.join(baseDir, decodeURIComponent(src)));
      const mime = MIME_BY_EXT[path.extname(src).toLowerCase()] || "image/png";
      const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
      out = out.split(`"${src}"`).join(`"${dataUri}"`).split(`'${src}'`).join(`'${dataUri}'`);
    } catch {
      /* leave the reference if the file is missing */
    }
  }
  return out;
}

// Pull the <style> block + <body> contents out of a full HTML document.
function splitStyleBody(fullHtml) {
  const styleMatch = fullHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const bodyMatch  = fullHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return {
    style: styleMatch ? styleMatch[1] : "",
    body:  bodyMatch ? bodyMatch[1] : fullHtml,
  };
}

// Minimal CSS hardening for the preserved <style> block (admin-only routes).
function sanitizeCss(css) {
  if (!css) return "";
  return css
    .replace(/<\/?[^>]*>/g, "")            // no tags inside CSS
    .replace(/@import[^;]+;/gi, "")        // no external imports
    .replace(/expression\s*\(/gi, "")      // no IE expressions
    .replace(/javascript:/gi, "")
    .replace(/url\s*\(\s*['"]?\s*(javascript|vbscript):/gi, "url(")
    .trim();
}

/**
 * Convert a .docx buffer to high-fidelity HTML via LibreOffice headless.
 * Preserves fonts, sizes, alignment, colours, spacing, tables, images.
 * @param {Buffer} buffer
 * @returns {Promise<string>} full HTML document
 * @throws if LibreOffice is unavailable or conversion fails
 */
async function convertWithLibreOffice(buffer) {
  const bin = await resolveSoffice();
  if (!bin) {
    const e = new Error("LibreOffice (soffice) not found");
    e.code = "ENO_LIBREOFFICE";
    throw e;
  }

  const work = path.join(os.tmpdir(), `docximport-${crypto.randomUUID()}`);
  const profile = path.join(work, "lo-profile"); // unique profile → safe concurrency
  await fs.mkdir(work, { recursive: true });
  const inputPath = path.join(work, "input.docx");
  await fs.writeFile(inputPath, buffer);

  try {
    await withLibreOfficeLock(() =>
      runSoffice(
        bin,
        [
          "--headless", "--invisible", "--nodefault", "--norestore",
          "--nologo", "--nofirststartwizard", "--nolockcheck",
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--convert-to", "html",
          "--outdir", work,
          inputPath,
        ],
        { timeout: 90000 },
      ),
    );

    const outPath = path.join(work, "input.html");
    const raw = await fs.readFile(outPath, "utf8");
    return inlineRelativeImages(raw, work);
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// LibreOffice wraps page headers/footers in <div title="header">/<div title="footer">
// at the top/bottom of the body. The header/footer are stored separately
// (docxSectionService), so strip them here to keep the body free of duplicates.
// Must run BEFORE sanitize (which drops the title attribute).
function stripDocxSections(html = "") {
  return html
    .replace(/<div\b[^>]*\btitle="header[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<div\b[^>]*\btitle="footer[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
}

/**
 * Sanitize HTML for safe storage/editing while preserving document formatting.
 * @param {string} html
 * @returns {string}
 */
function sanitizeForEditor(html) {
  if (!html) return "";
  return sanitizeHtml(html, EDITOR_SANITIZE_OPTIONS);
}

/**
 * Full import: convert + sanitize, highest fidelity available.
 * Tries LibreOffice (fonts/sizes/alignment/colours preserved), falls back to
 * mammoth (semantic HTML) if LibreOffice is unavailable or errors.
 * @param {Buffer} buffer
 * @returns {Promise<{ html: string, engine: "libreoffice"|"mammoth", messages: Array, fallbackReason?: string }>}
 */
async function importDocxToHtml(buffer) {
  // 1) LibreOffice — preserves the original Word styling
  try {
    const full = await convertWithLibreOffice(buffer);
    const { style, body } = splitStyleBody(full);
    const safeStyle = sanitizeCss(style);
    const safeBody  = sanitizeForEditor(stripDocxSections(body));
    const html = (safeStyle ? `<style>${safeStyle}</style>\n` : "") + safeBody;
    return { html, engine: "libreoffice", messages: [] };
  } catch (loErr) {
    if (loErr.code !== "ENO_LIBREOFFICE") {
      console.warn(`[docxImportService] LibreOffice conversion failed, falling back to mammoth:`, loErr.message);
    }
    // 2) Fallback — mammoth semantic HTML
    const { html, messages } = await convertDocxToHtml(buffer);
    return {
      html: sanitizeForEditor(html),
      engine: "mammoth",
      messages,
      fallbackReason: loErr.message,
    };
  }
}

module.exports = {
  convertDocxToHtml,
  convertWithLibreOffice,
  sanitizeForEditor,
  sanitizeCss,
  splitStyleBody,
  inlineRelativeImages,
  importDocxToHtml,
  resolveSoffice,
  withLibreOfficeLock,
  runSoffice,
  EDITOR_SANITIZE_OPTIONS,
  MAMMOTH_OPTIONS,
};
