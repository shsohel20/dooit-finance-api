"use strict";
const ExcelJS       = require("exceljs");
const asyncHandler  = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const EwraAssessment       = require("../models/EwraAssessment");
const EwraRiskFactor       = require("../models/EwraRiskFactor");
const EwraControlAssessment = require("../models/EwraControlAssessment");

const REGISTER  = require("../_data/seed/sample_risk_register.json");
// const REGISTER  = require("../../seed/sample_risk_register.json");
const MATRIX_FW = require("../_data/seed/risk_matrix_framework.json");
//

// ── ARGB Color Palette ────────────────────────────────────────────────────────
const PAL = {
  E:       { bg: "FFC00000", fg: "FFFFFFFF" },
  H:       { bg: "FFFF4500", fg: "FFFFFFFF" },
  M:       { bg: "FFFFCC00", fg: "FF1A1A1A" },
  L:       { bg: "FF70AD47", fg: "FFFFFFFF" },
  VL:      { bg: "FF00B050", fg: "FFFFFFFF" },
  TITLE:   { bg: "FF1F3864", fg: "FFFFFFFF" },
  META:    { bg: "FFDCE6F1", fg: "FF1F3864" },
  LEGEND:  { bg: "FFEAF1FB", fg: "FF1F3864" },
  COLHDR:  { bg: "FF2E75B6", fg: "FFFFFFFF" },
  SECTION: { bg: "FF1F3864", fg: "FFFFFFFF" },
  EVEN:    { bg: "FFF2F7FD", fg: "FF000000" },
  ODD:     { bg: "FFFFFFFF", fg: "FF000000" },
  ACTION:  { bg: "FFFFF0F0", fg: "FFC00000" },
  FOOTER:  { bg: "FF243F60", fg: "FFB0C4DE" },
  MATRIX_EXTREME:  { bg: "FFC00000", fg: "FFFFFFFF" },
  MATRIX_HIGH:     { bg: "FFFF4500", fg: "FFFFFFFF" },
  MATRIX_MEDIUM:   { bg: "FFFFCC00", fg: "FF1A1A1A" },
  MATRIX_LOW:      { bg: "FF70AD47", fg: "FFFFFFFF" },
  MATRIX_VERYLOW:  { bg: "FF00B050", fg: "FFFFFFFF" },
};

const RISK_FULL  = { E: "Extreme", H: "High", M: "Medium", L: "Low", VL: "Very Low" };

// 5×5 matrix table: row = likelihood (1=bottom to 5=top), col = consequence (1–5)
// Presented top-down as likelihood 5→1.
// Corrected 12 Jun 2026 against Risk_Matrix.md (L3C3=M, L2C1=VL, L1C2=VL) —
// canonical grid lives in utils/ewraRiskRegister.js (INHERENT_MATRIX).
const MATRIX_GRID = [
  ["M","H","E","E","E"],    // L=5 Almost Certain
  ["M","M","H","E","E"],    // L=4 Likely
  ["L","M","M","H","E"],    // L=3 Possible
  ["VL","L","M","M","H"],   // L=2 Unlikely
  ["VL","VL","L","M","M"],  // L=1 Rare
];

const LIKELIHOOD_LABELS = [
  "5 – Almost Certain",
  "4 – Likely",
  "3 – Possible",
  "2 – Unlikely",
  "1 – Rare",
];
const CONSEQUENCE_LABELS = [
  "1 – Insignificant",
  "2 – Minor",
  "3 – Moderate",
  "4 – Major",
  "5 – Extreme",
];

function riskColor(code) {
  const key = (code || "").toUpperCase();
  return PAL[key] || { bg: "FFFFFFFF", fg: "FF000000" };
}

// ── Worksheet column definitions (18 columns) ─────────────────────────────────
const COLS = [
  { key: "ref",       width: 6  },
  { key: "riskType",  width: 14 },
  { key: "channel",   width: 9  },
  { key: "riskName",  width: 36 },
  { key: "descFlags", width: 50 },
  { key: "pfNote",    width: 32 },
  { key: "lhd",       width: 12 },
  { key: "cons",      width: 13 },
  { key: "inherent",  width: 14 },
  { key: "controls",  width: 50 },
  { key: "ctrlEff",   width: 10 },
  { key: "residual",  width: 14 },
  { key: "action",    width: 13 },
  { key: "ctrlIds",   width: 30 },
  { key: "owner",     width: 18 },
  { key: "appetite",  width: 14 },
  { key: "prepBy",    width: 13 },
  { key: "revBy",     width: 13 },
];

const COL_HEADERS = [
  "REF",
  "RISK TYPE",
  "CHANNEL",
  "RISK NAME / SCENARIO",
  "DESCRIPTION, CAUSE & RED FLAGS",
  "PF / SANCTIONS NOTE",
  "LIKELIHOOD\n(1–5)",
  "CONSEQUENCE\n(1–5)",
  "INHERENT\nRISK",
  "EXISTING CONTROLS",
  "CTRL\nEFF",
  "RESIDUAL\nRISK",
  "ACTION\nNEEDED",
  "CONTROL IDs",
  "CONTROLS\nOWNER",
  "RISK\nAPPETITE",
  "PREPARED\nBY",
  "REVIEWED\nBY",
];

const N_COLS  = COLS.length;          // 18
const LAST_C  = colLetter(N_COLS);    // "R"

function colLetter(n) {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// ── Shared cell helpers ───────────────────────────────────────────────────────
const THIN   = { style: "thin",   color: { argb: "FFD0D7E0" } };
const MEDIUM = { style: "medium", color: { argb: "FF8EAABF" } };

function applyBorder(cell, thick = false) {
  const b = thick ? MEDIUM : THIN;
  cell.border = { top: b, left: b, bottom: b, right: b };
}

function solidFill(cell, argb) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function setFont(cell, opts) {
  cell.font = { name: "Calibri", ...opts };
}

function setAlign(cell, h = "left", v = "middle", wrap = false) {
  cell.alignment = { horizontal: h, vertical: v, wrapText: wrap };
}

// ── Merge + style a full-width row ────────────────────────────────────────────
function fullWidthRow(ws, text, bgArgb, fgArgb, sizePt, bold, height, subText = "") {
  const r = ws.addRow([text]);
  ws.mergeCells(`A${r.number}:${LAST_C}${r.number}`);
  const cell = r.getCell("A");
  cell.value = subText ? { richText: [{ text, font: { bold, color: { argb: fgArgb } } }, { text: subText, font: { italic: true, color: { argb: fgArgb }, size: sizePt - 1 } }] } : text;
  solidFill(cell, bgArgb);
  setFont(cell, { size: sizePt, bold, color: { argb: fgArgb } });
  setAlign(cell, "left", "middle");
  r.height = height;
  return r;
}

// ── Build the Risk Register sheet ─────────────────────────────────────────────
// params.rows — register items to render; defaults to the static template
// (REGISTER). Live exports pass rows built from EwraRiskScenario data.
async function buildRegisterSheet(wb, params) {
  const { entity, period, version, status, etype, abn, rows } = params;

  const ws = wb.addWorksheet("ML-TF-PF Risk Register", {
    pageSetup: {
      paperSize:    9,          // A4
      orientation:  "landscape",
      fitToPage:    true,
      fitToWidth:   1,
      fitToHeight:  0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    headerFooter: {
      oddFooter: `&L&8dooit.ai EWRA Module – CONFIDENTIAL&C&8${entity} | ML/TF/PF Risk Register&R&8Page &P of &N`,
    },
    views: [{ state: "frozen", xSplit: 0, ySplit: 7 }],
  });

  // Column widths
  ws.columns = COLS.map(c => ({ key: c.key, width: c.width }));

  // ── Row 1: Main title ──────────────────────────────────────────────────────
  fullWidthRow(
    ws,
    `${entity}  ·  ML / TF / PF Risk Register  ·  dooit.ai  ·  EWRA Module  ·  ${period}`,
    PAL.TITLE.bg, PAL.TITLE.fg, 13, true, 30,
  );

  // ── Row 2: Entity metadata ─────────────────────────────────────────────────
  {
    const abn_str = abn ? `   |   ABN: ${abn}` : "";
    fullWidthRow(
      ws,
      `Entity: ${entity}${abn_str}   |   Entity Type: ${etype}   |   AML/CTF Obligations: AUSTRAC Tranche 2 (AML/CTF Act 2006 (Cth))`,
      PAL.META.bg, PAL.META.fg, 9, false, 18,
    );
  }

  // ── Row 3: Report metadata ─────────────────────────────────────────────────
  fullWidthRow(
    ws,
    `Report Period: ${period}   |   Version: ${version}   |   Status: ${status}   |   Risk Matrix: 5×5 Likelihood × Consequence   |   Control Effectiveness: 1 (None) – 5 (Highly Effective)`,
    PAL.META.bg, PAL.META.fg, 9, false, 18,
  );

  // ── Row 4: Legal disclaimer ────────────────────────────────────────────────
  fullWidthRow(
    ws,
    "CONFIDENTIAL — NOT FOR DISTRIBUTION  |  Prepared pursuant to Part 9 of the AML/CTF Act 2006 (Cth).  This risk assessment is a privileged and confidential compliance document produced for the purpose of compliance with AUSTRAC obligations.  It must be reviewed at least every 3 years or upon a material change in business activities.",
    PAL.LEGEND.bg, "FF505050", 8, false, 18,
  );

  // ── Row 5: Risk colour scale legend ───────────────────────────────────────
  {
    const r = ws.addRow(new Array(N_COLS).fill(null));
    r.height = 18;

    const legendParts = [
      { cols: [1,4],  pal: null,  label: "RISK RATING SCALE →", bold: true, textColor: "FF1F3864", bg: PAL.LEGEND.bg },
      { cols: [5,6],  pal: PAL.VL,    label: "VERY LOW (VL)" },
      { cols: [7,8],  pal: PAL.L,     label: "LOW (L)" },
      { cols: [9,10], pal: PAL.M,     label: "MEDIUM (M)" },
      { cols: [11,12],pal: PAL.H,     label: "HIGH (H)" },
      { cols: [13,14],pal: PAL.E,     label: "EXTREME (E)" },
      { cols: [15,N_COLS], pal: null, label: "", bold: false, textColor: PAL.LEGEND.fg, bg: PAL.LEGEND.bg },
    ];

    legendParts.forEach(({ cols, pal, label, bold, textColor, bg }) => {
      const [start, end] = cols;
      if (start !== end) {
        ws.mergeCells(`${colLetter(start)}${r.number}:${colLetter(end)}${r.number}`);
      }
      const cell = r.getCell(start);
      cell.value = label;
      solidFill(cell, pal ? pal.bg : bg);
      setFont(cell, { size: 9, bold: bold !== undefined ? bold : true, color: { argb: pal ? pal.fg : textColor } });
      setAlign(cell, "center", "middle");
      if (pal) applyBorder(cell);
    });
  }

  // ── Row 6: Channel key ─────────────────────────────────────────────────────
  {
    const r = ws.addRow(new Array(N_COLS).fill(null));
    r.height = 16;

    const parts = [
      { cols: [1,4],   label: "CHANNEL KEY →",     bold: true,  bg: PAL.LEGEND.bg, fg: "FF1F3864" },
      { cols: [5,7],   label: "F  =  Face-to-Face", bold: false, bg: PAL.LEGEND.bg, fg: "FF333333" },
      { cols: [8,10],  label: "D  =  Digital / Online", bold: false, bg: PAL.LEGEND.bg, fg: "FF333333" },
      { cols: [11,14], label: "T  =  Telephone",    bold: false, bg: PAL.LEGEND.bg, fg: "FF333333" },
      { cols: [15,N_COLS], label: "",               bold: false, bg: PAL.LEGEND.bg, fg: "FF333333" },
    ];

    parts.forEach(({ cols, label, bold, bg, fg }) => {
      const [start, end] = cols;
      if (start !== end) {
        ws.mergeCells(`${colLetter(start)}${r.number}:${colLetter(end)}${r.number}`);
      }
      const cell = r.getCell(start);
      cell.value = label;
      solidFill(cell, bg);
      setFont(cell, { size: 9, bold, color: { argb: fg } });
      setAlign(cell, start <= 4 ? "right" : "center", "middle");
    });
  }

  // ── Row 7: Column headers ──────────────────────────────────────────────────
  {
    const r = ws.addRow(COL_HEADERS);
    r.height = 38;
    for (let c = 1; c <= N_COLS; c++) {
      const cell = r.getCell(c);
      solidFill(cell, PAL.COLHDR.bg);
      setFont(cell, { size: 9, bold: true, color: { argb: PAL.COLHDR.fg } });
      setAlign(cell, "center", "middle", true);
      applyBorder(cell, true);
    }
  }

  // ── Data rows ─────────────────────────────────────────────────────────────
  let dataIdx = 0;

  for (const item of (rows || REGISTER)) {
    const isSectionHeader = typeof item.ref === "string" && /^S\d+$/.test(item.ref);

    if (isSectionHeader) {
      // Section header row (full width merge, dark navy)
      const r = ws.addRow([item.risk_type]);
      ws.mergeCells(`A${r.number}:${LAST_C}${r.number}`);
      const cell = r.getCell("A");
      cell.value = item.risk_type;
      solidFill(cell, PAL.SECTION.bg);
      setFont(cell, { size: 10, bold: true, color: { argb: PAL.SECTION.fg } });
      setAlign(cell, "left", "middle");
      cell.alignment = { ...cell.alignment, indent: 1 };
      r.height = 22;
    } else {
      dataIdx++;
      const pal = dataIdx % 2 === 0 ? PAL.EVEN : PAL.ODD;

      const inherentCode = (item.inherent_risk || "").toUpperCase();
      const residualCode  = (item.residual_risk || "").toUpperCase();
      const inherentLabel = RISK_FULL[inherentCode] || item.inherent_risk || "";
      const residualLabel = RISK_FULL[residualCode] || item.residual_risk || "";

      const vals = [
        item.ref,
        item.risk_type        || "",
        item.channel          || "",
        item.risk_name        || "",
        item.description_cause_red_flags || "",
        item.pf_sanctions_note            || "",
        item.likelihood       ?? "",
        item.consequence      ?? "",
        inherentLabel,
        item.existing_controls || "",
        item.ctrl_eff         ?? "",
        residualLabel,
        item.action_required  || "",
        item.control_ids      || "",
        item.controls_owner   || "",
        item.risk_appetite    || "",
        item.prepared_by      || "",
        item.reviewed_by      || "",
      ];

      const r = ws.addRow(vals);
      r.height = 70;

      // Base style for all cells
      for (let c = 1; c <= N_COLS; c++) {
        const cell = r.getCell(c);
        solidFill(cell, pal.bg);
        setFont(cell, { size: 9, color: { argb: pal.fg } });
        setAlign(cell, "left", "top", true);
        applyBorder(cell);
      }

      // REF – centered, bold
      const refCell = r.getCell(1);
      setAlign(refCell, "center", "top");
      setFont(refCell, { size: 9, bold: true, color: { argb: pal.fg } });

      // LIKELIHOOD & CONSEQUENCE – centered
      [7, 8].forEach(c => setAlign(r.getCell(c), "center", "top"));

      // INHERENT RISK – color-coded, bold, centered
      {
        const cell = r.getCell(9);
        const col  = riskColor(inherentCode);
        solidFill(cell, col.bg);
        setFont(cell, { size: 9, bold: true, color: { argb: col.fg } });
        setAlign(cell, "center", "middle");
        applyBorder(cell, true);
      }

      // CTRL EFF – centered
      setAlign(r.getCell(11), "center", "top");

      // RESIDUAL RISK – color-coded, bold, centered
      {
        const cell = r.getCell(12);
        const col  = riskColor(residualCode);
        solidFill(cell, col.bg);
        setFont(cell, { size: 9, bold: true, color: { argb: col.fg } });
        setAlign(cell, "center", "middle");
        applyBorder(cell, true);
      }

      // ACTION NEEDED – highlight if Yes
      {
        const cell = r.getCell(13);
        const isYes = (item.action_required || "").toLowerCase() === "yes";
        if (isYes) {
          solidFill(cell, PAL.ACTION.bg);
          setFont(cell, { size: 9, bold: true, color: { argb: PAL.ACTION.fg } });
        }
        setAlign(cell, "center", "top");
      }

      // RISK APPETITE – centered
      setAlign(r.getCell(16), "center", "top");
      setAlign(r.getCell(17), "center", "top");
      setAlign(r.getCell(18), "center", "top");
    }
  }

  // ── Risk Register Summary ──────────────────────────────────────────────────
  ws.addRow([]);
  ws.addRow([]);

  // Summary title
  {
    const r = ws.addRow(["RISK REGISTER SUMMARY"]);
    ws.mergeCells(`A${r.number}:${LAST_C}${r.number}`);
    const cell = r.getCell("A");
    solidFill(cell, PAL.TITLE.bg);
    setFont(cell, { size: 11, bold: true, color: { argb: PAL.TITLE.fg } });
    setAlign(cell, "center", "middle");
    r.height = 24;
  }

  // Count risks
  const counts = { inherent: { E:0,H:0,M:0,L:0,VL:0 }, residual: { E:0,H:0,M:0,L:0,VL:0 } };
  REGISTER.forEach(item => {
    if (typeof item.ref !== "string") {
      const i = (item.inherent_risk || "").toUpperCase();
      const r = (item.residual_risk || "").toUpperCase();
      if (counts.inherent[i] !== undefined) counts.inherent[i]++;
      if (counts.residual[r] !== undefined) counts.residual[r]++;
    }
  });

  // Summary column headers
  {
    const r = ws.addRow([
      null,
      "RISK RATING", null,
      "INHERENT RISK COUNT", null,
      "RESIDUAL RISK COUNT", null,
      "CHANGE (RESIDUAL vs INHERENT)", null, null,
    ]);
    r.height = 20;
    ws.mergeCells(`B${r.number}:C${r.number}`);
    ws.mergeCells(`D${r.number}:E${r.number}`);
    ws.mergeCells(`F${r.number}:G${r.number}`);
    ws.mergeCells(`H${r.number}:J${r.number}`);
    ["B","D","F","H"].forEach(c => {
      const cell = r.getCell(c);
      solidFill(cell, PAL.COLHDR.bg);
      setFont(cell, { size: 9, bold: true, color: { argb: PAL.COLHDR.fg } });
      setAlign(cell, "center", "middle");
      applyBorder(cell);
    });
  }

  // Summary data rows
  const ORDER = ["E","H","M","L","VL"];
  ORDER.forEach((code, idx) => {
    const inh = counts.inherent[code] || 0;
    const res = counts.residual[code]  || 0;
    const delta = res - inh;
    const deltaStr = delta === 0 ? "– No change" : (delta > 0 ? `▲ +${delta} (increased)` : `▼ ${delta} (reduced)`);

    const r = ws.addRow([null, RISK_FULL[code], null, inh, null, res, null, deltaStr]);
    r.height = 20;
    ws.mergeCells(`B${r.number}:C${r.number}`);
    ws.mergeCells(`D${r.number}:E${r.number}`);
    ws.mergeCells(`F${r.number}:G${r.number}`);
    ws.mergeCells(`H${r.number}:J${r.number}`);

    const col = riskColor(code);
    const bCell = r.getCell("B");
    solidFill(bCell, col.bg);
    setFont(bCell, { size: 9, bold: true, color: { argb: col.fg } });
    setAlign(bCell, "center", "middle");
    applyBorder(bCell, true);

    [{ c:"D", v:inh }, { c:"F", v:res }].forEach(({ c, v }) => {
      const cell = r.getCell(c);
      cell.value = v;
      solidFill(cell, idx % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg);
      setFont(cell, { size: 9, color: { argb: "FF000000" } });
      setAlign(cell, "center", "middle");
      applyBorder(cell);
    });

    const deltaCell = r.getCell("H");
    deltaCell.value = deltaStr;
    solidFill(deltaCell, delta < 0 ? "FFEBF7EB" : (delta > 0 ? "FFFFF0F0" : "FFF5F5F5"));
    setFont(deltaCell, { size: 9, color: { argb: delta < 0 ? "FF00B050" : (delta > 0 ? "FFC00000" : "FF666666") } });
    setAlign(deltaCell, "center", "middle");
    applyBorder(deltaCell);
  });

  // Totals row
  {
    const totalInh = ORDER.reduce((s, k) => s + (counts.inherent[k] || 0), 0);
    const totalRes = ORDER.reduce((s, k) => s + (counts.residual[k]  || 0), 0);
    const r = ws.addRow([null, "TOTAL", null, totalInh, null, totalRes, null, ""]);
    r.height = 22;
    ws.mergeCells(`B${r.number}:C${r.number}`);
    ws.mergeCells(`D${r.number}:E${r.number}`);
    ws.mergeCells(`F${r.number}:G${r.number}`);
    ws.mergeCells(`H${r.number}:J${r.number}`);
    ["B","D","F","H"].forEach(c => {
      const cell = r.getCell(c);
      solidFill(cell, PAL.META.bg);
      setFont(cell, { size: 9, bold: true, color: { argb: PAL.META.fg } });
      setAlign(cell, "center", "middle");
      applyBorder(cell, true);
    });
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  ws.addRow([]);
  {
    const dateStr = new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric" });
    const r = ws.addRow([
      `Generated by dooit.ai EWRA Module  ·  ${dateStr}  ·  CONFIDENTIAL — NOT FOR DISTRIBUTION  ·  © dooit.ai`
    ]);
    ws.mergeCells(`A${r.number}:${LAST_C}${r.number}`);
    const cell = r.getCell("A");
    solidFill(cell, PAL.FOOTER.bg);
    setFont(cell, { size: 8, italic: true, color: { argb: PAL.FOOTER.fg } });
    setAlign(cell, "center", "middle");
    r.height = 18;
  }
}

// ── Build the Risk Matrix sheet ───────────────────────────────────────────────
async function buildMatrixSheet(wb) {
  const ws = wb.addWorksheet("5×5 Risk Matrix", {
    pageSetup: { paperSize: 9, orientation: "landscape" },
  });

  const MATRIX_RATING_COLOR = {
    "E": PAL.E, "H": PAL.H, "M": PAL.M, "L": PAL.L, "VL": PAL.VL,
  };

  // Map 5×5 grid to full rating text
  const FULL = { E: "EXTREME", H: "HIGH", M: "MEDIUM", L: "LOW", VL: "VERY LOW" };

  // Title
  {
    ws.columns = [
      { width: 22 },
      { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 },
    ];
    const r = ws.addRow(["5×5 RISK MATRIX  —  ML / TF / PF RISK ASSESSMENT"]);
    ws.mergeCells(`A${r.number}:F${r.number}`);
    const cell = r.getCell("A");
    solidFill(cell, PAL.TITLE.bg);
    setFont(cell, { size: 13, bold: true, color: { argb: PAL.TITLE.fg } });
    setAlign(cell, "center", "middle");
    r.height = 28;
  }

  // Subtitle
  {
    const r = ws.addRow(["Likelihood (rows) × Consequence (columns) — Used to determine Inherent and Residual Risk ratings"]);
    ws.mergeCells(`A${r.number}:F${r.number}`);
    const cell = r.getCell("A");
    solidFill(cell, PAL.META.bg);
    setFont(cell, { size: 9, color: { argb: PAL.META.fg } });
    setAlign(cell, "center", "middle");
    r.height = 18;
  }

  ws.addRow([]);

  // Column header row: blank | C1 | C2 | C3 | C4 | C5
  {
    const r = ws.addRow(["LIKELIHOOD \\ CONSEQUENCE", ...CONSEQUENCE_LABELS]);
    r.height = 28;
    for (let c = 1; c <= 6; c++) {
      const cell = r.getCell(c);
      solidFill(cell, PAL.COLHDR.bg);
      setFont(cell, { size: 10, bold: true, color: { argb: PAL.COLHDR.fg } });
      setAlign(cell, "center", "middle", true);
      applyBorder(cell, true);
    }
  }

  // Matrix grid: 5 rows (likelihood 5→1)
  MATRIX_GRID.forEach((row, rowIdx) => {
    const likelLabel = LIKELIHOOD_LABELS[rowIdx];
    const rowVals = [likelLabel, ...row.map(code => FULL[code])];
    const r = ws.addRow(rowVals);
    r.height = 40;

    // Likelihood label cell
    const labelCell = r.getCell(1);
    solidFill(labelCell, PAL.META.bg);
    setFont(labelCell, { size: 10, bold: true, color: { argb: PAL.META.fg } });
    setAlign(labelCell, "center", "middle");
    applyBorder(labelCell, true);

    // Risk cells
    row.forEach((code, colIdx) => {
      const cell = r.getCell(colIdx + 2);
      const col  = MATRIX_RATING_COLOR[code] || { bg: "FFFFFFFF", fg: "FF000000" };
      solidFill(cell, col.bg);
      setFont(cell, { size: 11, bold: true, color: { argb: col.fg } });
      setAlign(cell, "center", "middle");
      applyBorder(cell, true);
    });
  });

  // Spacer
  ws.addRow([]);
  ws.addRow([]);

  // Legend section
  {
    const r = ws.addRow(["RISK RATING LEGEND"]);
    ws.mergeCells(`A${r.number}:F${r.number}`);
    const cell = r.getCell("A");
    solidFill(cell, PAL.TITLE.bg);
    setFont(cell, { size: 11, bold: true, color: { argb: PAL.TITLE.fg } });
    setAlign(cell, "center", "middle");
    r.height = 22;
  }

  const legendData = [
    { code: "E",  label: "Extreme",  description: "Immediate escalation to Governing Body + external regulators required. Service cannot be provided without ECDD, senior management approval and Governing Body notification. SMR assessment mandatory." },
    { code: "H",  label: "High",     description: "ECDD mandatory. CO + Senior Management notified. Heightened ongoing monitoring. SOF/SOW obtained. CRA set to HIGH. SMR assessment required if suspicion cannot be resolved." },
    { code: "M",  label: "Medium",   description: "Standard CDD enhanced with additional information requirements. CO awareness required. Monitoring applied. CRA reviewed and updated periodically." },
    { code: "L",  label: "Low",      description: "Standard CDD procedures apply. Routine monitoring. No escalation required unless new risk information emerges. Annual review sufficient." },
    { code: "VL", label: "Very Low", description: "Simplified / streamlined CDD may apply. Routine monitoring only. Lowest risk tolerance. No immediate action required. Annual review." },
  ];

  legendData.forEach((item, idx) => {
    const r = ws.addRow([null, item.label, null, item.description]);
    r.height = 42;
    ws.mergeCells(`A${r.number}:B${r.number}`);
    ws.mergeCells(`C${r.number}:F${r.number}`);

    const labelCell = r.getCell("A");
    const col = MATRIX_RATING_COLOR[item.code] || { bg: "FFFFFFFF", fg: "FF000000" };
    solidFill(labelCell, col.bg);
    setFont(labelCell, { size: 11, bold: true, color: { argb: col.fg } });
    setAlign(labelCell, "center", "middle");
    applyBorder(labelCell, true);

    const descCell = r.getCell("C");
    solidFill(descCell, idx % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg);
    setFont(descCell, { size: 9, color: { argb: "FF1A1A1A" } });
    setAlign(descCell, "left", "middle", true);
    descCell.alignment = { ...descCell.alignment, indent: 1 };
    applyBorder(descCell);
  });

  // Likelihood & Consequence scale tables
  ws.addRow([]);

  {
    const r = ws.addRow(["LIKELIHOOD SCALE"]);
    ws.mergeCells(`A${r.number}:F${r.number}`);
    solidFill(r.getCell("A"), PAL.COLHDR.bg);
    setFont(r.getCell("A"), { size: 10, bold: true, color: { argb: PAL.COLHDR.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 20;
  }

  // Likelihood header
  {
    const r = ws.addRow(["Level", "Descriptor", "Description"]);
    ws.mergeCells(`C${r.number}:F${r.number}`);
    r.height = 18;
    [1,2,3].forEach(c => {
      const cell = r.getCell(c === 3 ? "C" : c);
      solidFill(cell, PAL.META.bg);
      setFont(cell, { size: 9, bold: true, color: { argb: PAL.META.fg } });
      setAlign(cell, "center", "middle");
      applyBorder(cell);
    });
  }

  (MATRIX_FW.likelihood_scale || []).forEach((item, idx) => {
    const r = ws.addRow([item.level, item.descriptor, item.description || item.examples_for_legal_profession || ""]);
    ws.mergeCells(`C${r.number}:F${r.number}`);
    r.height = 30;
    const bg = idx % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg;
    [1, 2, "C"].forEach(c => {
      const cell = r.getCell(c);
      solidFill(cell, bg);
      setFont(cell, { size: 9, color: { argb: "FF1A1A1A" } });
      setAlign(cell, typeof c === "number" ? "center" : "left", "middle", typeof c !== "number");
      applyBorder(cell);
    });
  });

  ws.addRow([]);

  // Consequence scale
  {
    const r = ws.addRow(["CONSEQUENCE SCALE"]);
    ws.mergeCells(`A${r.number}:F${r.number}`);
    solidFill(r.getCell("A"), PAL.COLHDR.bg);
    setFont(r.getCell("A"), { size: 10, bold: true, color: { argb: PAL.COLHDR.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 20;
  }

  {
    const r = ws.addRow(["Level", "Consequence", "Description"]);
    ws.mergeCells(`C${r.number}:F${r.number}`);
    r.height = 18;
    [1, 2, "C"].forEach(c => {
      const cell = r.getCell(c);
      solidFill(cell, PAL.META.bg);
      setFont(cell, { size: 9, bold: true, color: { argb: PAL.META.fg } });
      setAlign(cell, "center", "middle");
      applyBorder(cell);
    });
  }

  (MATRIX_FW.consequence_scale || []).forEach((item, idx) => {
    const desc = item.example_description || item.description || "";
    const r = ws.addRow([item.level, item.consequence, desc]);
    ws.mergeCells(`C${r.number}:F${r.number}`);
    r.height = 30;
    const bg = idx % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg;
    [1, 2, "C"].forEach(c => {
      const cell = r.getCell(c);
      solidFill(cell, bg);
      setFont(cell, { size: 9, color: { argb: "FF1A1A1A" } });
      setAlign(cell, typeof c === "number" ? "center" : "left", "middle", typeof c !== "number");
      applyBorder(cell);
    });
  });
}

// ── Main export handler ───────────────────────────────────────────────────────
exports.exportRiskRegisterExcel = asyncHandler(async (req, res) => {
  const entity  = (req.query.entity_name  || "Your Organisation").substring(0, 80);
  const period  = (req.query.period       || "June 2026").substring(0, 30);
  const version = (req.query.version      || "1.0").substring(0, 10);
  const status  = (req.query.status       || "Draft").substring(0, 20);
  const etype   = (req.query.entity_type  || "Reporting Entity").substring(0, 60);
  const abn     = (req.query.abn          || "").substring(0, 20);

  const wb = new ExcelJS.Workbook();
  wb.creator           = "dooit.ai";
  wb.lastModifiedBy    = "dooit.ai EWRA Module";
  wb.created           = new Date();
  wb.modified          = new Date();
  wb.properties.date1904 = false;

  await buildRegisterSheet(wb, { entity, period, version, status, etype, abn });
  await buildMatrixSheet(wb);

  const safeName   = entity.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").substring(0, 40);
  const safePeriod = period.replace(/\s+/g, "-");
  const filename   = `RA-Risk-Register-${safeName}-${safePeriod}.xlsx`;

  res.setHeader("Content-Type",        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control",       "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma",              "no-cache");

  await wb.xlsx.write(res);
  res.end();
});

// ── Live Risk Register export for a specific assessment ──────────────────────

/**
 * Convert an assessment's EwraRiskScenario docs into register rows for
 * buildRegisterSheet (section header + scenario rows per section).
 * Returns null when the assessment has no scenarios (template fallback).
 */
function buildScenarioRegisterRows(assessment, scenarios) {
  if (!scenarios?.length) return null;
  const { SECTION_LABELS } = require("../utils/ewraRiskRegister");

  // dynamic taxonomy: labels + ordering come from the assessment's section
  // definitions (custom sections like "S10" would sort wrong lexicographically)
  const sectionDefs = assessment.registerSections || [];
  const labelFor = (code) =>
    sectionDefs.find((d) => d.code === code)?.label || SECTION_LABELS[code] || code;
  const orderFor = (code) => {
    const d = sectionDefs.find((x) => x.code === code);
    return d ? d.sortOrder : Number(String(code).replace(/^S/i, "")) || 99;
  };
  const ordered = [...scenarios].sort(
    (a, b) => orderFor(a.riskSection || "S1") - orderFor(b.riskSection || "S1") || (a.ref || 0) - (b.ref || 0),
  );

  const preparedBy = assessment.submittedBy?.name || "CO";
  const reviewedBy = assessment.approvedBy?.name || "CO";
  const rows = [];
  let currentSection = null;
  for (const s of ordered) {
    const section = s.riskSection || "S1";
    if (section !== currentSection) {
      currentSection = section;
      rows.push({ ref: section, risk_type: labelFor(section) });
    }
    rows.push({
      ref: s.ref,
      risk_type: s.riskType || "",
      channel: (s.applicableChannels || []).join(","),
      risk_name: s.riskName || "",
      description_cause_red_flags: s.description || "",
      pf_sanctions_note: s.pfSanctionsNote || "",
      likelihood: s.likelihood ?? "",
      consequence: s.consequence ?? "",
      inherent_risk: s.inherentRisk || "",
      existing_controls: s.existingControls || "",
      ctrl_eff: s.controlEffectiveness ?? "",
      residual_risk: s.residualRisk || "",
      action_required: s.actionRequired ? "Yes" : "No",
      control_ids: (s.controlIds || []).join(", "),
      controls_owner: s.controlsOwner || "",
      risk_appetite: s.withinRiskAppetite ? "Y" : "N",
      prepared_by: preparedBy,
      reviewed_by: reviewedBy,
    });
  }
  return rows;
}

// GET /api/v1/ewra/:id/risk-register/export — renders the assessment's own
// EwraRiskScenario rows (CO-adjusted); falls back to the static template when
// the assessment has no scenarios (created before the scenario layer existed).
exports.exportAssessmentRiskRegisterExcel = asyncHandler(async (req, res, next) => {
  const EwraAssessment = require("../models/EwraAssessment");
  const EwraRiskScenario = require("../models/EwraRiskScenario");

  const assessment = await EwraAssessment.findById(req.params.id)
    .populate("entityProfile", "entityName entityType abn")
    .populate("submittedBy", "name")
    .populate("approvedBy", "name")
    .lean();
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  const scenarios = await EwraRiskScenario.find({ assessmentId: assessment._id })
    .sort({ riskSection: 1, ref: 1 })
    .lean();

  const rows = buildScenarioRegisterRows(assessment, scenarios);

  const entity  = assessment.entityProfile?.entityName || "Your Organisation";
  const period  = assessment.periodStart
    ? `${new Date(assessment.periodStart).toLocaleDateString("en-AU", { month: "long", year: "numeric" })}`
    : new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" });

  const wb = new ExcelJS.Workbook();
  wb.creator = "dooit.ai";
  wb.lastModifiedBy = "dooit.ai EWRA Module";
  wb.created = new Date();
  wb.modified = new Date();

  await buildRegisterSheet(wb, {
    entity,
    period,
    version: assessment.version || "1.0",
    status: assessment.status || "Draft",
    etype: "Reporting Entity",
    abn: assessment.entityProfile?.abn || "",
    rows, // null → template fallback
  });
  await buildMatrixSheet(wb);

  const safeName = entity.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").substring(0, 40);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Risk-Register-${safeName}-${assessment.version || "1.0"}.xlsx"`);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  await wb.xlsx.write(res);
  res.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTUAL ASSESSMENT EXPORT — uses real MongoDB data from EwraRiskFactor /
// EwraControlAssessment / EwraAssessment for a specific assessment ID
// ═══════════════════════════════════════════════════════════════════════════════

const CATEGORY_PAL = {
  Customer:      { bg: "FF2E75B6", fg: "FFFFFFFF" },
  Product:       { bg: "FF7030A0", fg: "FFFFFFFF" },
  Channel:       { bg: "FF1F7A8C", fg: "FFFFFFFF" },
  Geographic:    { bg: "FFC55A11", fg: "FFFFFFFF" },
  Environmental: { bg: "FF375623", fg: "FFFFFFFF" },
};

// Full rating label → short code
function ratingToCode(label) {
  const MAP = { "Very Low":"VL", "Low":"L", "Medium":"M", "High":"H", "Extreme":"E" };
  return MAP[label] || "";
}

// Delta → display string + color
function deltaDisplay(delta) {
  switch (delta) {
    case "up":   return { text: "▲ Increased", argb: "FFC00000" };
    case "down": return { text: "▼ Decreased", argb: "FF00B050" };
    case "same": return { text: "— No change", argb: "FF808080" };
    case "new":  return { text: "★ New",        argb: "FF2E75B6" };
    default:     return { text: "",             argb: "FF000000" };
  }
}

// ── Sheet 1: Risk Factor Assessment ──────────────────────────────────────────
async function buildRiskFactorSheet(wb, assessment, factors) {
  const CATEGORIES = ["Customer","Product","Channel","Geographic","Environmental"];
  const N = 14;  // columns A–N
  const LAST = colLetter(N);

  const ws = wb.addWorksheet("Risk Factor Assessment", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
    views: [{ state: "frozen", xSplit: 0, ySplit: 6 }],
  });

  ws.columns = [
    { width: 5  }, // A: #
    { width: 35 }, // B: Factor Name
    { width: 14 }, // C: Category
    { width: 38 }, // D: Description
    { width: 8  }, // E: Weight %
    { width: 11 }, // F: Likelihood
    { width: 12 }, // G: Consequence
    { width: 15 }, // H: Inherent Risk
    { width: 11 }, // I: Ctrl Eff
    { width: 15 }, // J: Residual Risk
    { width: 11 }, // K: Δ Change
    { width: 14 }, // L: Status
    { width: 48 }, // M: Rationale
    { width: 16 }, // N: Assigned To
  ];

  const entity  = assessment.entityProfile?.entityName || "Organisation";
  const etype   = assessment.entityProfile?.entityType?.name || "";
  const period  = assessment.periodEnd
    ? new Date(assessment.periodEnd).toLocaleDateString("en-AU", { month: "long", year: "numeric" })
    : "—";

  // ── Title block (rows 1-5) ─────────────────────────────────────────────────
  {
    const r = ws.addRow([`${entity}  ·  EWRA Risk Factor Assessment  ·  dooit.ai  ·  ${period}`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.TITLE.bg);
    setFont(r.getCell("A"), { size: 13, bold: true, color: { argb: PAL.TITLE.fg } });
    setAlign(r.getCell("A"), "left", "middle");
    r.height = 30;
  }
  {
    const abn = assessment.entityProfile?.abn ? `   |   ABN: ${assessment.entityProfile.abn}` : "";
    const r = ws.addRow([`Entity: ${entity}${abn}   |   Type: ${etype}   |   Risk Types: ${(assessment.riskTypes||[]).join(", ") || "AML, CTF, SANCTIONS"}`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.META.bg);
    setFont(r.getCell("A"), { size: 9, color: { argb: PAL.META.fg } });
    r.height = 18;
  }
  {
    const r = ws.addRow([`Assessment: ${assessment.assessmentName}   |   Version: ${assessment.version || "1.0"}   |   Status: ${assessment.status}   |   Period: ${period}   |   Amendment: ${(assessment.amendmentType||"initial").replace("_"," ")}`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.META.bg);
    setFont(r.getCell("A"), { size: 9, color: { argb: PAL.META.fg } });
    r.height = 18;
  }
  // Risk scale legend
  {
    const r = ws.addRow(new Array(N).fill(null));
    r.height = 18;
    const parts = [
      { s:1,  e:3,  pal: null,  label: "RISK SCALE →",  bold: true,  bg: PAL.LEGEND.bg, fg: "FF1F3864" },
      { s:4,  e:5,  pal: PAL.VL, label: "VERY LOW" },
      { s:6,  e:7,  pal: PAL.L,  label: "LOW" },
      { s:8,  e:9,  pal: PAL.M,  label: "MEDIUM" },
      { s:10, e:11, pal: PAL.H,  label: "HIGH" },
      { s:12, e:13, pal: PAL.E,  label: "EXTREME" },
      { s:14, e:14, pal: null,   label: "", bg: PAL.LEGEND.bg, fg: "FF1F3864" },
    ];
    parts.forEach(({ s, e, pal, label, bold, bg, fg }) => {
      if (s !== e) ws.mergeCells(`${colLetter(s)}${r.number}:${colLetter(e)}${r.number}`);
      const cell = r.getCell(s);
      cell.value = label;
      solidFill(cell, pal ? pal.bg : (bg || PAL.LEGEND.bg));
      setFont(cell, { size: 9, bold: bold || (pal != null), color: { argb: pal ? pal.fg : (fg || "FF000000") } });
      setAlign(cell, "center", "middle");
      if (pal) applyBorder(cell);
    });
  }

  // ── Column headers (row 6) ─────────────────────────────────────────────────
  const HDR = ["#","FACTOR NAME","CATEGORY","DESCRIPTION","WT\n%","L'HOOD\n(1–5)","CONSEQ.\n(1–5)","INHERENT\nRISK","CTRL\nEFF","RESIDUAL\nRISK","Δ\nCHANGE","STATUS","RATIONALE / EVIDENCE NOTES","ASSIGNED TO"];
  {
    const r = ws.addRow(HDR);
    r.height = 36;
    for (let c = 1; c <= N; c++) {
      const cell = r.getCell(c);
      solidFill(cell, PAL.COLHDR.bg);
      setFont(cell, { size: 9, bold: true, color: { argb: PAL.COLHDR.fg } });
      setAlign(cell, "center", "middle", true);
      applyBorder(cell, true);
    }
  }

  // ── Risk factor data rows ──────────────────────────────────────────────────
  const grouped = {};
  CATEGORIES.forEach(c => { grouped[c] = []; });
  factors.forEach(f => { if (grouped[f.category]) grouped[f.category].push(f); });

  let globalRow = 0;
  const catCounts = { inherent: {}, residual: {} };

  CATEGORIES.forEach(cat => {
    const catFacs = grouped[cat];
    const catPal  = CATEGORY_PAL[cat] || PAL.SECTION;

    // Category section header
    {
      const r = ws.addRow([`  ${cat.toUpperCase()} RISK FACTORS  (${catFacs.length} factor${catFacs.length !== 1 ? "s" : ""})`]);
      ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
      solidFill(r.getCell("A"), catPal.bg);
      setFont(r.getCell("A"), { size: 10, bold: true, color: { argb: catPal.fg } });
      setAlign(r.getCell("A"), "left", "middle");
      r.height = 22;
    }

    if (catFacs.length === 0) {
      const r = ws.addRow([null, "No factors assessed in this category"]);
      ws.mergeCells(`B${r.number}:${LAST}${r.number}`);
      solidFill(r.getCell(1), PAL.EVEN.bg);
      solidFill(r.getCell(2), PAL.EVEN.bg);
      setFont(r.getCell(2), { size: 9, italic: true, color: { argb: "FF909090" } });
      r.height = 20;
      return;
    }

    catFacs.forEach((f, idx) => {
      globalRow++;
      const bg = globalRow % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg;

      const inhCode = ratingToCode(f.inherentRating);
      const resCode = ratingToCode(f.residualRating);
      const dd      = deltaDisplay(f.delta);

      // Track counts for summary
      if (inhCode) catCounts.inherent[inhCode] = (catCounts.inherent[inhCode] || 0) + 1;
      if (resCode) catCounts.residual[resCode] = (catCounts.residual[resCode] || 0) + 1;

      const vals = [
        idx + 1,
        f.factorName       || "",
        f.category         || "",
        f.description      || "",
        f.weight != null   ? `${f.weight}%` : "",
        f.likelihood       ?? "",
        f.impact           ?? "",
        f.inherentRating   || "",
        f.controlEffectiveness ?? "",
        f.residualRating   || "",
        dd.text,
        f.status           || "",
        f.rationale        || "",
        f.assignedTo       || "",
      ];

      const r = ws.addRow(vals);
      r.height = 55;

      for (let c = 1; c <= N; c++) {
        const cell = r.getCell(c);
        solidFill(cell, bg);
        setFont(cell, { size: 9, color: { argb: "FF1A1A1A" } });
        setAlign(cell, c <= 2 || c >= 12 ? "left" : "center", "top", true);
        applyBorder(cell);
      }

      // # col – bold centered
      setFont(r.getCell(1), { size: 9, bold: true, color: { argb: "FF1A1A1A" } });
      setAlign(r.getCell(1), "center", "top");

      // Factor name – bold left
      setFont(r.getCell(2), { size: 9, bold: true, color: { argb: "FF1A1A1A" } });

      // Description & rationale – left wrap
      [4, 13].forEach(c => setAlign(r.getCell(c), "left", "top", true));

      // Inherent Risk (col 8) – color-coded
      {
        const cell = r.getCell(8);
        const col  = riskColor(inhCode);
        solidFill(cell, col.bg);
        setFont(cell, { size: 9, bold: true, color: { argb: col.fg } });
        setAlign(cell, "center", "middle");
        applyBorder(cell, true);
      }

      // Residual Risk (col 10) – color-coded
      {
        const cell = r.getCell(10);
        const col  = riskColor(resCode);
        solidFill(cell, col.bg);
        setFont(cell, { size: 9, bold: true, color: { argb: col.fg } });
        setAlign(cell, "center", "middle");
        applyBorder(cell, true);
      }

      // Δ Change (col 11) – colored text
      if (dd.text) {
        setFont(r.getCell(11), { size: 9, bold: true, color: { argb: dd.argb } });
      }

      // Status (col 12) – color chip
      {
        const cell  = r.getCell(12);
        const stMap = {
          "Complete":     { bg: "FF00B050", fg: "FFFFFFFF" },
          "In Progress":  { bg: "FFFFCC00", fg: "FF1A1A1A" },
          "Not Started":  { bg: "FFF2F2F2", fg: "FF808080" },
        };
        const sc = stMap[f.status] || { bg: bg, fg: "FF1A1A1A" };
        solidFill(cell, sc.bg);
        setFont(cell, { size: 9, bold: false, color: { argb: sc.fg } });
        setAlign(cell, "center", "middle");
      }
    });
  });

  // ── Summary table ──────────────────────────────────────────────────────────
  ws.addRow([]);
  ws.addRow([]);

  {
    const r = ws.addRow(["ASSESSMENT SUMMARY"]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.TITLE.bg);
    setFont(r.getCell("A"), { size: 11, bold: true, color: { argb: PAL.TITLE.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 24;
  }

  // Category score breakdown
  const catScores = assessment.categoryScores || [];
  if (catScores.length) {
    {
      const r = ws.addRow([null,"CATEGORY",null,"WEIGHT","INHERENT\nSCORE","INHERENT\nRATING","CTRL\nSCORE","RESIDUAL\nSCORE","RESIDUAL\nRATING","Δ CHANGE"]);
      r.height = 32;
      [[2,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10]].forEach(([s,e]) => {
        if (s !== e) ws.mergeCells(`${colLetter(s)}${r.number}:${colLetter(e)}${r.number}`);
        const cell = r.getCell(s);
        solidFill(cell, PAL.COLHDR.bg);
        setFont(cell, { size: 9, bold: true, color: { argb: PAL.COLHDR.fg } });
        setAlign(cell, "center", "middle", true);
        applyBorder(cell);
      });
    }
    catScores.forEach((cat, idx) => {
      const catPal   = CATEGORY_PAL[cat.category] || PAL.SECTION;
      const inhCode  = ratingToCode(cat.rating);
      const resCode  = ratingToCode(cat.rating);   // residualRating not on categoryScores directly
      const dd       = deltaDisplay(cat.delta);
      const r        = ws.addRow([null, cat.category, null, `${cat.weight}%`,
        cat.inherentScore?.toFixed(2) ?? "—",
        cat.rating || "—",
        cat.controlScore?.toFixed(2)  ?? "—",
        cat.residualScore?.toFixed(2) ?? "—",
        cat.rating || "—",
        dd.text,
      ]);
      r.height = 22;
      ws.mergeCells(`B${r.number}:C${r.number}`);
      const labelCell = r.getCell("B");
      solidFill(labelCell, catPal.bg);
      setFont(labelCell, { size: 9, bold: true, color: { argb: catPal.fg } });
      setAlign(labelCell, "center", "middle");
      applyBorder(labelCell, true);

      [4,5,6,7,8,9,10].forEach(c => {
        const cell = r.getCell(c);
        const bg   = idx % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg;
        solidFill(cell, (c === 6 || c === 9) ? riskColor(ratingToCode(cat.rating)).bg : bg);
        const isRisk = c === 6 || c === 9;
        setFont(cell, { size: 9, bold: isRisk, color: { argb: isRisk ? riskColor(ratingToCode(cat.rating)).fg : "FF1A1A1A" } });
        setAlign(cell, "center", "middle");
        applyBorder(cell);
      });
    });
  }

  // Overall scores row
  {
    const r = ws.addRow([
      null, "OVERALL", null,
      "100%",
      assessment.inherentRiskScore?.toFixed(2)  ?? "—",
      assessment.inherentRiskRating             || "—",
      assessment.controlEffectivenessScore?.toFixed(2) ?? "—",
      assessment.residualRiskScore?.toFixed(2)  ?? "—",
      assessment.residualRiskRating             || "—",
      "",
    ]);
    r.height = 24;
    ws.mergeCells(`B${r.number}:C${r.number}`);
    solidFill(r.getCell("B"), PAL.TITLE.bg);
    setFont(r.getCell("B"), { size: 10, bold: true, color: { argb: PAL.TITLE.fg } });
    setAlign(r.getCell("B"), "center", "middle");
    applyBorder(r.getCell("B"), true);

    [4,5,6,7,8,9].forEach(c => {
      const cell = r.getCell(c);
      const isRisk = c === 6 || c === 9;
      const code   = c === 6 ? ratingToCode(assessment.inherentRiskRating) : ratingToCode(assessment.residualRiskRating);
      solidFill(cell, isRisk ? riskColor(code).bg : PAL.META.bg);
      setFont(cell, { size: 9, bold: true, color: { argb: isRisk ? riskColor(code).fg : PAL.META.fg } });
      setAlign(cell, "center", "middle");
      applyBorder(cell, true);
    });
  }

  // Footer
  ws.addRow([]);
  {
    const dateStr = new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric" });
    const r = ws.addRow([`Generated by dooit.ai EWRA Module  ·  ${dateStr}  ·  CONFIDENTIAL — NOT FOR DISTRIBUTION`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.FOOTER.bg);
    setFont(r.getCell("A"), { size: 8, italic: true, color: { argb: PAL.FOOTER.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 18;
  }
}

// ── Sheet 2: Controls Assessment ─────────────────────────────────────────────
async function buildControlsSheet(wb, assessment, controls) {
  const N = 12;
  const LAST = colLetter(N);

  const ws = wb.addWorksheet("Controls Assessment", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
    views: [{ state: "frozen", xSplit: 0, ySplit: 5 }],
  });

  ws.columns = [
    { width: 16 }, // A: Control ID
    { width: 10 }, // B: Domain
    { width: 36 }, // C: Control Title
    { width: 14 }, // D: Owner
    { width: 15 }, // E: Design Rating
    { width: 15 }, // F: Perf. Rating
    { width: 17 }, // G: Eff. Score
    { width: 20 }, // H: Eff. Label
    { width: 38 }, // I: Evidence Notes
    { width: 28 }, // J: Gaps
    { width: 28 }, // K: Action Required
    { width: 14 }, // L: Status
  ];

  const entity = assessment.entityProfile?.entityName || "Organisation";
  const period = assessment.periodEnd
    ? new Date(assessment.periodEnd).toLocaleDateString("en-AU", { month: "long", year: "numeric" })
    : "—";

  // Title block
  {
    const r = ws.addRow([`${entity}  ·  Controls Assessment  ·  dooit.ai  ·  ${period}`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.TITLE.bg);
    setFont(r.getCell("A"), { size: 13, bold: true, color: { argb: PAL.TITLE.fg } });
    setAlign(r.getCell("A"), "left", "middle");
    r.height = 30;
  }
  {
    const r = ws.addRow([`Assessment: ${assessment.assessmentName}   |   Version: ${assessment.version || "1.0"}   |   Status: ${assessment.status}   |   ${controls.length} controls assessed`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.META.bg);
    setFont(r.getCell("A"), { size: 9, color: { argb: PAL.META.fg } });
    r.height = 18;
  }
  {
    const r = ws.addRow(["Control Effectiveness Rating Scale:  1 = Very Poor  |  2 = Poor  |  3 = Adequate  |  4 = Good  |  5 = Very Good   |   Effectiveness = (Design + Performance) ÷ 2"]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.LEGEND.bg);
    setFont(r.getCell("A"), { size: 9, color: { argb: "FF505050" } });
    r.height = 18;
  }

  // Effectiveness label legend row
  {
    const r = ws.addRow(new Array(N).fill(null));
    r.height = 18;
    const parts = [
      { s:1, e:2,  bg: PAL.LEGEND.bg, fg: "FF1F3864",  label: "EFF. LEVEL →", bold: true },
      { s:3, e:4,  bg: "FFFFE0E0",     fg: "FFC00000",  label: "Ineffective (1–2)",      bold: false },
      { s:5, e:6,  bg: "FFFFF4CC",     fg: "FF806000",  label: "Partially Effective (3)", bold: false },
      { s:7, e:8,  bg: "FFD6E8FF",     fg: "FF1F3864",  label: "Effective (4)",           bold: false },
      { s:9, e:12, bg: "FFE2EFDA",     fg: "FF375623",  label: "Highly Effective (5)",    bold: false },
    ];
    parts.forEach(({ s, e, bg, fg, label, bold }) => {
      if (s !== e) ws.mergeCells(`${colLetter(s)}${r.number}:${colLetter(e)}${r.number}`);
      const cell = r.getCell(s);
      cell.value = label;
      solidFill(cell, bg);
      setFont(cell, { size: 9, bold, color: { argb: fg } });
      setAlign(cell, "center", "middle");
      if (s > 2) applyBorder(cell);
    });
  }

  // Column headers
  const HDR = ["CONTROL ID","DOMAIN","CONTROL TITLE","OWNER","DESIGN\nRATING (1–5)","PERF.\nRATING (1–5)","EFFECTIVENESS\nSCORE","EFFECTIVENESS\nLABEL","EVIDENCE NOTES","GAPS","ACTION REQUIRED","STATUS"];
  {
    const r = ws.addRow(HDR);
    r.height = 36;
    for (let c = 1; c <= N; c++) {
      const cell = r.getCell(c);
      solidFill(cell, PAL.COLHDR.bg);
      setFont(cell, { size: 9, bold: true, color: { argb: PAL.COLHDR.fg } });
      setAlign(cell, "center", "middle", true);
      applyBorder(cell, true);
    }
  }

  // Group controls by domain
  const domains = [...new Set(controls.map(c => c.domain).filter(Boolean))].sort();
  if (domains.length === 0 && controls.length > 0) domains.push("—");

  let globalRow = 0;

  const groupedControls = {};
  controls.forEach(c => {
    const d = c.domain || "—";
    if (!groupedControls[d]) groupedControls[d] = [];
    groupedControls[d].push(c);
  });

  domains.forEach(domain => {
    const domControls = groupedControls[domain] || [];

    // Domain header
    {
      const r = ws.addRow([`  ${domain} DOMAIN  —  ${domControls.length} control${domControls.length !== 1 ? "s" : ""}`]);
      ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
      solidFill(r.getCell("A"), PAL.COLHDR.bg);
      setFont(r.getCell("A"), { size: 10, bold: true, color: { argb: PAL.COLHDR.fg } });
      setAlign(r.getCell("A"), "left", "middle");
      r.height = 20;
    }

    domControls.forEach(c => {
      globalRow++;
      const bg = globalRow % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg;

      const effLabelColors = {
        "Ineffective":         { bg: "FFFFE0E0", fg: "FFC00000" },
        "Partially Effective": { bg: "FFFFF4CC", fg: "FF806000" },
        "Effective":           { bg: "FFD6E8FF", fg: "FF1F3864" },
        "Highly Effective":    { bg: "FFE2EFDA", fg: "FF375623" },
      };

      const vals = [
        c.controlId     || "",
        c.domain        || "",
        c.controlTitle  || "",
        c.controlOwner  || "",
        c.designRating      ?? "",
        c.performanceRating ?? "",
        c.effectivenessScore != null ? c.effectivenessScore.toFixed(1) : "",
        c.effectivenessLabel || "",
        c.evidenceNotes || "",
        c.gaps          || "",
        c.actionRequired || "",
        c.status        || "",
      ];

      const r = ws.addRow(vals);
      r.height = 50;

      for (let col = 1; col <= N; col++) {
        const cell = r.getCell(col);
        solidFill(cell, bg);
        setFont(cell, { size: 9, color: { argb: "FF1A1A1A" } });
        setAlign(cell, col <= 4 || col >= 9 ? "left" : "center", "top", true);
        applyBorder(cell);
      }

      // Control ID – monospace bold
      setFont(r.getCell(1), { name: "Courier New", size: 8, bold: true, color: { argb: "FF1F3864" } });

      // Effectiveness label – color chip (col 8)
      {
        const cell = r.getCell(8);
        const ec   = effLabelColors[c.effectivenessLabel] || { bg, fg: "FF1A1A1A" };
        solidFill(cell, ec.bg);
        setFont(cell, { size: 9, bold: true, color: { argb: ec.fg } });
        setAlign(cell, "center", "middle");
        applyBorder(cell, true);
      }

      // Status chip (col 12)
      {
        const cell  = r.getCell(12);
        const stMap = {
          "Complete":    { bg: "FF00B050", fg: "FFFFFFFF" },
          "In Progress": { bg: "FFFFCC00", fg: "FF1A1A1A" },
          "Not Started": { bg: "FFF2F2F2", fg: "FF808080" },
        };
        const sc = stMap[c.status] || { bg, fg: "FF1A1A1A" };
        solidFill(cell, sc.bg);
        setFont(cell, { size: 9, color: { argb: sc.fg } });
        setAlign(cell, "center", "middle");
      }
    });

    // Domain subtotal row
    {
      const done  = domControls.filter(c => c.status === "Complete").length;
      const total = domControls.length;
      const avgEff = total > 0
        ? (domControls.filter(c => c.effectivenessScore != null)
            .reduce((s, c) => s + c.effectivenessScore, 0) /
           (domControls.filter(c => c.effectivenessScore != null).length || 1)
          ).toFixed(1)
        : "—";
      const r = ws.addRow([`${domain} subtotal`, null, `${done}/${total} controls rated`, null, null, null, avgEff, "avg effectiveness"]);
      ws.mergeCells(`A${r.number}:B${r.number}`);
      ws.mergeCells(`C${r.number}:F${r.number}`);
      ws.mergeCells(`H${r.number}:${LAST}${r.number}`);
      r.height = 18;
      [1,3,7,8].forEach(c => {
        const cell = r.getCell(c);
        solidFill(cell, PAL.META.bg);
        setFont(cell, { size: 9, bold: c === 1, color: { argb: PAL.META.fg } });
        setAlign(cell, c === 7 ? "center" : "left", "middle");
        applyBorder(cell);
      });
    }
  });

  // Footer
  ws.addRow([]);
  {
    const dateStr = new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric" });
    const r = ws.addRow([`Generated by dooit.ai EWRA Module  ·  ${dateStr}  ·  CONFIDENTIAL`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.FOOTER.bg);
    setFont(r.getCell("A"), { size: 8, italic: true, color: { argb: PAL.FOOTER.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 18;
  }
}

// ── Sheet 3: Assessment Overview ─────────────────────────────────────────────
async function buildOverviewSheet(wb, assessment, factors, controls) {
  const N = 6;
  const LAST = colLetter(N);

  const ws = wb.addWorksheet("Assessment Overview", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1 },
  });

  ws.columns = [
    { width: 28 }, { width: 24 },
    { width: 20 }, { width: 20 },
    { width: 20 }, { width: 20 },
  ];

  const entity = assessment.entityProfile?.entityName || "Organisation";
  const period = assessment.periodEnd
    ? new Date(assessment.periodEnd).toLocaleDateString("en-AU", { month: "long", year: "numeric" }) : "—";

  // Title
  {
    const r = ws.addRow([`${entity}  ·  EWRA Assessment Overview  ·  dooit.ai`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.TITLE.bg);
    setFont(r.getCell("A"), { size: 13, bold: true, color: { argb: PAL.TITLE.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 30;
  }

  ws.addRow([]);

  // Metadata table
  {
    const r = ws.addRow(["ASSESSMENT DETAILS"]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.COLHDR.bg);
    setFont(r.getCell("A"), { size: 10, bold: true, color: { argb: PAL.COLHDR.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 22;
  }

  const metaRows = [
    ["Assessment Name", assessment.assessmentName],
    ["Entity",          assessment.entityProfile?.entityName],
    ["Entity Type",     assessment.entityProfile?.entityType?.name?.replace(/Tranche [12] - /, "") || "—"],
    ["ABN",             assessment.entityProfile?.abn || "—"],
    ["Assessment Type", assessment.assessmentType],
    ["Period",          period],
    ["Version",         assessment.version || "1.0"],
    ["Status",          assessment.status],
    ["Risk Types",      (assessment.riskTypes || []).join(", ") || "—"],
    ["Amendment Type",  (assessment.amendmentType || "initial").replace(/_/g, " ")],
    ["Trigger Reason",  assessment.triggerReason || "—"],
    ["Approved At",     assessment.approvedAt ? new Date(assessment.approvedAt).toLocaleDateString("en-AU") : "—"],
    ["Review Due",      assessment.reviewDate  ? new Date(assessment.reviewDate).toLocaleDateString("en-AU")  : "—"],
    ["Factors Total",   `${assessment.factorsComplete || 0} / ${assessment.factorsTotal || 0} complete`],
    ["Controls Total",  `${assessment.controlsComplete || 0} / ${assessment.controlsTotal || 0} complete`],
  ];

  metaRows.forEach(([label, val], idx) => {
    const r   = ws.addRow([label, val]);
    const bg  = idx % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg;
    ws.mergeCells(`B${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell(1), PAL.META.bg);
    setFont(r.getCell(1), { size: 9, bold: true, color: { argb: PAL.META.fg } });
    setAlign(r.getCell(1), "right", "middle");
    applyBorder(r.getCell(1));
    solidFill(r.getCell(2), bg);
    setFont(r.getCell(2), { size: 9, color: { argb: "FF1A1A1A" } });
    setAlign(r.getCell(2), "left", "middle");
    applyBorder(r.getCell(2));
    r.height = 18;
  });

  ws.addRow([]);

  // ── Overall risk scores ──────────────────────────────────────────────────
  {
    const r = ws.addRow(["OVERALL RISK SCORES"]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.COLHDR.bg);
    setFont(r.getCell("A"), { size: 10, bold: true, color: { argb: PAL.COLHDR.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 22;
  }

  const scoreRows = [
    { label: "Inherent Risk Score",          score: assessment.inherentRiskScore,         rating: assessment.inherentRiskRating },
    { label: "Control Effectiveness Score",  score: assessment.controlEffectivenessScore, rating: null },
    { label: "Residual Risk Score",          score: assessment.residualRiskScore,          rating: assessment.residualRiskRating },
  ];

  scoreRows.forEach(({ label, score, rating }) => {
    const r   = ws.addRow([label, score != null ? score.toFixed(2) : "Not calculated", rating || ""]);
    const code = ratingToCode(rating);
    const col  = rating ? riskColor(code) : { bg: PAL.META.bg, fg: PAL.META.fg };
    ws.mergeCells(`C${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell(1), PAL.META.bg);
    setFont(r.getCell(1), { size: 9, bold: true, color: { argb: PAL.META.fg } });
    setAlign(r.getCell(1), "right", "middle");
    applyBorder(r.getCell(1));
    solidFill(r.getCell(2), PAL.ODD.bg);
    setFont(r.getCell(2), { size: 10, bold: true, color: { argb: "FF1A1A1A" } });
    setAlign(r.getCell(2), "center", "middle");
    applyBorder(r.getCell(2));
    solidFill(r.getCell(3), col.bg);
    setFont(r.getCell(3), { size: 10, bold: true, color: { argb: col.fg } });
    setAlign(r.getCell(3), "center", "middle");
    applyBorder(r.getCell(3), true);
    r.height = 22;
  });

  ws.addRow([]);

  // ── Category breakdown ──────────────────────────────────────────────────
  {
    const r = ws.addRow(["CATEGORY BREAKDOWN"]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.COLHDR.bg);
    setFont(r.getCell("A"), { size: 10, bold: true, color: { argb: PAL.COLHDR.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 22;
  }
  {
    const r = ws.addRow(["Category","Weight","Inherent Score","Ctrl Score","Residual Score","Rating"]);
    r.height = 20;
    for (let c = 1; c <= 6; c++) {
      solidFill(r.getCell(c), PAL.META.bg);
      setFont(r.getCell(c), { size: 9, bold: true, color: { argb: PAL.META.fg } });
      setAlign(r.getCell(c), "center", "middle");
      applyBorder(r.getCell(c));
    }
  }

  (assessment.categoryScores || []).forEach((cat, idx) => {
    const catPal  = CATEGORY_PAL[cat.category] || PAL.SECTION;
    const code    = ratingToCode(cat.rating);
    const col     = cat.rating ? riskColor(code) : { bg: PAL.ODD.bg, fg: "FF1A1A1A" };
    const r       = ws.addRow([
      cat.category, `${cat.weight}%`,
      cat.inherentScore?.toFixed(2) ?? "—",
      cat.controlScore?.toFixed(2)  ?? "—",
      cat.residualScore?.toFixed(2) ?? "—",
      cat.rating || "—",
    ]);
    r.height = 20;
    solidFill(r.getCell(1), catPal.bg);
    setFont(r.getCell(1), { size: 9, bold: true, color: { argb: catPal.fg } });
    setAlign(r.getCell(1), "center", "middle");
    applyBorder(r.getCell(1), true);
    [2,3,4,5].forEach(c => {
      solidFill(r.getCell(c), idx % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg);
      setFont(r.getCell(c), { size: 9, color: { argb: "FF1A1A1A" } });
      setAlign(r.getCell(c), "center", "middle");
      applyBorder(r.getCell(c));
    });
    solidFill(r.getCell(6), col.bg);
    setFont(r.getCell(6), { size: 9, bold: true, color: { argb: col.fg } });
    setAlign(r.getCell(6), "center", "middle");
    applyBorder(r.getCell(6), true);
  });

  ws.addRow([]);

  // ── Factor counts ─────────────────────────────────────────────────────────
  const total      = factors.length;
  const complete   = factors.filter(f => f.status === "Complete").length;
  const highEx     = factors.filter(f => ["High","Extreme"].includes(f.residualRating)).length;
  const ctrlDone   = controls.filter(c => c.status === "Complete").length;

  const statRows = [
    ["Total Risk Factors",          total],
    ["Factors Scored (Complete)",   complete],
    ["High / Extreme Residual",     highEx],
    ["Controls Assessed",           controls.length],
    ["Controls Rated (Complete)",   ctrlDone],
  ];

  {
    const r = ws.addRow(["KEY METRICS"]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.COLHDR.bg);
    setFont(r.getCell("A"), { size: 10, bold: true, color: { argb: PAL.COLHDR.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 22;
  }
  statRows.forEach(([label, val], idx) => {
    const r  = ws.addRow([label, val]);
    const bg = idx % 2 === 0 ? PAL.EVEN.bg : PAL.ODD.bg;
    ws.mergeCells(`B${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell(1), PAL.META.bg);
    setFont(r.getCell(1), { size: 9, bold: true, color: { argb: PAL.META.fg } });
    setAlign(r.getCell(1), "right", "middle");
    applyBorder(r.getCell(1));
    solidFill(r.getCell(2), bg);
    setFont(r.getCell(2), { size: 11, bold: true, color: { argb: "FF1F3864" } });
    setAlign(r.getCell(2), "center", "middle");
    applyBorder(r.getCell(2));
    r.height = 20;
  });

  // Footer
  ws.addRow([]);
  {
    const dateStr = new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric" });
    const r = ws.addRow([`Generated by dooit.ai EWRA Module  ·  ${dateStr}  ·  CONFIDENTIAL`]);
    ws.mergeCells(`A${r.number}:${LAST}${r.number}`);
    solidFill(r.getCell("A"), PAL.FOOTER.bg);
    setFont(r.getCell("A"), { size: 8, italic: true, color: { argb: PAL.FOOTER.fg } });
    setAlign(r.getCell("A"), "center", "middle");
    r.height = 18;
  }
}

// ── Assessment Excel export handler ───────────────────────────────────────────
exports.exportAssessmentExcel = asyncHandler(async (req, res, next) => {
  const { id } = req.params;

  const [assessment, factors, controls] = await Promise.all([
    EwraAssessment.findById(id)
      .populate({ path: "entityProfile", populate: { path: "entityType" } })
      .lean(),
    EwraRiskFactor.find({ assessmentId: id }).sort({ category: 1, sortOrder: 1, createdAt: 1 }).lean(),
    EwraControlAssessment.find({ assessmentId: id }).sort({ domain: 1, controlId: 1 }).lean(),
  ]);

  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  const wb = new ExcelJS.Workbook();
  wb.creator        = "dooit.ai";
  wb.lastModifiedBy = "dooit.ai EWRA Module";
  wb.created        = new Date();
  wb.modified       = new Date();

  // Sheet order: Overview → Risk Factors → Controls → Risk Matrix
  await buildOverviewSheet(wb, assessment, factors, controls);
  await buildRiskFactorSheet(wb, assessment, factors);
  await buildControlsSheet(wb, assessment, controls);
  await buildMatrixSheet(wb);

  const entity     = assessment.entityProfile?.entityName || "Assessment";
  const safeName   = entity.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").substring(0, 40);
  const safeAssess = (assessment.assessmentName || "EWRA").replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").substring(0, 30);
  const filename   = `EWRA-Report-${safeName}-${safeAssess}.xlsx`;

  res.setHeader("Content-Type",        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control",       "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma",              "no-cache");

  await wb.xlsx.write(res);
  res.end();
});

// ── Consolidated EWRA workbook (alignment-doc Phase 5) ────────────────────────
// GET /api/v1/ewra/:id/consolidated/export — one audit-ready file:
//   Overview → Risk Factors → ML/TF/PF Risk Register (live scenarios) →
//   Controls → 5×5 Risk Matrix
exports.exportConsolidatedExcel = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const EwraRiskScenario = require("../models/EwraRiskScenario");

  const [assessment, factors, controls, scenarios] = await Promise.all([
    EwraAssessment.findById(id)
      .populate({ path: "entityProfile", populate: { path: "entityType" } })
      .populate("submittedBy", "name")
      .populate("approvedBy", "name")
      .lean(),
    EwraRiskFactor.find({ assessmentId: id }).sort({ category: 1, sortOrder: 1, createdAt: 1 }).lean(),
    EwraControlAssessment.find({ assessmentId: id }).sort({ domain: 1, controlId: 1 }).lean(),
    EwraRiskScenario.find({ assessmentId: id }).sort({ riskSection: 1, ref: 1 }).lean(),
  ]);

  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  const wb = new ExcelJS.Workbook();
  wb.creator        = "dooit.ai";
  wb.lastModifiedBy = "dooit.ai EWRA Module";
  wb.created        = new Date();
  wb.modified       = new Date();

  const entity = assessment.entityProfile?.entityName || "Assessment";
  const period = assessment.periodStart
    ? new Date(assessment.periodStart).toLocaleDateString("en-AU", { month: "long", year: "numeric" })
    : new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" });

  await buildOverviewSheet(wb, assessment, factors, controls);
  await buildRiskFactorSheet(wb, assessment, factors);
  await buildRegisterSheet(wb, {
    entity,
    period,
    version: assessment.version || "1.0",
    status: assessment.status || "Draft",
    etype: assessment.entityProfile?.entityType?.name || "Reporting Entity",
    abn: assessment.entityProfile?.abn || "",
    rows: buildScenarioRegisterRows(assessment, scenarios), // null → template fallback
  });
  await buildControlsSheet(wb, assessment, controls);
  await buildMatrixSheet(wb);

  const safeName   = entity.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").substring(0, 40);
  const safeAssess = (assessment.assessmentName || "EWRA").replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").substring(0, 30);

  res.setHeader("Content-Type",        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="EWRA-Consolidated-${safeName}-${safeAssess}.xlsx"`);
  res.setHeader("Cache-Control",       "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma",              "no-cache");

  await wb.xlsx.write(res);
  res.end();
});
