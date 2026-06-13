"use strict";

/**
 * EWRA Risk Register engine — scenario-level scoring per the dooit Risk
 * Matrix framework (docs/datasheet/Risk_Matrix.md) and the VDG sample
 * register (docs/datasheet/VDG_Risk_Register.md).
 *
 * IMPORTANT: inherent band is a 5×5 MATRIX LOOKUP, not Likelihood ×
 * Consequence arithmetic — e.g. L1 × C4 = 4 would be "L" numerically, but
 * the matrix says "M" (verified against every VDG register row).
 */

// 5×5 inherent matrix — INHERENT_MATRIX[likelihood-1][consequence-1] → band.
// Authoritative grid assembled from Risk_Matrix.md (C1–C3), the framework
// extraction (L3–L5 full rows) and VDG data points (L1C4/C5 = M).
const INHERENT_MATRIX = [
  ["VL", "VL", "L", "M", "M"], // L1 Rare
  ["VL", "L", "M", "M", "H"],  // L2 Unlikely
  ["L", "M", "M", "H", "E"],   // L3 Possible
  ["M", "M", "H", "E", "E"],   // L4 Likely
  ["M", "H", "E", "E", "E"],   // L5 Almost Certain
];

// Residual matrix — RESIDUAL_MATRIX[inherentBand][ctrlEff-1] → band
// (Risk_Matrix.md §5; ce4/ce5 recovered from risk_matrix_framework.json and
//  verified against the VDG register: eff 3 keeps the band, eff 4 drops one)
const RESIDUAL_MATRIX = {
  E:  ["E", "E", "H", "H", "M"],
  H:  ["E", "H", "H", "M", "M"],
  M:  ["H", "M", "M", "L", "L"],
  L:  ["M", "L", "L", "VL", "VL"],
  VL: ["L", "VL", "VL", "VL", "VL"],
};

const BAND_LABELS = { VL: "Very Low", L: "Low", M: "Medium", H: "High", E: "Extreme" };
const LABEL_TO_CODE = { "Very Low": "VL", Low: "L", Medium: "M", High: "H", Extreme: "E" };

// Representative numeric per band on the 1–5 score scale — chosen so the
// standard rating thresholds (≤1 VL, ≤1.5 L, ≤2.5 M, ≤3.5 H, >3.5 E)
// reproduce the band. Used where a band must feed weighted averages.
const BAND_MIDPOINT = { VL: 1, L: 1.25, M: 2, H: 3, E: 4.25 };

function inherentBand(likelihood, consequence) {
  const l = Number(likelihood), c = Number(consequence);
  if (!(l >= 1 && l <= 5 && c >= 1 && c <= 5)) return "";
  return INHERENT_MATRIX[l - 1][c - 1];
}

function residualBand(inherentCode, ctrlEff) {
  const row = RESIDUAL_MATRIX[inherentCode];
  const e = Number(ctrlEff);
  if (!row || !(e >= 1 && e <= 5)) return inherentCode || "";
  return row[e - 1];
}

// ── Register section taxonomy ─────────────────────────────────────────────────
// S1–S4 are the AML/CTF Act statutory risk factors (customer types, designated
// services, delivery channels, foreign jurisdictions); S5–S6 come from AUSTRAC
// SMR/starter-kit guidance; S7 implements FATF Rec 15 / new-technology risk;
// S8 implements the AML/CTF Amendment Act 2024 proliferation-financing
// assessment obligation. Sections are stored PER ASSESSMENT
// (EwraAssessment.registerSections) so COs can add custom sections.
const DEFAULT_REGISTER_SECTIONS = [
  { code: "S1", label: "SECTION 1 — CUSTOMER TYPE RISKS", category: "Customer", sortOrder: 1, basis: "AML/CTF Act statutory factor — customer types (incl. beneficial owners)", source: "default" },
  { code: "S2", label: "SECTION 2 — DESIGNATED SERVICE RISKS", category: "Product", sortOrder: 2, basis: "AML/CTF Act statutory factor — designated services provided", source: "default" },
  { code: "S3", label: "SECTION 3 — JURISDICTION RISKS", category: "Geographic", sortOrder: 3, basis: "AML/CTF Act statutory factor — foreign jurisdictions dealt with", source: "default" },
  { code: "S4", label: "SECTION 4 — CHANNEL AND DELIVERY RISKS", category: "Channel", sortOrder: 4, basis: "AML/CTF Act statutory factor — methods of designated service delivery", source: "default" },
  { code: "S5", label: "SECTION 5 — CUSTOMER BEHAVIOUR AND TRANSACTION RISKS", category: "Customer", sortOrder: 5, basis: "AUSTRAC SMR red-flag guidance / sector starter kits", source: "default" },
  { code: "S6", label: "SECTION 6 — OPERATIONAL AND COMPLIANCE RISKS", category: "Environmental", sortOrder: 6, basis: "AML/CTF Program compliance obligations (reporting, training, evaluation)", source: "default" },
  { code: "S7", label: "SECTION 7 — NEW TECHNOLOGIES AND PRODUCTS", category: "Product", sortOrder: 7, basis: "FATF Rec 15 — new products, business practices and delivery technologies must be risk-assessed before launch", source: "default" },
  { code: "S8", label: "SECTION 8 — PROLIFERATION FINANCING AND SANCTIONS", category: "Geographic", sortOrder: 8, basis: "AML/CTF Amendment Act 2024 — PF risk must be assessed alongside ML/TF; Autonomous Sanctions Act 2011", source: "default" },
];

// Backwards-compatible label map (legacy data / fallback when an assessment
// has no stored section definitions)
const SECTION_LABELS = DEFAULT_REGISTER_SECTIONS.reduce((acc, s) => {
  acc[s.code] = s.label;
  return acc;
}, {});

// Starter scenarios for the two new sections (generic across entity types;
// scored like the VDG template rows — matrix-verified)
const EXTRA_TEMPLATE_SCENARIOS = [
  {
    ref: 29,
    riskType: "Product",
    riskSection: "S7",
    category: "Product",
    factorRef: "EW_P_004", // New Product/Service Risk
    riskName: "New or materially changed product, service or delivery technology adopted without prior ML/TF/PF risk assessment",
    description: "FATF Rec 15: new products, business practices and technologies can create unassessed ML/TF exposure. Red flags: feature launched without EWRA trigger update; new onboarding channel without VOI review; third-party technology integrated without due diligence.",
    pfSanctionsNote: "Assess sanctions-evasion potential of any new technology (e.g. anonymising features).",
    applicableChannels: ["D"],
    likelihood: 2,
    consequence: 3,
    inherentRisk: inherentBand(2, 3), // M
    existingControls: "EWRA trigger-update obligation: material business changes require a trigger amendment before launch. dooit amendment workflow records the change and re-scores affected factors.",
    controlEffectiveness: 3,
    residualRisk: residualBand(inherentBand(2, 3), 3), // M
    actionRequired: false,
    controlIds: [],
    controlsOwner: "AML/CTF CO",
    withinRiskAppetite: true,
  },
  {
    ref: 30,
    riskType: "Jurisdiction",
    riskSection: "S8",
    category: "Geographic",
    factorRef: "EW_G_004", // Counterparty Location Risk
    riskName: "Client, beneficial owner or transaction linked to proliferation financing or sanctions evasion",
    description: "AML/CTF Amendment Act 2024 requires PF risk to be assessed alongside ML/TF. Red flags: dual-use goods trade; counterparties in proliferation-sensitive jurisdictions; complex shipping/payment routing; sanctioned-party nexus.",
    pfSanctionsNote: "DFAT Consolidated List + UN sanctions screening mandatory. Criminal offence to deal with designated persons (Autonomous Sanctions Act 2011).",
    applicableChannels: ["F", "D", "T"],
    likelihood: 1,
    consequence: 5,
    inherentRisk: inherentBand(1, 5), // M
    existingControls: "Automated DFAT/OFAC/UN sanctions screening at onboarding and ongoing. UHRC auto-block in CRA engine. CO escalation and SMR assessment on any PF indicator.",
    controlEffectiveness: 4,
    residualRisk: residualBand(inherentBand(1, 5), 4), // L
    actionRequired: false,
    controlIds: ["CTRL_SCR_001", "CTRL_SCR_002", "CTRL_RPT_001"],
    controlsOwner: "AML/CTF CO",
    withinRiskAppetite: true,
  },
];

const RISK_TYPE_TO_SECTION = {
  Customer: "S1",
  Product: "S2",
  Jurisdiction: "S3",
  Channel: "S4",
  Behaviour: "S5",
  Operational: "S6",
};

// risk_type → EWRA factor category (EWRA-Risk-Register-Alignment.md §3)
const RISK_TYPE_TO_CATEGORY = {
  Customer: "Customer",
  Product: "Product",
  Jurisdiction: "Geographic",
  Channel: "Channel",
  Behaviour: "Customer",       // behavioural red flags are customer-level events
  Operational: "Environmental", // program/compliance risks are contextual
};

// template scenario ref → parent EWRA factor (alignment doc §6.3)
const TEMPLATE_FACTOR_MAP = {
  1: "EW_C_001", 2: "EW_C_002", 3: "EW_C_002", 4: "EW_C_002", 5: "EW_C_002",
  6: "EW_C_001", 7: "EW_C_003", 8: "EW_C_001",
  9: "EW_P_001", 10: "EW_CH_003", 11: "EW_P_003", 12: "EW_P_001",
  13: "EW_P_001", 14: "EW_P_001", 15: "EW_P_001",
  16: "EW_G_002", 17: "EW_G_003", 18: "EW_G_001",
  19: "EW_CH_001", 20: "EW_CH_002",
  21: "EW_C_002", 22: "EW_C_004", 23: "EW_C_001", 24: "EW_C_001",
  25: "EW_E_003", 26: "EW_E_004", 27: "EW_E_004", 28: "EW_E_004",
};

/**
 * Parse seed/sample_risk_register.json into normalised template scenarios
 * (skips section-header rows like ref "S1" and the trailing summary row).
 */
function loadTemplateScenarios() {
  const raw = require("../../seed/sample_risk_register.json");
  const out = [];
  for (const item of raw) {
    const refNum = Number(item.ref);
    if (!Number.isInteger(refNum) || refNum < 1) continue; // headers / summary
    const riskType = (item.risk_type || "").trim();
    const likelihood = Number(item.likelihood) || null;
    const consequence = Number(item.consequence) || null;
    const ctrlEff = Number(item.ctrl_eff) || null;
    const inherent = likelihood && consequence ? inherentBand(likelihood, consequence) : (item.inherent_risk || "");
    out.push({
      ref: refNum,
      riskType,
      riskSection: RISK_TYPE_TO_SECTION[riskType] || "",
      category: RISK_TYPE_TO_CATEGORY[riskType] || "",
      factorRef: TEMPLATE_FACTOR_MAP[refNum] || "",
      riskName: item.risk_name || "",
      description: item.description_cause_red_flags || "",
      pfSanctionsNote: item.pf_sanctions_note || "",
      applicableChannels: (item.channel || "").split(",").map((s) => s.trim()).filter(Boolean),
      likelihood,
      consequence,
      inherentRisk: inherent,
      existingControls: item.existing_controls || "",
      controlEffectiveness: ctrlEff,
      residualRisk: ctrlEff ? residualBand(inherent, ctrlEff) : (item.residual_risk || ""),
      actionRequired: /^y/i.test(item.action_required || ""),
      controlIds: (item.control_ids || "").split(",").map((s) => s.trim()).filter(Boolean),
      controlsOwner: item.controls_owner || "",
      withinRiskAppetite: /^y/i.test(item.risk_appetite || ""),
    });
  }
  return out;
}

module.exports = {
  INHERENT_MATRIX,
  RESIDUAL_MATRIX,
  BAND_LABELS,
  LABEL_TO_CODE,
  BAND_MIDPOINT,
  SECTION_LABELS,
  DEFAULT_REGISTER_SECTIONS,
  EXTRA_TEMPLATE_SCENARIOS,
  RISK_TYPE_TO_SECTION,
  RISK_TYPE_TO_CATEGORY,
  TEMPLATE_FACTOR_MAP,
  inherentBand,
  residualBand,
  loadTemplateScenarios,
};
