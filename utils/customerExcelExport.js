// utils/customerExcelExport.js
// Presentation layer for the Customer queue Excel export. Owns the grouped
// column model, formatters, styling and workbook assembly; the controller keeps
// data-fetch, tenant scoping and streaming. Extracted from the former
// customerExportController.

const ExcelJS = require("exceljs");

// ── small formatters ─────────────────────────────────────────────────────────
const isEmpty = (v) => v === undefined || v === null || v === "" || v === "null";
const yn = (v) => (v === true ? "Yes" : v === false ? "No" : "");
const fmtDate = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
};
const fmtDateTime = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
};
const join = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).join(", ") : "");
const uniqJoin = (arr) => join([...new Set((arr || []).filter(Boolean))]);
const riskCell = (item) =>
  item && !isEmpty(item.value)
    ? `${item.value}${item.score != null ? ` (${item.score})` : ""}`
    : "";
const composeAddress = (a = {}) =>
  [a.address, a.suburb, a.state, a.postcode, a.country].filter(Boolean).join(", ");

const pform = (d) => d?.personalKyc?.personal_form || {};

// Resolve a populated/raw ObjectId ref to a comparable string.
const idStr = (ref) =>
  ref && ref._id ? String(ref._id) : ref ? String(ref) : null;

// Pick the relation tied to the current tenant (logged-in client/branch) so the
// exported Primary Client/Branch reflect *this* client's view of the customer.
// Falls back to the client-matching relation, then the first relation (admins
// with no tenant scope just get relations[0]).
const pickPrimaryRelation = (relations, clientId, branchId) => {
  if (!Array.isArray(relations) || relations.length === 0) return null;
  const cid = clientId ? String(clientId) : null;
  const bid = branchId ? String(branchId) : null;

  if (cid) {
    const exact = relations.find(
      (r) => idStr(r.client) === cid && (bid ? idStr(r.branch) === bid : true),
    );
    if (exact) return exact;
    const clientOnly = relations.find((r) => idStr(r.client) === cid);
    if (clientOnly) return clientOnly;
  }
  return relations[0];
};

// ── Column model — grouped for a banded header ───────────────────────────────
// Each group renders a merged colour band above its columns. `get(d)` reads the
// decrypted customer object (virtuals included).
const GROUPS = [
  {
    name: "Identity",
    color: "FF1F3864",
    cols: [
      { h: "UID", w: 15, get: (d) => d.uid },
      { h: "Seq", w: 7, get: (d) => d.sequence },
      { h: "Full Name", w: 24, get: (d) => d.user?.name },
      { h: "Username", w: 16, get: (d) => d.user?.userName },
      { h: "Account Email", w: 26, get: (d) => d.user?.email },
      { h: "User Type", w: 13, get: (d) => d._membership?.userType ?? d.user?.userType },
      { h: "Role", w: 12, get: (d) => d._membership?.role ?? d.user?.role },
    ],
  },
  {
    name: "Personal KYC",
    color: "FF2E5496",
    cols: [
      { h: "Given Name", w: 16, get: (d) => pform(d).customer_details?.given_name },
      { h: "Middle Name", w: 14, get: (d) => pform(d).customer_details?.middle_name },
      { h: "Surname", w: 16, get: (d) => pform(d).customer_details?.surname },
      { h: "Other Names", w: 16, get: (d) => pform(d).customer_details?.other_names },
      { h: "Date of Birth", w: 14, get: (d) => fmtDate(pform(d).customer_details?.date_of_birth) },
      { h: "KYC Email", w: 24, get: (d) => pform(d).contact_details?.email },
      { h: "KYC Phone", w: 16, get: (d) => pform(d).contact_details?.phone },
      { h: "Occupation", w: 18, get: (d) => pform(d).employment_details?.occupation },
      { h: "Industry", w: 18, get: (d) => pform(d).employment_details?.industry },
      { h: "Employer", w: 18, get: (d) => pform(d).employment_details?.employer_name },
      { h: "ID Number", w: 18, get: (d) => pform(d).identificationNo },
    ],
  },
  {
    name: "Address",
    color: "FF3A6BB0",
    cols: [
      { h: "Residential Address", w: 32, get: (d) => composeAddress(pform(d).residential_address) },
      { h: "Residential Country", w: 16, get: (d) => pform(d).residential_address?.country },
      { h: "Mailing Address", w: 32, get: (d) => composeAddress(pform(d).mailing_address) },
    ],
  },
  {
    name: "Funds & Wealth",
    color: "FF548235",
    cols: [
      { h: "Source of Funds", w: 18, get: (d) => d.personalKyc?.funds_wealth?.source_of_funds },
      { h: "Source of Wealth", w: 18, get: (d) => d.personalKyc?.funds_wealth?.source_of_wealth },
      { h: "Account Purpose", w: 18, get: (d) => d.personalKyc?.funds_wealth?.account_purpose },
      { h: "Est. Trading Volume", w: 18, get: (d) => d.personalKyc?.funds_wealth?.estimated_trading_volume },
    ],
  },
  {
    name: "Sole Trader",
    color: "FF6E9E45",
    cols: [
      { h: "Sole Trader", w: 12, get: (d) => yn(d.personalKyc?.sole_trader?.is_sole_trader) },
      { h: "Business Name", w: 20, get: (d) => d.personalKyc?.sole_trader?.business_details?.business_name },
      { h: "Business ABN", w: 16, get: (d) => d.personalKyc?.sole_trader?.business_details?.abn },
    ],
  },
  {
    name: "KYC Status",
    color: "FFBF8F00",
    cols: [
      { h: "KYC Status", w: 14, get: (d) => d.kycStatus },
      { h: "KYC Verified At", w: 18, get: (d) => fmtDateTime(d.kycVerifiedAt) },
      { h: "KYC Reject Reason", w: 30, get: (d) => d.kycRejectReason },
      { h: "KYC Notes", w: 24, get: (d) => d.kycNotes },
      { h: "Active", w: 9, get: (d) => yn(d.isActive) },
      { h: "Lifecycle", w: 12, get: (d) => d.status },
      { h: "Consent to Screen", w: 14, get: (d) => yn(d.consentToScreen) },
    ],
  },
  {
    name: "Screening / AML",
    color: "FFC00000",
    cols: [
      { h: "PEP", w: 8, get: (d) => yn(d.isPep) },
      { h: "Sanction", w: 10, get: (d) => yn(d.sanction) },
      { h: "AML Status", w: 14, get: (d) => d.amlStatus },
      { h: "AML Risk Labels", w: 22, get: (d) => join(d.amlRiskLabels) },
      { h: "AML Vendor", w: 22, get: (d) => d.amlVendor },
      { h: "AML Checked At", w: 18, get: (d) => fmtDateTime(d.amlCheckedAt) },
    ],
  },
  {
    name: "Risk Assessment",
    color: "FF7030A0",
    cols: [
      { h: "Risk Score", w: 11, get: (d) => d.riskScore, num: true },
      { h: "Risk Label", w: 14, get: (d) => d.riskLabel },
      { h: "Customer Type", w: 16, get: (d) => riskCell(d.riskAssessment?.customerType) },
      {
        h: "Jurisdiction",
        w: 18,
        get: (d) => {
          const j = d.riskAssessment?.jurisdiction;
          if (!j || isEmpty(j.value)) return "";
          return `${j.value}${j.band ? ` / ${j.band}` : ""}${j.score != null ? ` (${j.score})` : ""}`;
        },
      },
      { h: "Customer Retention", w: 18, get: (d) => riskCell(d.riskAssessment?.customerRetention) },
      { h: "Channel", w: 16, get: (d) => riskCell(d.riskAssessment?.channel) },
      { h: "Occupation (Risk)", w: 18, get: (d) => riskCell(d.riskAssessment?.occupation) },
      { h: "Industry (Risk)", w: 18, get: (d) => riskCell(d.riskAssessment?.industry) },
      { h: "Product (Risk)", w: 18, get: (d) => riskCell(d.riskAssessment?.product) },
      { h: "PEP Status (Risk)", w: 18, get: (d) => riskCell(d.riskAssessment?.pepStatus) },
      { h: "Source of Funds (Risk)", w: 20, get: (d) => riskCell(d.riskAssessment?.sourceOfFunds) },
      { h: "Source of Wealth (Risk)", w: 20, get: (d) => riskCell(d.riskAssessment?.sourceOfWealth) },
      { h: "Adverse Media (Risk)", w: 20, get: (d) => riskCell(d.riskAssessment?.adverseMedia) },
    ],
  },
  {
    name: "Relations",
    color: "FF7F6000",
    cols: [
      { h: "Relations", w: 11, get: (d) => (d.relations || []).length, num: true },
      { h: "Relation Types", w: 22, get: (d) => uniqJoin((d.relations || []).map((r) => r.type)) },
      // Primary Client/Branch reflect the relation tied to the CURRENT tenant
      // (the logged-in client/branch); falls back to the first relation for admins.
      { h: "Primary Client", w: 20, get: (d) => d._primaryRelation?.client?.name },
      { h: "Primary Branch", w: 20, get: (d) => d._primaryRelation?.branch?.name },
      { h: "Onboarding Channel", w: 20, get: (d) => d._primaryRelation?.onboardingChannel },
      { h: "Source", w: 16, get: (d) => d._primaryRelation?.source },
      { h: "Country", w: 16, get: (d) => d.country },
    ],
  },
  {
    name: "Declaration / Lifecycle",
    color: "FF595959",
    cols: [
      { h: "Declaration Accepted", w: 16, get: (d) => yn(d.declaration?.declarations_accepted) },
      { h: "Signatory Name", w: 20, get: (d) => d.declaration?.signatory_name },
      { h: "Offboarded At", w: 18, get: (d) => fmtDateTime(d.offboardedAt) },
      { h: "Offboard Reason", w: 24, get: (d) => d.offboardReason },
    ],
  },
  {
    name: "Audit",
    color: "FF404040",
    cols: [
      { h: "Created At", w: 18, get: (d) => fmtDateTime(d.createdAt) },
      { h: "Updated At", w: 18, get: (d) => fmtDateTime(d.updatedAt) },
    ],
  },
];

const FLAT = GROUPS.flatMap((g) => g.cols.map((c) => ({ ...c, group: g.name, groupColor: g.color })));
const N_COLS = FLAT.length;
const HEADER_ROW = 4; // banner(1) + meta(2) + group band(3) + column headers(4)

// ── styling helpers ──────────────────────────────────────────────────────────
const thin = { style: "thin", color: { argb: "FFD9D9D9" } };
const border = { top: thin, left: thin, bottom: thin, right: thin };
const fill = (cell, argb) => {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
};

/**
 * Build the styled Customers workbook from already-decrypted/materialized rows.
 * @param {Array<Object>} rows — decrypted customer objects (virtuals + _primaryRelation + _membership)
 * @param {Object} meta
 * @param {number} meta.recordCount — number of rows rendered
 * @param {boolean} [meta.capped] — true when the query hit the row cap
 * @param {number} [meta.maxRows] — the cap value (shown when capped)
 * @param {string} [meta.activeFilters] — human-readable active-filter summary
 * @returns {ExcelJS.Workbook}
 */
const buildCustomerWorkbook = (rows, meta = {}) => {
  const { recordCount = rows.length, capped = false, maxRows, activeFilters } = meta;

  const wb = new ExcelJS.Workbook();
  wb.creator = "dooit.ai";
  wb.lastModifiedBy = "dooit.ai Customer Module";
  wb.created = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet("Customers", {
    views: [{ state: "frozen", xSplit: 0, ySplit: HEADER_ROW }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = FLAT.map((c) => ({ key: c.h, width: c.w }));

  const lastColLetter = ws.getColumn(N_COLS).letter;

  // Row 1 — title banner
  ws.mergeCells(`A1:${lastColLetter}1`);
  const title = ws.getCell("A1");
  title.value = "Customer Register  ·  dooit.ai  ·  Onboarding & Risk";
  fill(title, "FF1F3864");
  title.font = { size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  title.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 26;

  // Row 2 — export metadata
  ws.mergeCells(`A2:${lastColLetter}2`);
  const metaCell = ws.getCell("A2");
  metaCell.value =
    `Generated: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC` +
    `      Records: ${recordCount}${capped && maxRows ? ` (capped at ${maxRows})` : ""}` +
    (activeFilters ? `      Filters: ${activeFilters}` : "      Filters: none") +
    "      CONFIDENTIAL";
  fill(metaCell, "FFEDEDED");
  metaCell.font = { size: 9, italic: true, color: { argb: "FF505050" } };
  metaCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(2).height = 16;

  // Row 3 — group colour bands
  const bandRow = ws.getRow(3);
  bandRow.height = 18;
  let col = 1;
  GROUPS.forEach((g) => {
    const start = col;
    const end = col + g.cols.length - 1;
    if (end > start) {
      ws.mergeCells(3, start, 3, end);
    }
    const cell = bandRow.getCell(start);
    cell.value = g.name.toUpperCase();
    fill(cell, g.color);
    cell.font = { size: 9, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = border;
    col = end + 1;
  });

  // Row 4 — column headers
  const headerRow = ws.getRow(HEADER_ROW);
  headerRow.height = 28;
  FLAT.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.h;
    fill(cell, "FFF2F2F2");
    cell.font = { size: 9, bold: true, color: { argb: "FF1F3864" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = border;
  });

  // Data rows
  rows.forEach((d, idx) => {
    const r = ws.getRow(HEADER_ROW + 1 + idx);
    FLAT.forEach((c, i) => {
      let v;
      try {
        v = c.get(d);
      } catch {
        v = "";
      }
      const cell = r.getCell(i + 1);
      cell.value = v == null ? "" : v;
      cell.font = { size: 9, color: { argb: "FF333333" } };
      cell.alignment = { vertical: "middle", horizontal: c.num ? "center" : "left", wrapText: false };
      cell.border = border;
      if (idx % 2 === 1) fill(cell, "FFFAFAFA"); // zebra striping
    });
    r.height = 15;
  });

  // Autofilter over the header row
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: N_COLS } };

  return wb;
};

module.exports = {
  buildCustomerWorkbook,
  pickPrimaryRelation,
  isEmpty,
};
