"use strict";

/**
 * riskRegisterEngine.js  (Node.js / CommonJS)
 * Mirrors ewra-ui/constants/riskRegisterEngine.js — generates scored
 * VDG-format risk register rows from Onboarding_Questions.md answers.
 *
 * Uses the canonical inherentBand / residualBand from ewraRiskRegister.js
 * (the same 5×5 matrix as the existing EWRA engine).
 */

const { inherentBand, residualBand, BAND_LABELS } = require("./ewraRiskRegister");

// ── ctrl-eff category map  (factorId → 5-bucket key) ─────────────────────────

const CTRL_CATEGORY = {
  EW_C_001: "cdd",  EW_C_002:  "cdd",
  EW_CH_001:"cdd",  EW_CH_002: "cdd",
  EW_CH_003:"tm",   EW_CH_004: "tm",
  EW_P_001: "tm",   EW_P_002:  "scr",
  EW_P_003: "tm",   EW_P_004:  "gov",
  EW_G_001: "scr",  EW_G_002:  "scr",
  EW_G_003: "geo",
  EW_E_001: "gov",  EW_E_003:  "gov",  EW_E_004: "gov",
};

// ── Entity config ─────────────────────────────────────────────────────────────

const ENTITY_CONFIG = {
  "Lawyers/Conveyancers":  { tranche:"T2", lpp:true,  travelRule:false, gambling5k:false, nraML:"High",      nraTF:"Low-Medium", nraPF:"Low",        evalYears:3 },
  "Accountants":           { tranche:"T2", lpp:false, travelRule:false, gambling5k:false, nraML:"Medium",    nraTF:"Low",        nraPF:"Low",        evalYears:3 },
  "Real Estate Agents":    { tranche:"T2", lpp:false, travelRule:false, gambling5k:false, nraML:"Very High", nraTF:"Low",        nraPF:"Low-Medium", evalYears:3 },
  "Precious Metal Dealers":{ tranche:"T2", lpp:false, travelRule:false, gambling5k:false, nraML:"High",      nraTF:"Medium",     nraPF:"Low",        evalYears:3 },
  "TCSPs":                 { tranche:"T2", lpp:false, travelRule:false, gambling5k:false, nraML:"Medium",    nraTF:"Low",        nraPF:"Low",        evalYears:3 },
  "Banks & ADIs":          { tranche:"T1", lpp:false, travelRule:true,  gambling5k:false, nraML:"Very High", nraTF:"High",       nraPF:"High",       evalYears:1 },
  "Remittance":            { tranche:"T1", lpp:false, travelRule:true,  gambling5k:false, nraML:"High",      nraTF:"Medium",     nraPF:"Medium",     evalYears:1 },
  "VASP/DCEP":             { tranche:"T1", lpp:false, travelRule:true,  gambling5k:false, nraML:"High",      nraTF:"High",       nraPF:"High",       evalYears:1 },
  "Gambling/Casino":       { tranche:"T1", lpp:false, travelRule:false, gambling5k:true,  nraML:"High",      nraTF:"Medium",     nraPF:"Low",        evalYears:2 },
  "Insurance":             { tranche:"T1", lpp:false, travelRule:false, gambling5k:false, nraML:"Medium",    nraTF:"Low-Medium", nraPF:"Low",        evalYears:3 },
};

// ── Risk pool (30 rows — VDG_Risk_Register.md format) ─────────────────────────
// entities: "ALL" | string[]
// cond(a):  answer-based include filter
// lMods:    likelihood adjustments from answers

const RISK_POOL = [

  // S1 — CUSTOMER TYPE RISKS
  { sec:"S1", secName:"Customer Type Risks", ref:"C-001", riskType:"Customer", ch:"F,D,T",
    riskName:"Individual client — standard onboarding",
    description:"Individual clients are generally lower ML/TF risk when using standard services. Risk increases with high-value transactions, foreign nationals, complex asset structures, or third-party representation.",
    pfSanctionsNote:"Screen against DFAT Consolidated List and PEP databases at onboarding.",
    L:2, C:2,
    existingControls:"Stage 1 CDD per AML/CTF Program. VOI via integrated provider. PEP and sanctions screening at onboarding and ongoing. CRA calculated by dooit. Ongoing CDD monitoring.",
    controlIds:["CTRL_CDD_001","CTRL_CDD_006","CTRL_SCR_001"], ctrlFactor:"EW_C_001",
    entities:"ALL",
    cond: a => !a.client_types || a.client_types.includes("Individuals") || a.client_types.includes("Sole traders"),
    lMods:[] },

  { sec:"S1", secName:"Customer Type Risks", ref:"C-002", riskType:"Customer", ch:"F,D,T",
    riskName:"Body corporate, trust, or partnership",
    description:"Corporate and trust structures are a primary ML vehicle due to BO opacity. Multi-layered structures frustrate law enforcement tracing. Red flags: complex structure with no commercial rationale; rapid entity creation; foreign-registered entities.",
    pfSanctionsNote:"Beneficial ownership identification to natural-person level mandatory. Sanctions screening of all BOs.",
    L:3, C:4,
    existingControls:"Stage 2 CRA triggers ECDD for complex structures. BO identification to natural-person level. ECDD and Senior Manager approval for high-risk structures.",
    controlIds:["CTRL_CDD_002","CTRL_CDD_004","CTRL_CDD_016","CTRL_CDD_017"], ctrlFactor:"EW_C_002",
    entities:"ALL",
    cond: a => a.client_types && (a.client_types.includes("Bodies corporate") || a.client_types.includes("Trusts") || a.client_types.includes("Partnerships")),
    lMods:[{ field:"complex_structures", test: v => v === "Regularly", delta:1 }] },

  { sec:"S1", secName:"Customer Type Risks", ref:"C-003", riskType:"Customer", ch:"F,D",
    riskName:"Foreign PEP or family member / close associate",
    description:"Foreign PEPs are classified as High CRA mandatory. Risk: corruption proceeds integrated through designated services. Red flags: government official from high-risk country; large asset purchases; third-party settlement.",
    pfSanctionsNote:"Governing Body approval mandatory. SOF+SOW required. Foreign PEP = mandatory ECDD.",
    L:2, C:4,
    existingControls:"Foreign PEP identified at Stage 1 CRA screening. CRA overridden to HIGH. ECDD initiated. SOF+SOW obtained. Governing Body approval obtained before matter proceeds. Ongoing annual review.",
    controlIds:["CTRL_CDD_006","CTRL_CDD_004","CTRL_CDD_010","CTRL_SCR_004"], ctrlFactor:"EW_C_002",
    entities:"ALL",
    cond: a => (a.pep_exposure && (a.pep_exposure.includes("Foreign") || a.pep_exposure.includes("Both"))) || (a.cr_pep && (a.cr_pep.includes("Foreign") || a.cr_pep.includes("Both"))),
    lMods:[] },

  { sec:"S1", secName:"Customer Type Risks", ref:"C-004", riskType:"Customer", ch:"F,D,T",
    riskName:"Domestic PEP",
    description:"Domestic PEPs pose moderate ML risk. Red flags: instructions to hold large sums; complex structures with no commercial rationale.",
    pfSanctionsNote:"Elevated monitoring. CO notification. Not mandatory ECDD unless CRA reaches High.",
    L:2, C:3,
    existingControls:"Domestic PEP identified at Stage 1 screening. CRA minimum set to MEDIUM. Enhanced monitoring. CO notified. SOF verification for above-profile amounts.",
    controlIds:["CTRL_CDD_006","CTRL_SCR_004","CTRL_CDD_009"], ctrlFactor:"EW_C_002",
    entities:"ALL",
    cond: a => a.pep_exposure && a.pep_exposure !== "No PEP exposure",
    lMods:[] },

  { sec:"S1", secName:"Customer Type Risks", ref:"C-005", riskType:"Customer", ch:"F,D",
    riskName:"Client with connections to high-risk or FATF grey-listed jurisdiction",
    description:"Clients with funds originating from HRC or FATF grey-listed jurisdictions. Red flags: offshore funds; foreign-issued ID; transactions involving multiple international jurisdictions.",
    pfSanctionsNote:"FATF grey-listed jurisdiction = mandatory ECDD. DFAT/OFAC/UN sanctions screening mandatory.",
    L:2, C:3,
    existingControls:"Stage 1 CRA auto-applies jurisdiction score. HRC/grey-listed = ECDD mandatory. SOF/SOW required. CO escalation.",
    controlIds:["CTRL_CDD_001","CTRL_SCR_001","CTRL_CDD_004","CTRL_CDD_010"], ctrlFactor:"EW_G_002",
    entities:"ALL",
    cond: a => a.high_risk_country === "Yes" || a.medium_risk_country === "Yes",
    lMods:[
      { field:"high_risk_country", test: v => v === "Yes", delta:1 },
      { field:"foreign_client_proportion", test: v => v && v.includes("More than 30%"), delta:1 },
    ] },

  { sec:"S1", secName:"Customer Type Risks", ref:"C-006", riskType:"Customer", ch:"F,D",
    riskName:"Client with unexplained wealth disproportionate to known income",
    description:"Clients presenting wealth disproportionate to known legitimate income. Red flags: large cash payments; expensive asset purchases with no clear funding source; reluctance to discuss SOW.",
    pfSanctionsNote:"SOW verification required before matter proceeds. CO approval.",
    L:2, C:4,
    existingControls:"SOW verification required at ECDD trigger. CO review of SOW documentation. Senior Manager awareness where SOW cannot be verified. CRA updated to High.",
    controlIds:["CTRL_CDD_010","CTRL_CDD_004","CTRL_CDD_009"], ctrlFactor:"EW_C_002",
    entities:"ALL",
    cond: a => a.cr_unexplained_wealth === "Yes",
    lMods:[] },

  { sec:"S1", secName:"Customer Type Risks", ref:"C-007", riskType:"Customer", ch:"F,D",
    riskName:"Anonymous or unverified client",
    description:"Clients unwilling or unable to provide adequate identity documentation. If CDD cannot be completed, the designated service must not be provided.",
    pfSanctionsNote:"Cannot proceed if CDD cannot be completed. Assess for SMR.",
    L:3, C:3,
    existingControls:"If CDD cannot be completed at Stage 1: dooit blocks onboarding. CO notified. Service not provided. SMR assessment required.",
    controlIds:["CTRL_CDD_001","CTRL_CDD_021","CTRL_RPT_001"], ctrlFactor:"EW_C_001",
    entities:"ALL",
    cond: a => a.ds_anonymous_clients && a.ds_anonymous_clients !== "No",
    lMods:[] },

  { sec:"S1", secName:"Customer Type Risks", ref:"C-008", riskType:"Customer", ch:"F,D,T",
    riskName:"Charity or NPO client",
    description:"Non-profit organisations are a terrorism financing vector per FATF Recommendation 8. Red flags: unclear beneficiary; donations from high-risk jurisdictions.",
    pfSanctionsNote:"Identify ultimate beneficial control. Check ACNC registration.",
    L:2, C:3,
    existingControls:"CDD on NPO structure and controllers. ACNC and charities register verification. Enhanced monitoring for transactions inconsistent with stated purpose.",
    controlIds:["CTRL_CDD_001","CTRL_CDD_002","CTRL_SCR_001"], ctrlFactor:"EW_C_002",
    entities:"ALL",
    cond: a => a.cr_npo && a.cr_npo !== "No",
    lMods:[{ field:"cr_npo", test: v => v && v.includes("enhanced"), delta:1 }] },

  // S2 — DESIGNATED SERVICE RISKS
  { sec:"S2", secName:"Designated Service Risks", ref:"P-001", riskType:"Product", ch:"F,D",
    riskName:"High-value transaction with unfinanced purchase (≥$1.5M)",
    description:"Unfinanced high-value purchases are a primary ML integration vehicle. Red flags: reluctance to explain SOF; unusual urgency; offshore funds contributing to purchase.",
    pfSanctionsNote:"SOF required; DFAT/OFAC/UN sanctions screen mandatory.",
    L:3, C:4,
    existingControls:"CRA triggers SOF requirement if unfinanced ≥$1.5M. SOF documentation obtained and reviewed by CO. ECDD where SOF cannot be verified.",
    controlIds:["CTRL_CDD_010","CTRL_CDD_004","CTRL_CDD_001"], ctrlFactor:"EW_C_002",
    entities:["Lawyers/Conveyancers","Real Estate Agents","Accountants","TCSPs"],
    cond: a => a.ds_high_value_unfinanced === "Yes",
    lMods:[] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-002", riskType:"Product", ch:"F",
    riskName:"Physical cash transaction (≥$10,000)",
    description:"Physical cash in transactions is a primary ML/TF indicator. TTR required for cash ≥$10,000 (≥$5,000 for gambling). Red flags: multiple cash deposits just below threshold.",
    pfSanctionsNote:"TTR required within 10 business days for cash ≥$10,000. ECDD if ≥$50,000.",
    L:3, C:4,
    existingControls:"TTR auto-created in dooit if cash ≥$10,000. ECDD mandatory if ≥$50,000. CO notified same day. Sub-threshold pattern monitoring activated.",
    controlIds:["CTRL_RPT_002","CTRL_CDD_004","CTRL_TM_009"], ctrlFactor:"EW_CH_003",
    entities:"ALL",
    cond: a => (a.handles_cash && a.handles_cash !== "No") || a.ds_high_currency === "Yes",
    lMods:[
      { field:"handles_cash", test: v => v && v.includes("Regularly"), delta:1 },
      { field:"ds_high_currency", test: v => v === "Yes", delta:1 },
    ] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-003", riskType:"Product", ch:"F,D",
    riskName:"Third-party settlement / payment funds",
    description:"Third-party payment for settlement is the primary ML red flag. Criminals use associates to pay purchases to conceal the true source of funds.",
    pfSanctionsNote:"Sanctions screening of third-party payer. SOF on third-party mandatory.",
    L:3, C:4,
    existingControls:"CRA triggers ECDD when third-party funds identified. SOF on third party. CO decision on whether to proceed. SMR assessment if suspicion cannot be resolved.",
    controlIds:["CTRL_CDD_004","CTRL_CDD_010","CTRL_TM_017","CTRL_RPT_001"], ctrlFactor:"EW_P_001",
    entities:["Lawyers/Conveyancers","Real Estate Agents","Accountants","TCSPs"],
    cond: a => a.uses_intermediaries && a.uses_intermediaries !== "No",
    lMods:[] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-004", riskType:"Product", ch:"F,D",
    riskName:"Trust account — overpayment with request for refund to different account",
    description:"Trust account overpayment followed by refund request to a different account is a classic ML cycling technique.",
    pfSanctionsNote:"Sanctions screening on receiving account. Assess for SMR.",
    L:2, C:4,
    existingControls:"CRA flags this pattern immediately. DO NOT DISBURSE block applied. CO escalation same day. ECDD mandatory. SMR assessment required.",
    controlIds:["CTRL_CDD_004","CTRL_CDD_009","CTRL_RPT_001"], ctrlFactor:"EW_P_003",
    entities:["Lawyers/Conveyancers","TCSPs","Accountants"],
    cond: () => true,
    lMods:[] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-005", riskType:"Product", ch:"F,D",
    riskName:"Complex structure services — shelf company, nominee director, BO structures",
    description:"Shelf companies and nominee roles are deliberately used by criminals to conceal control and ownership. Highest-risk Table 6 service category.",
    pfSanctionsNote:"Identify and sanction-screen the actual principal behind any nominee. ECDD mandatory.",
    L:2, C:4,
    existingControls:"Mandatory ECDD for all complex structure services. BO identification to natural-person level. CO and Senior Manager approval before service commences.",
    controlIds:["CTRL_CDD_002","CTRL_CDD_004","CTRL_CDD_016","CTRL_CDD_017"], ctrlFactor:"EW_P_001",
    entities:["Lawyers/Conveyancers","TCSPs","Accountants"],
    cond: a => a.ds_complex_structures === "Yes",
    lMods:[] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-006", riskType:"Product", ch:"D",
    riskName:"Virtual asset transactions — buy, sell, exchange, transfer",
    description:"VA transactions present high ML/TF risk due to pseudonymity and rapid cross-border movement. Red flags: transactions with unhosted wallets; mixing services.",
    pfSanctionsNote:"Blockchain analytics required. Travel Rule applies. VASP registration check on counterparty.",
    L:4, C:4,
    existingControls:"VA-specific CDD controls. Blockchain analytics via integrated provider. Travel Rule compliance. Counterparty VASP FATF compliance check.",
    controlIds:["CTRL_CDD_001","CTRL_VA_001","CTRL_VA_002","CTRL_SCR_001"], ctrlFactor:"EW_P_002",
    entities:["VASP/DCEP","Banks & ADIs"],
    cond: a => a.ds_virtual_assets === "Yes",
    lMods:[] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-007", riskType:"Product", ch:"D",
    riskName:"International funds transfer / remittance",
    description:"Cross-border fund transfers carry elevated ML/TF risk, particularly to/from FATF grey-listed or sanctioned countries.",
    pfSanctionsNote:"FATF grey-listed jurisdiction = mandatory ECDD. Travel Rule compliance. IFTI reporting if applicable.",
    L:3, C:4,
    existingControls:"Travel Rule controls for transfers meeting threshold. IFTI/IVTS reporting activated. ECDD for HRC corridors.",
    controlIds:["CTRL_CDD_004","CTRL_CDD_010","CTRL_SCR_001","CTRL_RPT_003"], ctrlFactor:"EW_G_003",
    entities:["Banks & ADIs","Remittance","VASP/DCEP"],
    cond: a => a.ds_intl_transfers === "Yes",
    lMods:[{ field:"high_risk_country", test: v => v === "Yes", delta:1 }] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-008", riskType:"Product", ch:"F,D",
    riskName:"Precious metal or stone transactions — physical delivery",
    description:"Precious metals and stones are used as a store of value and ML vehicle due to high portability and anonymity. Red flags: cash purchases; no clear commercial purpose.",
    pfSanctionsNote:"DFAT/OFAC/UN sanctions screen on buyer and seller. SOF for amounts ≥$5,000.",
    L:3, C:4,
    existingControls:"CDD at AUD$5,000 threshold. Sanctions screening at point of sale. SOF for significant purchases.",
    controlIds:["CTRL_CDD_001","CTRL_CDD_004","CTRL_SCR_001","CTRL_TM_009"], ctrlFactor:"EW_P_002",
    entities:["Precious Metal Dealers"],
    cond: () => true,
    lMods:[{ field:"handles_cash", test: v => v && v !== "No", delta:1 }] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-009", riskType:"Product", ch:"F",
    riskName:"Gambling — buy-in or chip purchase ≥$5,000",
    description:"Large buy-ins and chip purchases are a primary ML placement vector in casinos. Red flags: multiple buy-ins just below threshold; immediate cash-out without significant play.",
    pfSanctionsNote:"CDD required at AUD$5,000. TTR for cash ≥$10,000.",
    L:4, C:4,
    existingControls:"CDD at $5,000 buy-in threshold. TTR for cash ≥$10,000. CO notification for suspicious play patterns. VIP programme ECDD.",
    controlIds:["CTRL_CDD_001","CTRL_RPT_002","CTRL_TM_009"], ctrlFactor:"EW_CH_003",
    entities:["Gambling/Casino"],
    cond: () => true,
    lMods:[{ field:"handles_cash", test: v => v && v.includes("Regularly"), delta:1 }] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-010", riskType:"Product", ch:"F,D,T",
    riskName:"Insurance — single premium or large lump-sum policy",
    description:"Life insurance single-premium policies are used for ML integration. Red flags: large single premium inconsistent with client income; early policy surrender for cash.",
    pfSanctionsNote:"SOF required for premiums above threshold. Sanctions screening of policy holder and beneficiaries.",
    L:2, C:4,
    existingControls:"SOF required for single premiums above threshold. Beneficiary screening at onboarding. ECDD for high-value policies with suspicious funding patterns.",
    controlIds:["CTRL_CDD_001","CTRL_CDD_010","CTRL_SCR_001"], ctrlFactor:"EW_P_001",
    entities:["Insurance"],
    cond: () => true,
    lMods:[] },

  { sec:"S2", secName:"Designated Service Risks", ref:"P-011", riskType:"Product", ch:"F,D,T",
    riskName:"New or unusual service with no apparent commercial purpose",
    description:"Services requested with no apparent economic or legal purpose are high ML/TF indicators.",
    pfSanctionsNote:"CO approval required before any such service proceeds. Assess for SMR.",
    L:2, C:4,
    existingControls:"CO approval workflow required for all unusual or new services. CRA set to MEDIUM minimum. If no rationale: decline and assess for SMR.",
    controlIds:["CTRL_CDD_004","CTRL_RPT_001"], ctrlFactor:"EW_P_004",
    entities:"ALL",
    cond: a => a.ds_unusual_services === "Yes",
    lMods:[] },

  // S3 — JURISDICTION RISKS
  { sec:"S3", secName:"Jurisdiction Risks", ref:"G-001", riskType:"Jurisdiction", ch:"D,T",
    riskName:"Client or funds connected to a sanctioned country (UHRC)",
    description:"If client, BO, or funds are connected to a DFAT/OFAC/UN-sanctioned country, service must be declined immediately. Criminal offence under Autonomous Sanctions Act 2011.",
    pfSanctionsNote:"Auto-block by dooit CRA engine on UHRC detection. Contact ASO + AFP. SMR mandatory. DO NOT alert client.",
    L:1, C:5,
    existingControls:"UHRC auto-detected in Stage 1 CRA. dooit blocks all service provision. CO notified immediately. Client file locked. SMR assessment mandatory.",
    controlIds:["CTRL_SCR_001","CTRL_SCR_002","CTRL_RPT_001"], ctrlFactor:"EW_G_001",
    entities:"ALL",
    cond: () => true,
    lMods:[] },

  { sec:"S3", secName:"Jurisdiction Risks", ref:"G-002", riskType:"Jurisdiction", ch:"D",
    riskName:"Funds or client from FATF grey-listed or Basel High AML Index country",
    description:"Clients or funds from FATF grey-listed jurisdictions present elevated ML/TF risk. ECDD is mandatory.",
    pfSanctionsNote:"FATF grey-listed jurisdiction: mandatory ECDD. SOF mandatory for all incoming funds.",
    L:2, C:4,
    existingControls:"Stage 1 CRA auto-applies jurisdiction score. HRC/grey-listed = ECDD mandatory. SOF mandatory for all funds from HRC.",
    controlIds:["CTRL_CDD_004","CTRL_CDD_010","CTRL_SCR_001"], ctrlFactor:"EW_G_002",
    entities:"ALL",
    cond: a => a.high_risk_country === "Yes",
    lMods:[{ field:"high_risk_country", test: v => v === "Yes", delta:1 }] },

  { sec:"S3", secName:"Jurisdiction Risks", ref:"G-003", riskType:"Jurisdiction", ch:"D",
    riskName:"International funds transfer — cross-border settlement or payment",
    description:"Settlement or payment funds transferred from overseas accounts introduce foreign ML/TF risk.",
    pfSanctionsNote:"FATF grey-listed jurisdiction: mandatory ECDD. SOF mandatory for all international funds.",
    L:2, C:3,
    existingControls:"CRA triggers ECDD if HRC/FATF grey-listed corridor. SOF mandatory for all international settlement funds.",
    controlIds:["CTRL_CDD_004","CTRL_CDD_010","CTRL_SCR_001"], ctrlFactor:"EW_G_003",
    entities:"ALL",
    cond: a => a.ds_intl_transfers === "Yes",
    lMods:[{ field:"high_risk_country", test: v => v === "Yes", delta:1 }] },

  { sec:"S3", secName:"Jurisdiction Risks", ref:"G-004", riskType:"Jurisdiction", ch:"F,D",
    riskName:"Sanctions screening not yet established",
    description:"Absence of a sanctions screening process means the entity may be providing services to listed parties — a criminal offence under the Autonomous Sanctions Act 2011.",
    pfSanctionsNote:"Immediate sanctions screening process must be established before any new client is onboarded.",
    L:3, C:5,
    existingControls:"dooit sanctions screening integrated with DFAT Consolidated List and OFAC SDN. Automated screening at onboarding and periodic re-screening.",
    controlIds:["CTRL_SCR_001","CTRL_SCR_002"], ctrlFactor:"EW_G_001",
    entities:"ALL",
    cond: a => a.sanctions_screening_confirmed && (a.sanctions_screening_confirmed.includes("Not yet") || a.sanctions_screening_confirmed === "No"),
    lMods:[] },

  // S4 — CHANNEL AND DELIVERY RISKS
  { sec:"S4", secName:"Channel & Delivery Risks", ref:"CH-001", riskType:"Channel", ch:"D,T",
    riskName:"Remote-only client interactions — no face-to-face contact",
    description:"Remote channels reduce the ability to physically verify identity or detect suspicious behaviour.",
    pfSanctionsNote:"Additional verification required for remote-only clients.",
    L:3, C:2,
    existingControls:"Non-face-to-face verification via VOI provider. Additional verification required for high-value matters with remote-only clients.",
    controlIds:["CTRL_CDD_015","CTRL_CDD_019","CTRL_CDD_001"], ctrlFactor:"EW_CH_001",
    entities:"ALL",
    cond: a => a.ch_remote_only === "Yes" || (a.non_f2f_proportion && !a.non_f2f_proportion.includes("Less than")),
    lMods:[{ field:"non_f2f_proportion", test: v => v && v.includes("More than 75%"), delta:1 }] },

  { sec:"S4", secName:"Channel & Delivery Risks", ref:"CH-002", riskType:"Channel", ch:"D,T",
    riskName:"Instructions through third-party agent or intermediary with no direct client contact",
    description:"Third-party channel risk reduces direct oversight of the actual client. Red flags: agent not enrolled with AUSTRAC.",
    pfSanctionsNote:"Sanctions screening on agent. CDD Arrangement required if agent performs any CDD functions.",
    L:2, C:3,
    existingControls:"CRA captures remote purchase + third-party instructions. ECDD if undisclosed third party. CDD Arrangement documented if agent performs any CDD.",
    controlIds:["CTRL_CDD_013","CTRL_CDD_001","CTRL_CDD_004"], ctrlFactor:"EW_CH_002",
    entities:"ALL",
    cond: a => a.ch_third_party_cdd && a.ch_third_party_cdd !== "No",
    lMods:[
      { field:"ch_third_party_cdd", test: v => v && v.includes("without formal"), delta:1 },
      { field:"uses_intermediaries", test: v => v && v.includes("not enrolled"), delta:1 },
    ] },

  { sec:"S4", secName:"Channel & Delivery Risks", ref:"CH-003", riskType:"Channel", ch:"D",
    riskName:"Online platform / API access — automated or programmatic transactions",
    description:"High-volume automated transaction channels reduce human oversight. Red flags: sudden volume spike; scripted transaction patterns.",
    pfSanctionsNote:"Enhanced automated monitoring required. Anomaly detection must be operational.",
    L:3, C:3,
    existingControls:"Automated TM monitoring for all API-sourced transactions. Anomaly detection with configurable thresholds. CO alerts for volume spikes.",
    controlIds:["CTRL_TM_001","CTRL_CH_001","CTRL_CDD_001"], ctrlFactor:"EW_CH_004",
    entities:["Banks & ADIs","Remittance","VASP/DCEP"],
    cond: a => a.delivery_channels && (a.delivery_channels.includes("Online platform") || a.delivery_channels.includes("API")),
    lMods:[] },

  // S5 — CUSTOMER BEHAVIOUR AND TRANSACTION RISKS
  { sec:"S5", secName:"Customer Behaviour & Transaction Risks", ref:"B-001", riskType:"Behaviour", ch:"F,D,T",
    riskName:"Structuring — multiple transactions just below threshold by same client",
    description:"Deliberate splitting of transactions to avoid TTR or CDD thresholds is a criminal offence (s. 142 AML/CTF Act).",
    pfSanctionsNote:"Structuring = criminal offence. Assess for SMR immediately.",
    L:2, C:4,
    existingControls:"TM monitoring for sub-threshold patterns. CO escalation on detection. SMR assessment mandatory. ECDD. CRA updated to High.",
    controlIds:["CTRL_TM_006","CTRL_RPT_001","CTRL_CDD_004"], ctrlFactor:"EW_CH_003",
    entities:"ALL",
    cond: a => a.handles_cash && a.handles_cash !== "No",
    lMods:[{ field:"handles_cash", test: v => v && v.includes("Regularly"), delta:1 }] },

  { sec:"S5", secName:"Customer Behaviour & Transaction Risks", ref:"B-002", riskType:"Behaviour", ch:"F,D",
    riskName:"Client requests rush transaction without standard due diligence period",
    description:"Unusual urgency is a red flag per AUSTRAC starter kit. Criminals use artificial urgency to pressure professionals into skipping CDD steps.",
    pfSanctionsNote:"Do not compromise CDD procedures under any time pressure.",
    L:2, C:3,
    existingControls:"CO maintains CDD procedures regardless of urgency. If client refuses adequate CDD time: CO assesses for SMR. Mandatory CDD steps cannot be waived.",
    controlIds:["CTRL_CDD_021","CTRL_RPT_001"], ctrlFactor:"EW_E_001",
    entities:"ALL",
    cond: () => true,
    lMods:[] },

  { sec:"S5", secName:"Customer Behaviour & Transaction Risks", ref:"B-003", riskType:"Behaviour", ch:"F,D",
    riskName:"Client requests document alteration or omission of parties from records",
    description:"Requests to alter, backdate, or omit information from documents are strong indicators of fraud and ML. Criminal intent is present.",
    pfSanctionsNote:"Potential criminal intent. Assess for SMR immediately. Decline matter.",
    L:1, C:5,
    existingControls:"CO refuses to comply. Matter escalated immediately. SMR assessment mandatory — do not alert client. CO documents all requests and reasons for refusal.",
    controlIds:["CTRL_RPT_001","CTRL_CDD_009"], ctrlFactor:"EW_E_001",
    entities:"ALL",
    cond: () => true,
    lMods:[] },

  { sec:"S5", secName:"Customer Behaviour & Transaction Risks", ref:"B-004", riskType:"Behaviour", ch:"F,D",
    riskName:"Client terminates matter or relationship after CDD is initiated",
    description:"Adverse reaction to CDD — walking away after identity checks are initiated — is a strong ML indicator.",
    pfSanctionsNote:"Assess for SMR regardless of whether the matter was completed.",
    L:2, C:3,
    existingControls:"CO documents the termination and CDD stage reached. CO assesses for SMR based on all known information. Client file retained per 7-year record-keeping obligation.",
    controlIds:["CTRL_RPT_001","CTRL_RK_001"], ctrlFactor:"EW_E_001",
    entities:"ALL",
    cond: () => true,
    lMods:[] },

  // S6 — OPERATIONAL AND COMPLIANCE RISKS
  { sec:"S6", secName:"Operational & Compliance Risks", ref:"O-001", riskType:"Operational", ch:"F,D,T",
    riskName:"LPP interaction with SMR obligation — incorrect decision",
    description:"The interaction between legal professional privilege and the SMR obligation is the most sensitive compliance area for lawyers. Incorrect LPP assessment creates regulatory or professional conduct risk.",
    pfSanctionsNote:"LPP decision documented. LPP Form submitted to AUSTRAC CEO if partial LPP applies.",
    L:2, C:4,
    existingControls:"CO trained on LPP–SMR interaction. CO consults most senior solicitor before invoking LPP. All LPP decisions documented with reasons.",
    controlIds:["CTRL_TRN_006","CTRL_RPT_001","CTRL_RPT_006"], ctrlFactor:"EW_E_003",
    entities:["Lawyers/Conveyancers"],
    cond: () => true,
    lMods:[] },

  { sec:"S6", secName:"Operational & Compliance Risks", ref:"O-002", riskType:"Operational", ch:"F,D,T",
    riskName:"Travel Rule non-compliance — cross-border VA or funds transfer without originator information",
    description:"Failure to comply with the Travel Rule for qualifying transfers exposes the entity to regulatory action.",
    pfSanctionsNote:"Travel Rule is mandatory for all qualifying transfers. Non-compliance = regulatory breach.",
    L:3, C:4,
    existingControls:"Travel Rule controls implemented in dooit. Counterparty VASP/institution FATF compliance check. Transfers without required information are blocked.",
    controlIds:["CTRL_TR_001","CTRL_TR_002","CTRL_RPT_003"], ctrlFactor:"EW_G_003",
    entities:["Banks & ADIs","Remittance","VASP/DCEP"],
    cond: a => a.ds_intl_transfers === "Yes",
    lMods:[] },

  { sec:"S6", secName:"Operational & Compliance Risks", ref:"O-003", riskType:"Operational", ch:"F,D,T",
    riskName:"Failure to lodge Annual Compliance Report by 31 March",
    description:"Failure to lodge Annual Compliance Report with AUSTRAC between 1 January and 31 March is a statutory breach.",
    pfSanctionsNote:"Standard AML/CTF reporting obligation.",
    L:2, C:4,
    existingControls:"dooit compliance calendar auto-schedules Annual Report reminder from 1 January. Escalating notifications through to 31 March deadline.",
    controlIds:["CTRL_RPT_004","CTRL_GOV_007"], ctrlFactor:"EW_E_003",
    entities:"ALL",
    cond: () => true,
    lMods:[] },

  { sec:"S6", secName:"Operational & Compliance Risks", ref:"O-004", riskType:"Operational", ch:"F,D,T",
    riskName:"Failure to conduct independent evaluation within required period",
    description:"Independent evaluation is required at statutory intervals (T2: 3 years; T1: 1–2 years). Failure to arrange is a statutory breach.",
    pfSanctionsNote:"N/A",
    L:2, C:3,
    existingControls:"dooit compliance calendar auto-schedules independent evaluation reminder 90 days before due date. Findings create RAP items in dooit.",
    controlIds:["CTRL_GOV_010","CTRL_GOV_018"], ctrlFactor:"EW_E_003",
    entities:"ALL",
    cond: () => true,
    lMods:[] },

  { sec:"S6", secName:"Operational & Compliance Risks", ref:"O-005", riskType:"Operational", ch:"F,D,T",
    riskName:"AML/CTF training not completed by all relevant staff",
    description:"All relevant staff must complete AML/CTF training before commencement of obligations (T2: 1 July 2026) and annually thereafter.",
    pfSanctionsNote:"N/A",
    L:3, C:3,
    existingControls:"dooit training module tracks completion per staff member. CO notified when induction training not completed within 1 month. Annual refresher tracked. 100% completion target.",
    controlIds:["CTRL_TRN_001","CTRL_TRN_002","CTRL_TRN_009"], ctrlFactor:"EW_E_004",
    entities:"ALL",
    cond: () => true,
    lMods:[] },

  { sec:"S6", secName:"Operational & Compliance Risks", ref:"O-006", riskType:"Operational", ch:"F,D,T",
    riskName:"AML/CTF Program not approved by Governing Body before commencement",
    description:"The Governing Body must approve the AML/CTF Program before commencement (T2: 1 July 2026). Unapproved program = statutory non-compliance.",
    pfSanctionsNote:"N/A",
    L:2, C:4,
    existingControls:"dooit governance module tracks board approval status. CO responsible for presenting Program to Governing Body. Board approval recorded in dooit.",
    controlIds:["CTRL_GOV_001","CTRL_GOV_002"], ctrlFactor:"EW_E_004",
    entities:"ALL",
    cond: () => true,
    lMods:[] },
];

// ── Engine ────────────────────────────────────────────────────────────────────

/**
 * Build scored risk register rows from questionnaire answers + ctrl-eff ratings.
 *
 * @param {object} answers   Keyed by Onboarding_Questions.md maps_to field names
 * @param {object} ctrlEff   { cdd, tm, scr, geo, gov } each 1-5 (default 3)
 * @returns {object[]}       Scored rows (no functions — safe to serialize to JSON/MongoDB)
 */
function buildRiskRegister(answers = {}, ctrlEff = {}) {
  const entityType = answers.entity_type || "Lawyers/Conveyancers";
  const ce = { cdd:3, tm:3, scr:3, geo:3, gov:3, ...ctrlEff };
  const owner = answers.co_name || "AML/CTF CO";
  const prepBy = answers.co_name || "CO";
  const revBy  = answers.sm_name || "CO";

  return RISK_POOL
    .filter(row => {
      if (row.entities !== "ALL" && !row.entities.includes(entityType)) return false;
      return row.cond(answers);
    })
    .map((row, idx) => {
      let L = row.L, C = row.C;
      (row.lMods || []).forEach(mod => {
        const val = answers[mod.field];
        if (val && mod.test(val)) L = Math.min(L + mod.delta, 5);
      });

      const inh  = inherentBand(L, C);        // band code: VL/L/M/H/E
      const cat  = CTRL_CATEGORY[row.ctrlFactor] || "gov";
      const ceV  = ce[cat];
      const res  = residualBand(inh, ceV);    // band code: VL/L/M/H/E

      return {
        rowNum:          idx + 1,
        sec:             row.sec,
        secName:         row.secName,
        ref:             row.ref,
        riskType:        row.riskType,
        ch:              row.ch,
        riskName:        row.riskName,
        description:     row.description,
        pfSanctionsNote: row.pfSanctionsNote,
        L, C,
        inherentRisk:    inh,
        inherentRiskLabel: BAND_LABELS[inh] || inh,
        existingControls: row.existingControls,
        controlIds:      row.controlIds.split(", ").map(s => s.trim()),
        ctrlFactor:      row.ctrlFactor,
        category:        cat,
        controlEffectiveness: ceV,
        residualRisk:    res,
        residualRiskLabel: BAND_LABELS[res] || res,
        actionRequired:  res === "H" || res === "E",
        withinRiskAppetite: !(res === "H" || res === "E"),
        controlsOwner:   owner,
        preparedBy:      prepBy,
        reviewedBy:      revBy,
        status:          "Draft",
      };
    });
}

/**
 * Compute summary statistics for a list of scored rows.
 */
function summarize(rows) {
  const SEV = { VL:0, L:1, M:2, H:3, E:4 };
  const counts = { VL:0, L:0, M:0, H:0, E:0 };
  let overall = "VL";
  rows.forEach(r => {
    if (counts[r.residualRisk] !== undefined) counts[r.residualRisk]++;
    if ((SEV[r.residualRisk] || 0) > (SEV[overall] || 0)) overall = r.residualRisk;
  });
  return {
    rowCount:       rows.length,
    actionCount:    rows.filter(r => r.actionRequired).length,
    overallResidual: overall,
    overallResidualLabel: BAND_LABELS[overall] || overall,
    residualCounts: counts,
  };
}

module.exports = {
  RISK_POOL,
  ENTITY_CONFIG,
  CTRL_CATEGORY,
  buildRiskRegister,
  summarize,
};
