// utils/customerKycReport.js
// Presentation layer for the Sumsub-style per-customer KYC applicant report.
// Owns the formatters, status chips and print-grade HTML builder; the
// controller keeps data-fetch, decryption, journey scoping and Puppeteer
// streaming. Extracted from the former customerKycExportController.

const countriesA3 = require("../_data/countries-alpha3.json");

// ISO alpha-2/alpha-3 → country name (for the Identity Check block). No flag
// emoji — headless Chrome ships no emoji font, so codes render as tofu boxes.
const COUNTRY_BY_CODE = countriesA3.reduce((acc, c) => {
  if (c.alpha2) acc[c.alpha2.toUpperCase()] = c.name;
  if (c.alpha3) acc[c.alpha3.toUpperCase()] = c.name;
  return acc;
}, {});
const countryName = (code) =>
  code ? COUNTRY_BY_CODE[String(code).toUpperCase()] || String(code) : "";

const ID_DOC_TYPE_LABELS = {
  DRIVERS: "Driver's Licence",
  PASSPORT: "Passport",
  ID_CARD: "ID Card",
  RESIDENCE_PERMIT: "Residence Permit",
  UTILITY_BILL: "Utility Bill",
};

// Avatar prefers the live selfie captured during onboarding over the portal
// user's photoUrl — shared rule (also used by the queue list enrichment).
const { resolveSelfieUrl } = require("./customerSelfie");

// ── small formatters ─────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
const isEmpty = (v) => v === undefined || v === null || v === "";
const dash = (v) => (isEmpty(v) ? "—" : esc(v));
const yn = (v) => (v === true ? "Yes" : v === false ? "No" : "—");
const fmtLabel = (s) =>
  isEmpty(s) ? "—" : esc(String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
const fmtDate = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d)
    ? "—"
    : d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
};
const fmtDateTime = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d)
    ? "—"
    : d.toLocaleString("en-AU", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
};
const composeAddress = (a = {}) =>
  [a.address, a.suburb, a.state, a.postcode, a.country].filter(Boolean).join(", ");

// ── status chips (Sumsub-like colour language) ───────────────────────────────
const CHIP = {
  green: "background:#E7F6EC;color:#1B7A3D;border:1px solid #BFE5CC;",
  amber: "background:#FDF3E1;color:#9A6700;border:1px solid #F2DFB5;",
  red: "background:#FCEBEA;color:#B42318;border:1px solid #F4C7C3;",
  blue: "background:#EAF1FB;color:#1F3864;border:1px solid #C9DAF0;",
  gray: "background:#F2F2F2;color:#555;border:1px solid #E0E0E0;",
};
const STATUS_CHIP = {
  verified: "green", approved: "green", completed: "green", clear: "green",
  pending: "amber", in_progress: "amber", in_review: "blue",
  rejected: "red", flagged: "red",
  not_started: "gray",
};
const chip = (value) => {
  const tone = CHIP[STATUS_CHIP[String(value || "").toLowerCase()] || "gray"];
  return `<span class="chip" style="${tone}">${fmtLabel(value || "—")}</span>`;
};
// PEP / Sanction: "No" is the good outcome.
const riskFlagChip = (value) =>
  `<span class="chip" style="${value ? CHIP.red : CHIP.green}">${yn(value)}</span>`;

const field = (label, value) => `
  <div class="fld"><div class="fld-l">${esc(label)}</div><div class="fld-v">${value}</div></div>`;

const section = (title, body) => `
  <div class="sec">
    <div class="sec-t">${esc(title)}</div>
    ${body}
  </div>`;

const riskRow = (name, item) => {
  if (!item || (isEmpty(item.value) && isEmpty(item.score))) return "";
  return `<tr>
    <td>${esc(name)}</td>
    <td>${fmtLabel(item.value)}${item.band ? ` <span class="muted">/ ${esc(item.band)}</span>` : ""}</td>
    <td class="c">${isEmpty(item.score) ? "—" : esc(item.score)}</td>
  </tr>`;
};

const isImageDoc = (doc = {}) =>
  /^image\//i.test(doc.mimeType || "") || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(doc.url || "");

// ── report HTML ──────────────────────────────────────────────────────────────
const buildKycReportHtml = (d, journeys) => {
  const kyc = d.personalKyc || {};
  const cd = kyc.personal_form?.customer_details || {};
  const contact = kyc.personal_form?.contact_details || {};
  const emp = kyc.personal_form?.employment_details || {};
  const res = kyc.personal_form?.residential_address || {};
  const mail = kyc.personal_form?.mailing_address || {};
  const fw = kyc.funds_wealth || {};
  const st = kyc.sole_trader || {};
  const ra = d.riskAssessment || {};

  const fullName =
    [cd.given_name, cd.middle_name, cd.surname].filter(Boolean).join(" ") ||
    d.user?.name ||
    "—";

  const avatarUrl = resolveSelfieUrl(d, journeys) || d.user?.photoUrl;
  const photo = avatarUrl
    ? `<img class="avatar" src="${esc(avatarUrl)}" />`
    : `<div class="avatar avatar-ph">${esc((fullName || "?").charAt(0).toUpperCase())}</div>`;

  // ── documents ──
  const docs = Array.isArray(d.documents) ? d.documents : [];
  const journeyDocs = (journeys || []).flatMap((j) =>
    (j.steps || []).flatMap((s) =>
      (s.documents || []).map((doc) => ({ ...doc, _step: s.label || s.type })),
    ),
  );
  const allDocs = [...docs, ...journeyDocs];
  const seen = new Set();
  const uniqueDocs = allDocs.filter((doc) => {
    const key = doc.url || `${doc.name}-${doc.docType}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const docCards = uniqueDocs
    .map((doc) => {
      const label = doc.docType || doc.name || doc.type || "Document";
      const sub = doc._step ? `<div class="muted">${fmtLabel(doc._step)}</div>` : "";
      const preview = isImageDoc(doc)
        ? `<img class="doc-img" src="${esc(doc.url)}" />`
        : `<div class="doc-file">${esc((doc.mimeType || "FILE").split("/").pop().toUpperCase())}</div>`;
      return `<div class="doc-card">${preview}<div class="doc-cap">${fmtLabel(label)}${sub}</div></div>`;
    })
    .join("");

  // ── journeys ──
  const journeyBlocks = (journeys || [])
    .map((j, idx) => {
      const steps = [...(j.steps || [])]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(
          (s) => `<tr>
            <td>${fmtLabel(s.label || s.type)}</td>
            <td class="c">${chip(s.status)}</td>
            <td class="c">${s.attempts || 0}</td>
            <td class="c">${s.required === false ? "Optional" : "Required"}</td>
          </tr>`,
        )
        .join("");
      return `
        <div class="j-head">
          <span class="j-title">Journey ${idx + 1}${j.client?.name ? ` — ${esc(j.client.name)}` : ""}</span>
          <span class="muted">Started ${fmtDateTime(j.createdAt)}${j.provider ? ` · Provider: ${fmtLabel(j.provider)}` : ""}${j.onboardingChannel ? ` · Channel: ${fmtLabel(j.onboardingChannel)}` : ""}</span>
        </div>
        <table class="tbl">
          <thead><tr><th>Step</th><th class="c" style="width:110px">Status</th><th class="c" style="width:70px">Attempts</th><th class="c" style="width:80px">Type</th></tr></thead>
          <tbody>${steps || '<tr><td colspan="4">No steps recorded.</td></tr>'}</tbody>
        </table>`;
    })
    .join("");

  // ── identity checks (Sumsub DVS / PERSON check) ──
  const identityCheckBlocks = (Array.isArray(d.checks) ? d.checks : [])
    .map((c) => {
      const inp = c.inputDoc || {};
      const bg = c.personBackgroundInfo || {};
      const docLabel = ID_DOC_TYPE_LABELS[inp.idDocType] || fmtLabel(inp.idDocType || "Document");
      const idValid = String(bg.identityAnswer ?? c.answer ?? "").toUpperCase() === "GREEN";
      const cName = countryName(inp.country);
      // Retrieved-data descriptors: prefer explicit fields, else DVS defaults
      // for Australian checks (DVS is the AU government identity source).
      const isDvs = cName === "Australia";
      const productName =
        bg.productName ||
        (isDvs ? `Document Verification Service (DVS) Validation in ${cName}` : "");
      const dataSources =
        bg.dataSources || (isDvs ? "Document Verification Service (DVS)" : "");
      const validChip = `<span class="chip" style="${idValid ? CHIP.green : CHIP.red}">${
        idValid ? "Identity document is valid" : "Identity document is not valid"
      }</span>`;
      return `
        <div class="idc">
          <div class="idc-head">
            <span class="idc-title">Identity check</span>
            <span class="muted">${c.createdAt ? fmtDateTime(c.createdAt) : ""}</span>
            ${chip(c.answer)}
          </div>
          <div class="idc-cols">
            <div>
              <div class="idc-sub">Input Data</div>
              <div class="grid" style="grid-template-columns: repeat(2, 1fr);">
                ${field("Country", cName ? esc(cName) : "—")}
                ${field("First Name", dash(inp.firstName))}
                ${field("Last Name", dash(inp.lastName))}
                ${field(docLabel, dash(inp.number))}
                ${inp.additionalNumber ? field("Additional Number", dash(inp.additionalNumber)) : ""}
                ${field("Date of Birth", dash(inp.dob))}
              </div>
            </div>
            <div>
              <div class="idc-sub">Retrieved Data</div>
              <div class="grid" style="grid-template-columns: 1fr;">
                ${productName ? field("Product Name", esc(productName)) : ""}
                ${dataSources ? field("Data Sources", esc(dataSources)) : ""}
                ${field("Identity Document Validation", validChip)}
              </div>
            </div>
          </div>
        </div>`;
    })
    .join("");

  // ── KYC history ──
  const historyRows = (d.kycHistory || [])
    .map(
      (h) => `<tr>
        <td style="width:130px">${fmtDateTime(h.changedAt)}</td>
        <td class="c" style="width:100px">${chip(h.status)}</td>
        <td>${dash(h.note)}</td>
      </tr>`,
    )
    .join("");

  const rejection = d.kycRejectReason
    ? `<div class="warn"><b>KYC Rejection Reason</b><br/>${esc(d.kycRejectReason).replace(/\n/g, "<br/>")}</div>`
    : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #1a1a1a; margin: 26px; }
  .banner { background: #1F3864; color: #fff; border-radius: 8px; padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; }
  .banner h1 { font-size: 16px; margin: 0; }
  .banner .muted { color: #C9DAF0; font-size: 9px; margin-top: 3px; }
  .conf { background: #fff; color: #B42318; font-weight: bold; font-size: 9px; padding: 3px 8px; border-radius: 8px; }
  .profile { display: flex; gap: 14px; align-items: center; margin: 14px 0; padding: 12px 14px; border: 1px solid #E4E9F2; border-radius: 8px; background: #F8FAFD; }
  .avatar { width: 58px; height: 58px; border-radius: 8px; object-fit: cover; border: 1px solid #D5DEEC; }
  .avatar-ph { display: flex; align-items: center; justify-content: center; background: #DCE6F1; color: #1F3864; font-size: 22px; font-weight: bold; }
  .p-name { font-size: 14px; font-weight: bold; color: #1F3864; }
  .p-sub { color: #666; margin-top: 2px; }
  .p-right { margin-left: auto; text-align: right; }
  .score { font-size: 18px; font-weight: bold; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 9px; font-weight: bold; font-size: 9px; }
  .sec { margin-top: 14px; page-break-inside: avoid; }
  .sec-t { font-size: 11px; font-weight: bold; color: #1F3864; text-transform: uppercase; letter-spacing: 0.6px; border-bottom: 2px solid #1F3864; padding-bottom: 3px; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .fld { border: 1px solid #EAEAEA; border-radius: 6px; padding: 5px 8px; background: #FAFBFC; }
  .fld-l { color: #888; font-size: 8px; text-transform: uppercase; letter-spacing: 0.4px; }
  .fld-v { font-weight: bold; margin-top: 2px; word-break: break-word; }
  table.tbl { width: 100%; border-collapse: collapse; }
  table.tbl th { background: #1F3864; color: #fff; text-align: left; padding: 5px 7px; font-size: 9px; }
  table.tbl td { border: 1px solid #E2E2E2; padding: 5px 7px; vertical-align: top; }
  table.tbl tr:nth-child(even) td { background: #F6F9FD; }
  .c { text-align: center; }
  .muted { color: #888; font-size: 9px; }
  .warn { background: #FDF3E1; border: 1px solid #F2DFB5; color: #9A6700; border-radius: 6px; padding: 8px 10px; margin-top: 12px; }
  .docs { display: flex; flex-wrap: wrap; gap: 10px; }
  .doc-card { width: 160px; border: 1px solid #E4E9F2; border-radius: 6px; overflow: hidden; background: #fff; }
  .doc-img { width: 100%; height: 100px; object-fit: cover; display: block; background: #F2F2F2; }
  .doc-file { width: 100%; height: 100px; display: flex; align-items: center; justify-content: center; background: #EAF1FB; color: #1F3864; font-weight: bold; font-size: 12px; }
  .doc-cap { padding: 5px 7px; font-weight: bold; font-size: 9px; border-top: 1px solid #EFEFEF; }
  .j-head { display: flex; justify-content: space-between; align-items: baseline; margin: 8px 0 5px; }
  .j-title { font-weight: bold; color: #1F3864; }
  .idc { border: 1px solid #E4E9F2; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: #fff; page-break-inside: avoid; }
  .idc-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .idc-title { font-weight: bold; color: #1F3864; font-size: 10.5px; }
  .idc-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .idc-sub { font-size: 8px; text-transform: uppercase; letter-spacing: 0.4px; color: #888; font-weight: bold; margin-bottom: 4px; }
  .footer { margin-top: 16px; color: #888; font-size: 8.5px; border-top: 1px solid #E2E2E2; padding-top: 6px; }
</style></head><body>

  <div class="banner">
    <div>
      <h1>KYC Applicant Report</h1>
      <div class="muted">dooit.ai · Onboarding &amp; Compliance · Generated ${fmtDateTime(new Date())}</div>
    </div>
    <span class="conf">CONFIDENTIAL</span>
  </div>

  <div class="profile">
    ${photo}
    <div>
      <div class="p-name">${esc(fullName)}</div>
      <div class="p-sub">UID: <b>${dash(d.uid)}</b> · ${dash(d.user?.email || contact.email)}</div>
      <div class="p-sub">Country: ${dash(d.country)} · Created: ${fmtDateTime(d.createdAt)}</div>
    </div>
    <div class="p-right">
      <div>KYC Status: ${chip(d.kycStatus)}</div>
      <div style="margin-top:5px">Risk: <span class="score">${isEmpty(d.riskScore) ? "—" : esc(d.riskScore)}</span> ${chip(d.riskLabel)}</div>
    </div>
  </div>

  ${rejection}

  ${section(
    "Personal Information",
    `<div class="grid">
      ${field("Given Name", dash(cd.given_name))}
      ${field("Middle Name", dash(cd.middle_name))}
      ${field("Surname", dash(cd.surname))}
      ${field("Other Names", dash(cd.other_names))}
      ${field("Date of Birth", fmtDate(cd.date_of_birth))}
      ${field("Phone", dash(contact.phone || d.metadata?.phone))}
      ${field("Occupation", dash(emp.occupation))}
      ${field("Industry", dash(emp.industry))}
      ${field("Employer", dash(emp.employer_name))}
    </div>`,
  )}

  ${section(
    "Address",
    `<div class="grid" style="grid-template-columns: repeat(2, 1fr);">
      ${field("Residential Address", dash(composeAddress(res)))}
      ${field("Mailing Address", dash(composeAddress(mail)))}
    </div>`,
  )}

  ${section(
    "Funds & Wealth",
    `<div class="grid">
      ${field("Source of Funds", fmtLabel(fw.source_of_funds))}
      ${field("Source of Wealth", fmtLabel(fw.source_of_wealth))}
      ${field("Account Purpose", fmtLabel(fw.account_purpose))}
      ${field("Estimated Trading Volume", fmtLabel(fw.estimated_trading_volume))}
      ${field("Sole Trader", yn(st.is_sole_trader))}
      ${st.is_sole_trader ? field("Business Name", dash(st.business_details?.business_name)) : ""}
    </div>`,
  )}

  ${section(
    "Screening / AML",
    `<div class="grid">
      ${field("PEP", riskFlagChip(d.isPep))}
      ${field("Sanction", riskFlagChip(d.sanction))}
      ${field("AML Status", chip(d.amlStatus))}
      ${field("AML Risk Labels", dash((d.amlRiskLabels || []).join(", ")))}
      ${field("AML Vendor", dash(d.amlVendor))}
      ${field("Last Checked", fmtDateTime(d.amlCheckedAt))}
      ${field("Consent to Screen", yn(d.consentToScreen))}
      ${field("AML Hits", esc((d.amlHits || []).length))}
      ${field("Declaration Accepted", yn(d.declaration?.declarations_accepted))}
    </div>`,
  )}

  ${section(
    "Risk Assessment Breakdown",
    `<table class="tbl">
      <thead><tr><th>Factor</th><th>Value</th><th class="c" style="width:70px">Score</th></tr></thead>
      <tbody>
        ${riskRow("Customer Type", ra.customerType)}
        ${riskRow("Jurisdiction", ra.jurisdiction)}
        ${riskRow("Customer Retention", ra.customerRetention)}
        ${riskRow("Channel", ra.channel)}
        ${riskRow("Occupation", ra.occupation)}
        ${riskRow("Industry", ra.industry)}
        ${riskRow("Product", ra.product)}
        ${riskRow("PEP Status", ra.pepStatus)}
        ${riskRow("Source of Funds", ra.sourceOfFunds)}
        ${riskRow("Source of Wealth", ra.sourceOfWealth)}
        ${riskRow("Adverse Media", ra.adverseMedia)}
        <tr>
          <td><b>Total</b></td>
          <td><b>${fmtLabel(d.riskLabel)}</b></td>
          <td class="c"><b>${isEmpty(d.riskScore) ? "—" : esc(d.riskScore)}</b></td>
        </tr>
      </tbody>
    </table>`,
  )}

  ${identityCheckBlocks ? section("Identity Check", identityCheckBlocks) : ""}

  ${journeyBlocks ? section("Verification Journey", journeyBlocks) : ""}

  ${uniqueDocs.length ? section("Documents", `<div class="docs">${docCards}</div>`) : ""}

  ${
    historyRows
      ? section(
          "KYC History",
          `<table class="tbl">
            <thead><tr><th style="width:130px">Date</th><th class="c" style="width:100px">Status</th><th>Note</th></tr></thead>
            <tbody>${historyRows}</tbody>
          </table>`,
        )
      : ""
  }

  <div class="footer">
    System-generated KYC applicant report · dooit.ai AML/CTF compliance record · Customer ${dash(d.uid)} · ${fmtDateTime(new Date())}.
    This document contains personal information and must be handled per your privacy and record-keeping obligations.
  </div>
</body></html>`;
};

module.exports = { buildKycReportHtml };
