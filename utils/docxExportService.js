"use strict";

/**
 * docxExportService.js
 * ────────────────────
 * Reusable HTML → DOCX export, symmetric with docxImportService.
 *
 * Strategy (highest fidelity first):
 *   1. LibreOffice headless (`soffice --convert-to docx`) — round-trips the
 *      stored HTML (incl. the LibreOffice <style> block, fonts, alignment,
 *      tables) back into a clean Word document.
 *   2. Fallback: `html-to-docx`. It cannot parse <style> blocks (it would dump
 *      the CSS as literal text), so we strip them and inline-only formatting is
 *      kept. Lower fidelity but no system dependency.
 *
 * Used by exportToDocx in policyHubTemplate / afcDocument / policyHub controllers.
 */

const HTMLtoDOCX  = require("html-to-docx");
const fs   = require("fs/promises");
const os   = require("os");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { resolveSoffice, withLibreOfficeLock, runSoffice } = require("./docxImportService");
const { injectHeaderFooter } = require("./docxSectionService");

// Strip <style> blocks — html-to-docx renders their contents as visible text.
function stripStyleTags(html = "") {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

function wrapDocument(html, title) {
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `${title ? `<title>${title}</title>` : ""}</head><body>${html}</body></html>`
  );
}

// ── LibreOffice HTML → DOCX ─────────────────────────────────────────────────
async function libreOfficeHtmlToDocx(html, title) {
  const bin = await resolveSoffice();
  if (!bin) {
    const e = new Error("LibreOffice (soffice) not found");
    e.code = "ENO_LIBREOFFICE";
    throw e;
  }

  const work = path.join(os.tmpdir(), `docxexport-${crypto.randomUUID()}`);
  const profile = path.join(work, "lo-profile");
  await fs.mkdir(work, { recursive: true });
  const inputPath = path.join(work, "input.html");
  // Keep the <style> block — LibreOffice applies it for full fidelity.
  await fs.writeFile(inputPath, wrapDocument(html, title), "utf8");

  try {
    await withLibreOfficeLock(() =>
      runSoffice(
        bin,
        [
          "--headless", "--invisible", "--nodefault", "--norestore",
          "--nologo", "--nofirststartwizard", "--nolockcheck",
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--convert-to", "docx:MS Word 2007 XML",
          "--outdir", work,
          inputPath,
        ],
        { timeout: 90000 },
      ),
    );
    return await fs.readFile(path.join(work, "input.docx"));
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ── html-to-docx fallback (supports header/footer HTML natively) ────────────
async function fallbackHtmlToDocx(html, title, { headerHtml = "", footerHtml = "" } = {}) {
  const safe = wrapDocument(stripStyleTags(html), title);
  return HTMLtoDOCX(
    safe,
    headerHtml ? stripStyleTags(headerHtml) : null,
    {
      header: !!headerHtml,
      footer: !!footerHtml,
      pageNumber: false,
      table: { row: { cantSplit: true } },
    },
    footerHtml ? stripStyleTags(footerHtml) : null,
  );
}

/**
 * Convert stored document HTML to a .docx buffer.
 * @param {string} html  - stored docs HTML (may contain a LibreOffice <style> block)
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.headerHtml] - page header HTML
 * @param {string} [opts.footerHtml] - page footer HTML
 * @returns {Promise<{ buffer: Buffer, engine: "libreoffice"|"html-to-docx" }>}
 */
async function convertHtmlToDocx(html, opts = {}) {
  const { title, headerHtml = "", footerHtml = "" } = opts;
  try {
    // Body via LibreOffice (best fidelity) → inject real header/footer parts.
    let buffer = await libreOfficeHtmlToDocx(html, title);
    buffer = await injectHeaderFooter(buffer, { headerHtml, footerHtml });
    return { buffer, engine: "libreoffice" };
  } catch (e) {
    if (e.code !== "ENO_LIBREOFFICE") {
      console.warn("[docxExportService] LibreOffice export failed, falling back to html-to-docx:", e.message);
    }
    // Fallback: html-to-docx embeds header/footer HTML natively (lower body fidelity).
    const buffer = await fallbackHtmlToDocx(html, title, { headerHtml, footerHtml });
    return { buffer, engine: "html-to-docx" };
  }
}

module.exports = { convertHtmlToDocx, stripStyleTags, wrapDocument };
