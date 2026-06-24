/**
 * Seed Controls Library — 181 controls across 17 domains
 * Run: node api/scripts/seedControls.js
 */
require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
require("colors");
const Control = require("../models/Control");

const c = (domain, num, title, desc, type, auto, owner, freq, fatf, tags, risk) => ({
  controlId: `CTRL_${domain}_${String(num).padStart(3, "0")}`,
  domain,
  prefix: `CTRL_${domain}`,
  title,
  description: desc,
  controlType: type,
  automationLevel: auto,
  owner,
  testingFrequency: freq,
  fatfRecommendations: fatf,
  industryTags: tags,
  riskMitigationLevel: risk,
  active: true,
});

const controls = [
  // ── GOV: Governance & Board Oversight (20) ────────────────────────────────
  c("GOV",1,"ML/TF Risk Policy Framework","Board-approved policy documenting the entity's approach to managing ML/TF risk in accordance with the AML/CTF Act.","Directive","Manual","Board","Annually",["Rec 1","Rec 2"],["All"],"Critical"),
  c("GOV",2,"Board Risk Appetite Statement","Formal statement defining the entity's tolerance for ML/TF and financial crime risk, reviewed annually by the Board.","Directive","Manual","Board","Annually",["Rec 1","Rec 18"],["All"],"Critical"),
  c("GOV",3,"AML/CTF Program Approval","Board approval of Part A and Part B AML/CTF Program with documented sign-off and version control.","Directive","Manual","Board","Annually",["Rec 18"],["All"],"Critical"),
  c("GOV",4,"Board AML Committee Charter","Documented charter for a Board or Management AML/CTF Committee with defined terms of reference, membership and meeting cadence.","Directive","Manual","Board Chair","Annually",["Rec 18","Rec 26"],["All"],"High"),
  c("GOV",5,"AMLCO Appointment & Independence","Appointment of an AML/CTF Compliance Officer with appropriate seniority, independence, and documented role mandate.","Directive","Manual","CEO","Annually",["Rec 18"],["All"],"Critical"),
  c("GOV",6,"Senior Manager Accountability","Designated senior manager accountability for AML/CTF obligations under the Financial Accountability Regime (FAR).","Directive","Manual","CEO","Annually",["Rec 18","Rec 26"],["All"],"Critical"),
  c("GOV",7,"Annual AML/CTF Compliance Report","Preparation and Board presentation of the Annual Compliance Report covering program adequacy, issues and obligations.","Detective","Manual","CCO","Annually",["Rec 18"],["All"],"High"),
  c("GOV",8,"Three Lines of Defence Model","Documented 3LoD framework assigning AML/CTF responsibilities across business, compliance and internal audit.","Directive","Manual","CRO","Annually",["Rec 18"],["All"],"High"),
  c("GOV",9,"Internal Audit — AML Function","Independent internal audit review of the AML/CTF program at least every 3 years, with findings reported to the Board.","Detective","Manual","Head of Audit","Annually",["Rec 18","Rec 26"],["All"],"High"),
  c("GOV",10,"External Audit — AML Controls","External assurance engagement to validate the design and operating effectiveness of key AML/CTF controls.","Detective","Manual","Head of Audit","Annually",["Rec 26"],["All"],"Medium"),
  c("GOV",11,"Regulatory Change Management","Process to identify, assess and implement changes to AML/CTF legislation and AUSTRAC guidance within defined timeframes.","Preventative","Semi-Automated","CCO","Quarterly",["Rec 2"],["All"],"High"),
  c("GOV",12,"Management Information Reporting","Regular MI pack to the Board/Audit Committee covering STR volumes, CDD backlogs, alert metrics and risk indicators.","Detective","Semi-Automated","CCO","Monthly",["Rec 18"],["All"],"Medium"),
  c("GOV",13,"AML Escalation Framework","Documented escalation matrix for ML/TF concerns from frontline to AMLCO, senior management and Board.","Directive","Manual","CCO","Annually",["Rec 18"],["All"],"High"),
  c("GOV",14,"Whistleblower Policy — AML","Whistleblower protection policy enabling staff to report AML/CTF breaches without fear of retaliation.","Directive","Manual","Company Secretary","Annually",["Rec 18"],["All"],"Medium"),
  c("GOV",15,"Conflict of Interest Policy","Policy identifying and managing conflicts of interest that may impair AML/CTF decision-making or compliance.","Preventative","Manual","CCO","Annually",["Rec 18"],["All"],"Medium"),
  c("GOV",16,"Group AML/CTF Policy Framework","Group-level policy ensuring consistent AML/CTF standards are applied across all subsidiaries and branches.","Directive","Manual","Board","Annually",["Rec 18"],["All"],"High"),
  c("GOV",17,"AUSTRAC Reporting Entity Registration","Ongoing maintenance of AUSTRAC registration including updates to designated services and contact details.","Preventative","Manual","CCO","Annually",["Rec 26"],["All"],"Critical"),
  c("GOV",18,"AML/CTF Program Review Cycle","Scheduled review of the AML/CTF Program triggered by material business change, regulatory update or risk event.","Detective","Manual","CCO","Annually",["Rec 18"],["All"],"High"),
  c("GOV",19,"Sanctions & Penalties Register","Register tracking regulatory actions, infringement notices and enforceable undertakings with remediation status.","Detective","Manual","CCO","Quarterly",["Rec 35"],["All"],"High"),
  c("GOV",20,"AML/CTF Governance Calendar","Annual governance calendar scheduling all Board, committee, audit and regulatory reporting obligations.","Directive","Manual","Company Secretary","Annually",["Rec 18"],["All"],"Medium"),

  // ── CDD: Customer Due Diligence (22) ─────────────────────────────────────
  c("CDD",1,"Customer Identification Procedure","KYC procedure collecting and verifying identity documents for individuals and entities per Part B AML/CTF Program.","Preventative","Semi-Automated","Head of Ops","Monthly",["Rec 10","Rec 17"],["All"],"Critical"),
  c("CDD",2,"Beneficial Owner Identification","Process to identify and verify beneficial owners (≥25% ownership/control) of corporate and trust customers.","Preventative","Manual","Head of Ops","Quarterly",["Rec 10","Rec 24","Rec 25"],["All"],"Critical"),
  c("CDD",3,"Risk-Based Customer Categorisation","Tiered customer risk classification (Low/Medium/High) using risk factors including customer type, geography and products.","Preventative","Semi-Automated","CRO","Quarterly",["Rec 1","Rec 10"],["All"],"Critical"),
  c("CDD",4,"Enhanced Due Diligence (EDD) Triggers","Defined triggers requiring EDD including PEP status, high-risk jurisdiction, high transaction volumes and complex structures.","Preventative","Semi-Automated","CCO","Quarterly",["Rec 10","Rec 12","Rec 19"],["All"],"Critical"),
  c("CDD",5,"Simplified Due Diligence Procedures","SDD applied to verified low-risk customers with documented rationale and periodic review.","Preventative","Manual","Head of Ops","Annually",["Rec 10"],["All"],"Medium"),
  c("CDD",6,"PEP Detection & Screening","Automated screening against PEP lists at onboarding and ongoing, with manual review of positive matches.","Preventative","Fully Automated","CCO","Daily",["Rec 12","Rec 19"],["All"],"Critical"),
  c("CDD",7,"Customer Risk Rating Model","Quantitative risk scoring model assigning risk ratings based on defined factors with documented methodology.","Detective","Semi-Automated","CRO","Quarterly",["Rec 1","Rec 10"],["All"],"Critical"),
  c("CDD",8,"Ongoing CDD — Periodic Review","Periodic CDD review cycle: High-risk annually, Medium-risk every 2 years, Low-risk every 3 years.","Detective","Semi-Automated","Head of Ops","Quarterly",["Rec 10","Rec 11"],["All"],"Critical"),
  c("CDD",9,"Trigger-Based CDD Review","Ad-hoc CDD refresh triggered by suspicious activity, adverse media, sanctions hit or material change in behaviour.","Detective","Semi-Automated","Head of Ops","Monthly",["Rec 10","Rec 11"],["All"],"High"),
  c("CDD",10,"Source of Funds Verification","Verification of the source of funds used in transactions for high-risk customers and PEPs.","Preventative","Manual","Head of Ops","Quarterly",["Rec 10","Rec 12"],["All"],"Critical"),
  c("CDD",11,"Source of Wealth Verification","Verification of the origin of a customer's overall wealth for PEPs and high-risk EDD customers.","Preventative","Manual","CCO","Quarterly",["Rec 10","Rec 12"],["All"],"Critical"),
  c("CDD",12,"Correspondent Banking Due Diligence","Enhanced due diligence on correspondent banking relationships including ownership, regulatory standing and AML controls.","Preventative","Manual","CCO","Annually",["Rec 13"],["Banks"],"Critical"),
  c("CDD",13,"Third-Party Reliance Controls","Documented arrangements where CDD is performed by an eligible third party, including oversight and liability allocation.","Preventative","Manual","CCO","Annually",["Rec 17"],["All"],"High"),
  c("CDD",14,"Customer Acceptance Policy","Board-approved policy defining customer types the entity will and will not accept, including prohibited categories.","Directive","Manual","Board","Annually",["Rec 10"],["All"],"High"),
  c("CDD",15,"Non-Face-to-Face Verification","Additional verification controls for customers onboarded remotely, including digital identity verification requirements.","Preventative","Semi-Automated","Head of Ops","Quarterly",["Rec 10","Rec 15"],["All"],"High"),
  c("CDD",16,"Trust Beneficial Owner Procedures","Specific procedure to identify settlors, trustees, beneficiaries and protectors of trust structures.","Preventative","Manual","Head of Ops","Quarterly",["Rec 10","Rec 25"],["All"],"Critical"),
  c("CDD",17,"Corporate Structure Verification","Process to verify legal ownership structures of corporate customers including subsidiaries and holding entities.","Preventative","Manual","Head of Ops","Quarterly",["Rec 10","Rec 24"],["All"],"High"),
  c("CDD",18,"Shell Company Detection","Controls to identify customers that may be shell companies or complex structures designed to obscure ownership.","Detective","Semi-Automated","CRO","Monthly",["Rec 24","Rec 25"],["All"],"Critical"),
  c("CDD",19,"Digital Identity Verification","Use of approved digital identity verification services (e.g. Document Verification Service) for electronic KYC.","Preventative","Fully Automated","Head of IT","Monthly",["Rec 10","Rec 15"],["All"],"High"),
  c("CDD",20,"Document Authentication Controls","Controls to detect fraudulent or altered identity documents including biometric liveness checks.","Preventative","Semi-Automated","Head of Ops","Quarterly",["Rec 10"],["All"],"High"),
  c("CDD",21,"CDD Waiver / Override Approval","Formal approval process for any waiver or override of standard CDD requirements with documented senior sign-off.","Preventative","Manual","CCO","Monthly",["Rec 10"],["All"],"Critical"),
  c("CDD",22,"CDD Quality Assurance Program","Periodic QA review of CDD files to validate completeness, accuracy and compliance with policy requirements.","Detective","Manual","CCO","Quarterly",["Rec 10","Rec 11"],["All"],"High"),

  // ── SCR: Screening (6) ────────────────────────────────────────────────────
  c("SCR",1,"UN/OFAC Sanctions Screening","Real-time screening of customers and transactions against UN, OFAC, EU and Australian sanctions lists.","Preventative","Fully Automated","CCO","Daily",["Rec 6","Rec 7"],["All"],"Critical"),
  c("SCR",2,"AUSTRAC Designated Person Screening","Screening against AUSTRAC's Designated Persons and Entities list with automated matching and escalation workflow.","Preventative","Fully Automated","CCO","Daily",["Rec 6"],["All"],"Critical"),
  c("SCR",3,"Adverse Media Screening","Negative news and adverse media screening for high-risk customers using automated media monitoring tools.","Detective","Semi-Automated","CCO","Monthly",["Rec 12","Rec 19"],["All"],"High"),
  c("SCR",4,"PEP List Screening","Dedicated PEP list screening at onboarding and ongoing against commercial PEP databases with match review process.","Preventative","Fully Automated","CCO","Daily",["Rec 12"],["All"],"Critical"),
  c("SCR",5,"Real-Time Transaction Screening","Pre-payment screening of transaction parties against sanctions lists before funds are released.","Preventative","Fully Automated","Head of IT","Daily",["Rec 6","Rec 7","Rec 16"],["All"],"Critical"),
  c("SCR",6,"Batch Screening — Existing Customers","Periodic batch re-screening of the full customer base against updated sanctions and PEP lists.","Detective","Fully Automated","CCO","Monthly",["Rec 6","Rec 12"],["All"],"Critical"),

  // ── TM: Transaction Monitoring (20) ──────────────────────────────────────
  c("TM",1,"Automated Transaction Monitoring System","Deployed TMS applying rule-based and/or ML-driven detection to identify suspicious transaction patterns.","Detective","Fully Automated","Head of AML","Daily",["Rec 10","Rec 20"],["All"],"Critical"),
  c("TM",2,"Typology Rule Library Management","Documented library of detection rules mapped to ML/TF typologies, reviewed and updated at least annually.","Preventative","Semi-Automated","Head of AML","Annually",["Rec 20"],["All"],"High"),
  c("TM",3,"Alert Triage & Disposition Process","Defined workflow for TMS alert review, investigation and disposition with documented decision rationale.","Detective","Semi-Automated","Head of AML","Monthly",["Rec 20"],["All"],"Critical"),
  c("TM",4,"False Positive Tuning Controls","Regular review of alert volumes and false positive rates to calibrate detection thresholds without suppressing genuine risk.","Detective","Semi-Automated","Head of AML","Quarterly",["Rec 20"],["All"],"High"),
  c("TM",5,"Threshold Calibration Review","Annual review of monitoring thresholds using historical data, typologies and regulatory guidance.","Detective","Semi-Automated","CRO","Annually",["Rec 20"],["All"],"High"),
  c("TM",6,"Structuring / Smurfing Detection","Rules to detect deliberate structuring of transactions below reporting thresholds to evade detection.","Detective","Fully Automated","Head of AML","Daily",["Rec 10","Rec 20"],["All"],"Critical"),
  c("TM",7,"Rapid Movement of Funds","Detection of funds rapidly moved through accounts (layering) with minimal economic justification.","Detective","Fully Automated","Head of AML","Daily",["Rec 10","Rec 20"],["All"],"Critical"),
  c("TM",8,"Unusual Geographic Transactions","Monitoring for transactions involving high-risk jurisdictions or inconsistent with customer geographic profile.","Detective","Fully Automated","Head of AML","Daily",["Rec 10","Rec 19"],["All"],"High"),
  c("TM",9,"Cash Intensity Monitoring","Detection of unusual cash transaction volumes or patterns relative to customer profile and industry norms.","Detective","Fully Automated","Head of AML","Daily",["Rec 10","Rec 20"],["Banks","Remittance"],"Critical"),
  c("TM",10,"Peer Group Benchmarking","Comparison of customer transaction behaviour against peer group norms to identify outliers.","Detective","AI-Powered","Head of AML","Monthly",["Rec 20"],["All"],"High"),
  c("TM",11,"Network Analysis — Linked Accounts","Detection of suspicious transaction networks involving multiple linked accounts or related parties.","Detective","AI-Powered","Head of AML","Monthly",["Rec 20"],["All"],"High"),
  c("TM",12,"Dormant Account Reactivation","Monitoring for reactivation of dormant accounts with immediate high-value or unusual transaction activity.","Detective","Fully Automated","Head of AML","Daily",["Rec 10","Rec 20"],["Banks"],"High"),
  c("TM",13,"High-Risk Product Monitoring","Enhanced monitoring applied to designated high-risk products (e.g. international wires, crypto, bearer instruments).","Detective","Fully Automated","Head of AML","Daily",["Rec 15","Rec 20"],["All"],"Critical"),
  c("TM",14,"International Wire Transfer Monitoring","Monitoring of cross-border wire transfers for IFTI compliance, sanctions screening and ML/TF indicators.","Detective","Fully Automated","Head of AML","Daily",["Rec 16","Rec 20"],["Banks","Remittance"],"Critical"),
  c("TM",15,"Cryptocurrency / VASP Monitoring","Transaction monitoring for virtual asset transactions including wallet screening and chain analysis integration.","Detective","Fully Automated","Head of AML","Daily",["Rec 15","Rec 20"],["VASPs"],"Critical"),
  c("TM",16,"Trade Finance Monitoring","Detection of trade-based ML indicators including over/under-invoicing, phantom shipments and multiple invoicing.","Detective","Semi-Automated","Head of AML","Monthly",["Rec 14","Rec 20"],["Banks"],"High"),
  c("TM",17,"Real Estate Transaction Monitoring","Monitoring of real estate settlement transactions for round-sum payments, third-party payments and unusual structures.","Detective","Semi-Automated","Head of AML","Monthly",["Rec 22"],["Real Estate","Lawyers"],"Critical"),
  c("TM",18,"Internal Transfer Monitoring","Monitoring of internal account-to-account transfers for unusual patterns or circumvention of controls.","Detective","Fully Automated","Head of AML","Daily",["Rec 20"],["Banks"],"High"),
  c("TM",19,"Correspondent Banking Monitoring","Enhanced transaction monitoring for transactions processed through or for correspondent banking relationships.","Detective","Fully Automated","Head of AML","Daily",["Rec 13","Rec 20"],["Banks"],"Critical"),
  c("TM",20,"STR Escalation from TM Alerts","Defined process for escalating TMS alerts to the AMLCO for SMR/STR consideration with SLA timelines.","Detective","Semi-Automated","Head of AML","Monthly",["Rec 20","Rec 29"],["All"],"Critical"),

  // ── RPT: Reporting (10) ───────────────────────────────────────────────────
  c("RPT",1,"Suspicious Matter Report (SMR) Filing","End-to-end process for preparing, authorising and lodging SMRs with AUSTRAC within required timeframes.","Detective","Semi-Automated","CCO","Monthly",["Rec 20","Rec 29"],["All"],"Critical"),
  c("RPT",2,"Threshold Transaction Report (TTR) Filing","Automated identification and lodgement of TTRs for cash transactions ≥AUD10,000 within required timeframes.","Detective","Fully Automated","CCO","Daily",["Rec 29"],["Banks","Remittance","Casinos"],"Critical"),
  c("RPT",3,"International Funds Transfer Instruction (IFTI)","Automated lodgement of IFTIs for international electronic funds transfers within 10 business days.","Detective","Fully Automated","CCO","Daily",["Rec 16","Rec 29"],["Banks","Remittance"],"Critical"),
  c("RPT",4,"AML/CTF Compliance Report (ACR)","Annual submission of AML/CTF Compliance Report to AUSTRAC via the AUSTRAC Online portal.","Detective","Manual","CCO","Annually",["Rec 29"],["All"],"Critical"),
  c("RPT",5,"AUSTRAC Portal Access Management","Management of AUSTRAC Online user access, roles and credentials with annual access review.","Preventative","Manual","CCO","Annually",["Rec 29"],["All"],"High"),
  c("RPT",6,"SMR Triage & Authorisation","Defined authorisation hierarchy for SMR sign-off (AMLCO and/or senior manager) before submission.","Preventative","Manual","CCO","Monthly",["Rec 29"],["All"],"Critical"),
  c("RPT",7,"SMR Timeliness Controls","Controls to ensure SMRs are lodged as soon as practicable and within AUSTRAC guidance timeframes.","Detective","Semi-Automated","CCO","Monthly",["Rec 29"],["All"],"Critical"),
  c("RPT",8,"Report Quality Assurance","QA review of regulatory reports (TTR, IFTI, SMR) for accuracy, completeness and narrative quality.","Detective","Manual","CCO","Quarterly",["Rec 29"],["All"],"High"),
  c("RPT",9,"Cross-Border Currency Reporting","Controls for identifying and reporting cross-border movement of physical currency ≥AUD10,000.","Detective","Semi-Automated","Head of Ops","Monthly",["Rec 29","Rec 32"],["Banks","Remittance","Casinos"],"High"),
  c("RPT",10,"Regulatory Correspondence Management","Management of all AUSTRAC notices, requests and voluntary disclosures with documented response tracking.","Directive","Manual","CCO","Quarterly",["Rec 29","Rec 35"],["All"],"High"),

  // ── RA: Risk Assessment (12) ──────────────────────────────────────────────
  c("RA",1,"Enterprise-Wide Risk Assessment (EWRA)","Documented EWRA covering all ML/TF risk factors across customers, products, services, channels and geographies.","Detective","Semi-Automated","CRO","Annually",["Rec 1","Rec 2"],["All"],"Critical"),
  c("RA",2,"ML/TF Risk Factor Assessment","Structured assessment of each risk factor (customer type, product, channel, geography) with inherent risk scoring.","Detective","Semi-Automated","CRO","Annually",["Rec 1"],["All"],"Critical"),
  c("RA",3,"Inherent Risk Scoring Framework","Documented methodology for scoring inherent risk using 5×5 likelihood × impact matrix.","Directive","Manual","CRO","Annually",["Rec 1"],["All"],"High"),
  c("RA",4,"Control Effectiveness Assessment","Assessment of control design and operating effectiveness (rated 1–5) used to calculate residual risk.","Detective","Manual","CRO","Annually",["Rec 1"],["All"],"Critical"),
  c("RA",5,"Residual Risk Calculation","Calculation of residual risk = inherent risk × (1 – control effectiveness/5), benchmarked against NRA floor.","Detective","Semi-Automated","CRO","Annually",["Rec 1","Rec 2"],["All"],"Critical"),
  c("RA",6,"NRA Baseline Integration","Integration of AUSTRAC National Risk Assessment sector risk ratings as floor for entity residual risk.","Directive","Manual","CRO","Annually",["Rec 1","Rec 2"],["All"],"High"),
  c("RA",7,"Risk Assessment Update Triggers","Defined triggers requiring EWRA update: material business change, new product/service, regulatory guidance update.","Preventative","Manual","CRO","Quarterly",["Rec 1"],["All"],"High"),
  c("RA",8,"Business Risk Assessment by Product","Granular risk assessment at product and service level identifying specific ML/TF vulnerabilities.","Detective","Manual","CRO","Annually",["Rec 1"],["All"],"High"),
  c("RA",9,"New Product / Service Risk Assessment","Mandatory risk assessment prior to launch of any new product, service or delivery channel.","Preventative","Manual","CRO","Quarterly",["Rec 1","Rec 15"],["All"],"Critical"),
  c("RA",10,"Country & Jurisdiction Risk Rating","Maintained country risk rating matrix incorporating FATF status, corruption indices and typology data.","Detective","Semi-Automated","CRO","Quarterly",["Rec 1","Rec 19"],["All"],"High"),
  c("RA",11,"Risk Assessment Documentation Standards","Standards for documenting risk assessments including methodology, assumptions, evidence and sign-off requirements.","Directive","Manual","CRO","Annually",["Rec 1"],["All"],"Medium"),
  c("RA",12,"Risk Appetite Alignment Review","Annual review to ensure risk assessment outcomes are aligned with Board-approved risk appetite thresholds.","Detective","Manual","CRO","Annually",["Rec 1","Rec 2"],["All"],"High"),

  // ── TECH: Technology Controls (20) ───────────────────────────────────────
  c("TECH",1,"AML System Access Controls","Role-based access controls for AML systems with quarterly access reviews and segregation of duties.","Preventative","Semi-Automated","Head of IT","Quarterly",["Rec 15","Rec 18"],["All"],"High"),
  c("TECH",2,"System Change Management — AML","Change management process for AML system changes including impact assessment, testing and approval gates.","Preventative","Semi-Automated","Head of IT","Monthly",["Rec 15"],["All"],"High"),
  c("TECH",3,"Data Quality Management","Controls to ensure completeness, accuracy and timeliness of data feeding AML detection systems.","Preventative","Semi-Automated","Head of IT","Monthly",["Rec 15"],["All"],"Critical"),
  c("TECH",4,"AML System Availability & DR","Disaster recovery controls ensuring AML monitoring and reporting systems meet defined RTO/RPO targets.","Preventative","Semi-Automated","Head of IT","Annually",["Rec 15"],["All"],"High"),
  c("TECH",5,"API Security Controls","Security controls for all APIs connecting AML systems including authentication, rate limiting and input validation.","Preventative","Semi-Automated","Head of IT","Quarterly",["Rec 15"],["All"],"High"),
  c("TECH",6,"AML Vendor Management","Vendor due diligence and ongoing oversight of third-party AML system providers and data vendors.","Preventative","Manual","Head of IT","Annually",["Rec 17"],["All"],"High"),
  c("TECH",7,"Automated AML Workflow Controls","Automated workflow controls for CDD, alert management and STR processes to ensure completeness and auditability.","Preventative","Fully Automated","Head of IT","Monthly",["Rec 15"],["All"],"High"),
  c("TECH",8,"Audit Trail & System Logging","Immutable audit logs capturing all AML system actions, user activities and data changes for forensic use.","Detective","Fully Automated","Head of IT","Monthly",["Rec 11","Rec 15"],["All"],"Critical"),
  c("TECH",9,"Batch Processing Controls","Controls over batch processing of customer data, transaction files and regulatory reports including reconciliation.","Preventative","Semi-Automated","Head of IT","Monthly",["Rec 15"],["All"],"High"),
  c("TECH",10,"Data Retention & Archiving","Technical controls ensuring AML records are retained for minimum 7 years and are retrievable within required timeframes.","Preventative","Fully Automated","Head of IT","Annually",["Rec 11"],["All"],"High"),
  c("TECH",11,"System Integration Testing","Regression and integration testing for AML system updates including TMS rules changes and CDD system changes.","Preventative","Semi-Automated","Head of IT","Monthly",["Rec 15"],["All"],"Medium"),
  c("TECH",12,"Penetration Testing — AML Systems","Annual penetration testing of AML systems and supporting infrastructure by qualified third-party assessors.","Detective","Manual","CISO","Annually",["Rec 15"],["All"],"High"),
  c("TECH",13,"AI/ML Model Governance","Model risk management framework for AI/ML models used in AML detection including validation, monitoring and explainability.","Preventative","Semi-Automated","CRO","Quarterly",["Rec 1","Rec 15"],["All"],"Critical"),
  c("TECH",14,"RegTech Tool Assessment","Assessment framework for evaluating and onboarding new regulatory technology tools used in AML/CTF compliance.","Preventative","Manual","CCO","Annually",["Rec 15"],["All"],"Medium"),
  c("TECH",15,"Data Masking & Anonymisation","Technical controls to mask or anonymise sensitive personal data used in AML analytics and testing environments.","Preventative","Fully Automated","Head of IT","Quarterly",["Rec 15"],["All"],"Medium"),
  c("TECH",16,"Cloud Security Controls","Cloud-specific security controls for AML workloads including data residency, encryption and shared responsibility management.","Preventative","Semi-Automated","CISO","Quarterly",["Rec 15"],["All"],"High"),
  c("TECH",17,"User Acceptance Testing (UAT)","UAT process for AML system changes with documented test cases, sign-off and defect management.","Preventative","Manual","Head of IT","Monthly",["Rec 15"],["All"],"Medium"),
  c("TECH",18,"Production Deployment Controls","Controlled deployment process for AML system changes with rollback capability and post-deployment verification.","Preventative","Semi-Automated","Head of IT","Monthly",["Rec 15"],["All"],"High"),
  c("TECH",19,"Software Development Lifecycle Security","Security-by-design controls integrated into the SDLC for any internally developed AML/CTF software.","Preventative","Semi-Automated","Head of IT","Quarterly",["Rec 15"],["All"],"High"),
  c("TECH",20,"Technology Risk Assessment — AML","Annual technology risk assessment covering AML systems, data flows, integrations and dependencies.","Detective","Manual","CRO","Annually",["Rec 1","Rec 15"],["All"],"High"),

  // ── FRD: Fraud Prevention (24) ────────────────────────────────────────────
  c("FRD",1,"Fraud Detection Rules Engine","Rule-based fraud detection covering payment fraud, ATO, identity fraud and internal fraud typologies.","Detective","Fully Automated","Head of Fraud","Daily",["Rec 1"],["All"],"Critical"),
  c("FRD",2,"Account Takeover (ATO) Detection","Real-time detection of account takeover attempts using behavioural analytics, device intelligence and anomaly detection.","Detective","AI-Powered","Head of Fraud","Daily",["Rec 10"],["Banks","Fintechs"],"Critical"),
  c("FRD",3,"Identity Fraud Detection","Controls to detect synthetic identity and identity theft at onboarding and during account lifecycle.","Preventative","Semi-Automated","Head of Fraud","Monthly",["Rec 10"],["All"],"Critical"),
  c("FRD",4,"Payment Fraud Monitoring","Real-time monitoring of payment transactions for fraud indicators including unusual payees, amounts and timing.","Detective","Fully Automated","Head of Fraud","Daily",["Rec 10"],["Banks","Fintechs"],"Critical"),
  c("FRD",5,"Card-Not-Present (CNP) Fraud Controls","Controls for CNP fraud including 3DS2 authentication, velocity checks and behavioural biometrics.","Preventative","Fully Automated","Head of Fraud","Daily",["Rec 10"],["Banks","Fintechs"],"High"),
  c("FRD",6,"First-Party Fraud Detection","Detection of customers intentionally defaulting on obligations or misrepresenting financial circumstances.","Detective","AI-Powered","Head of Fraud","Monthly",["Rec 10"],["Banks","Fintechs"],"High"),
  c("FRD",7,"Social Engineering Awareness Controls","Technical and process controls to detect and prevent social engineering attacks targeting customers and staff.","Preventative","Semi-Automated","Head of Fraud","Monthly",["Rec 10"],["All"],"High"),
  c("FRD",8,"Mule Account Detection","Detection of accounts being used as money mule accounts based on behavioural and transactional indicators.","Detective","AI-Powered","Head of AML","Daily",["Rec 10","Rec 20"],["Banks","Fintechs"],"Critical"),
  c("FRD",9,"Impersonation Fraud Detection","Detection of impersonation scams including authorised push payment (APP) fraud indicators.","Detective","Semi-Automated","Head of Fraud","Daily",["Rec 10"],["Banks","Fintechs"],"High"),
  c("FRD",10,"Invoice / BEC Fraud Controls","Controls to prevent Business Email Compromise and invoice fraud including payment verification callbacks.","Preventative","Semi-Automated","Head of Fraud","Monthly",["Rec 10"],["All"],"High"),
  c("FRD",11,"Internal Fraud Detection","Controls to detect fraud committed by employees including unusual access patterns, overrides and transaction manipulation.","Detective","Semi-Automated","Head of Audit","Monthly",["Rec 18"],["All"],"Critical"),
  c("FRD",12,"Application Fraud Screening","Pre-approval screening for fraudulent applications using credit bureau data, identity verification and fraud databases.","Preventative","Fully Automated","Head of Fraud","Daily",["Rec 10"],["Banks","Fintechs"],"High"),
  c("FRD",13,"Device Fingerprinting Controls","Device intelligence controls identifying high-risk or known-fraud devices at login and transaction initiation.","Detective","Fully Automated","Head of IT","Daily",["Rec 15"],["Banks","Fintechs"],"High"),
  c("FRD",14,"IP Reputation & Geolocation Controls","IP-based controls detecting access from high-risk locations, VPNs, Tor nodes or known fraud infrastructure.","Detective","Fully Automated","Head of IT","Daily",["Rec 15"],["Banks","Fintechs"],"High"),
  c("FRD",15,"Behavioural Biometrics","Continuous authentication using keystroke dynamics, mouse movement and navigation patterns to detect account compromise.","Detective","AI-Powered","Head of IT","Daily",["Rec 15"],["Banks","Fintechs"],"High"),
  c("FRD",16,"Step-Up Authentication","Risk-based step-up authentication for high-risk transactions including OTP, biometric and knowledge-based verification.","Preventative","Fully Automated","Head of IT","Monthly",["Rec 15"],["All"],"High"),
  c("FRD",17,"Fraud Case Management","End-to-end fraud case management system tracking investigations, losses, recoveries and regulatory notifications.","Detective","Semi-Automated","Head of Fraud","Monthly",["Rec 20"],["All"],"High"),
  c("FRD",18,"Fraud Loss Recovery Procedures","Procedures for recovering fraud losses including chargebacks, legal recovery and insurance claims.","Corrective","Manual","Head of Fraud","Quarterly",["Rec 20"],["All"],"Medium"),
  c("FRD",19,"Third-Party Fraud Controls","Due diligence and monitoring controls for third-party introducers and agents to prevent fraud facilitation.","Preventative","Manual","Head of Fraud","Quarterly",["Rec 17"],["All"],"High"),
  c("FRD",20,"Chargeback Management","Chargeback processing controls including dispute management, merchant monitoring and excessive chargeback detection.","Corrective","Semi-Automated","Head of Ops","Monthly",["Rec 10"],["Banks","Fintechs"],"Medium"),
  c("FRD",21,"Fraud Analytics — ML Models","Machine learning models for real-time fraud scoring with model governance, monitoring and retraining controls.","Detective","AI-Powered","Head of Fraud","Monthly",["Rec 1","Rec 15"],["Banks","Fintechs"],"High"),
  c("FRD",22,"Return / Reversal Fraud Monitoring","Detection of fraudulent use of refunds, reversals and chargebacks to extract funds from accounts.","Detective","Fully Automated","Head of Fraud","Daily",["Rec 10"],["Banks","Fintechs"],"High"),
  c("FRD",23,"Scam Disruption Controls","Proactive controls to disrupt and prevent scam payments including confirmation of payee and payment delay windows.","Preventative","Semi-Automated","Head of Fraud","Monthly",["Rec 10"],["Banks","Fintechs"],"Critical"),
  c("FRD",24,"Fraud Reporting to Regulators","Process for reporting fraud to AFCA, ACSC, AFP and other relevant authorities within required timeframes.","Detective","Manual","CCO","Quarterly",["Rec 29"],["All"],"High"),

  // ── CYB: Cyber Security (18 representative) ───────────────────────────────
  c("CYB",1,"Vulnerability Management Program","Continuous vulnerability scanning, risk-based prioritisation and remediation tracking across all AML-connected systems.","Preventative","Semi-Automated","CISO","Monthly",["Rec 15"],["All"],"Critical"),
  c("CYB",2,"Patch Management Controls","Documented patch management process with defined remediation SLAs (Critical: 48h, High: 7d, Medium: 30d).","Preventative","Semi-Automated","CISO","Monthly",["Rec 15"],["All"],"Critical"),
  c("CYB",3,"Penetration Testing Program","Annual external penetration testing of all internet-facing and AML-critical systems by certified testers.","Detective","Manual","CISO","Annually",["Rec 15"],["All"],"High"),
  c("CYB",4,"Network Segmentation Controls","Network segmentation isolating AML systems from general corporate networks using firewalls and VLANs.","Preventative","Semi-Automated","CISO","Quarterly",["Rec 15"],["All"],"High"),
  c("CYB",5,"Identity & Access Management (IAM)","Centralised IAM platform enforcing least-privilege access, JIT provisioning and automated deprovisioning.","Preventative","Fully Automated","CISO","Monthly",["Rec 15"],["All"],"Critical"),
  c("CYB",6,"Privileged Access Management (PAM)","PAM solution controlling and auditing privileged access to AML systems, databases and infrastructure.","Preventative","Fully Automated","CISO","Monthly",["Rec 15"],["All"],"Critical"),
  c("CYB",7,"Multi-Factor Authentication (MFA)","MFA enforced for all access to AML systems, remote access and privileged accounts.","Preventative","Fully Automated","CISO","Quarterly",["Rec 15"],["All"],"Critical"),
  c("CYB",8,"Security Information & Event Management","SIEM platform aggregating logs from AML systems, providing real-time alerting and forensic capability.","Detective","Fully Automated","CISO","Monthly",["Rec 15"],["All"],"High"),
  c("CYB",9,"Data Loss Prevention (DLP)","DLP controls preventing unauthorised exfiltration of AML data, customer PII and SMR content.","Preventative","Fully Automated","CISO","Monthly",["Rec 15"],["All"],"High"),
  c("CYB",10,"Encryption at Rest","AES-256 encryption of all AML data at rest including databases, backups and archived records.","Preventative","Fully Automated","CISO","Annually",["Rec 15"],["All"],"High"),
  c("CYB",11,"Encryption in Transit","TLS 1.2+ enforced for all data transmission between AML systems, APIs and regulatory portals.","Preventative","Fully Automated","CISO","Quarterly",["Rec 15"],["All"],"High"),
  c("CYB",12,"Endpoint Detection & Response (EDR)","EDR solution deployed on all endpoints accessing AML systems with real-time threat detection and response.","Detective","Fully Automated","CISO","Monthly",["Rec 15"],["All"],"High"),
  c("CYB",13,"Phishing Prevention Controls","Email security gateway, phishing simulation training and DMARC/SPF/DKIM controls to prevent phishing attacks.","Preventative","Semi-Automated","CISO","Monthly",["Rec 15"],["All"],"High"),
  c("CYB",14,"Cyber Incident Response Plan","Documented incident response plan for cyber events affecting AML systems with tested playbooks and escalation procedures.","Corrective","Manual","CISO","Annually",["Rec 15"],["All"],"Critical"),
  c("CYB",15,"Backup & Recovery Controls","Regular backups of AML systems and data with documented RTO/RPO targets and annual recovery testing.","Corrective","Fully Automated","CISO","Monthly",["Rec 15"],["All"],"High"),
  c("CYB",16,"Threat Intelligence Program","Subscription to threat intelligence feeds relevant to financial sector threats with integration into security controls.","Detective","Semi-Automated","CISO","Monthly",["Rec 15"],["All"],"High"),
  c("CYB",17,"Cloud Security Posture Management","CSPM tooling continuously monitoring cloud environments hosting AML workloads for misconfigurations and policy violations.","Detective","Fully Automated","CISO","Monthly",["Rec 15"],["All"],"High"),
  c("CYB",18,"Cyber Security Awareness Training","Mandatory annual cyber security training for all staff with role-specific modules for AML system users.","Preventative","Semi-Automated","CISO","Annually",["Rec 15"],["All"],"Medium"),

  // ── PRV: Privacy (12 representative) ─────────────────────────────────────
  c("PRV",1,"Privacy Policy & Customer Notice","Publicly available Privacy Policy and Collection Notice meeting Australian Privacy Principles (APP 1, APP 5).","Directive","Manual","CCO","Annually",[],["All"],"High"),
  c("PRV",2,"Data Classification Framework","Documented data classification scheme (Public/Internal/Confidential/Restricted) applied to all AML and customer data.","Directive","Manual","CISO","Annually",[],["All"],"High"),
  c("PRV",3,"Privacy Impact Assessment (PIA)","Mandatory PIA for new AML systems, data collections or significant changes involving personal information.","Preventative","Manual","CCO","Quarterly",[],["All"],"High"),
  c("PRV",4,"Data Subject Access Request Process","End-to-end DSAR process meeting 30-day response requirement under the Privacy Act 1988.","Corrective","Semi-Automated","CCO","Monthly",[],["All"],"High"),
  c("PRV",5,"Data Breach Notification Procedure","Notifiable Data Breach (NDB) scheme procedure with 30-day assessment window and OAIC notification controls.","Corrective","Manual","CCO","Quarterly",[],["All"],"Critical"),
  c("PRV",6,"Consent Management Controls","Technical controls managing customer consent for data collection, use and disclosure with documented consent records.","Preventative","Semi-Automated","Head of IT","Quarterly",[],["All"],"High"),
  c("PRV",7,"Data Minimisation Controls","Controls to ensure only minimum necessary personal data is collected and retained for AML/CTF purposes.","Preventative","Manual","CCO","Annually",[],["All"],"Medium"),
  c("PRV",8,"Cross-Border Data Transfer Controls","Controls for cross-border disclosure of personal data including APP 8 compliant contractual arrangements.","Preventative","Manual","CCO","Annually",[],["All"],"High"),
  c("PRV",9,"Data Retention & Destruction Policy","Policy and technical controls for retention and secure destruction of personal data per AML/CTF Act requirements.","Preventative","Semi-Automated","Head of IT","Annually",["Rec 11"],["All"],"High"),
  c("PRV",10,"Third-Party Privacy Due Diligence","Privacy due diligence on third-party processors handling AML customer data including contractual controls.","Preventative","Manual","CCO","Annually",[],["All"],"High"),
  c("PRV",11,"Privacy by Design Framework","Framework ensuring privacy considerations are integrated into AML system and process design from inception.","Preventative","Manual","CCO","Annually",[],["All"],"Medium"),
  c("PRV",12,"Privacy Audit & Compliance Review","Annual privacy compliance review assessing adherence to APPs, NDB scheme and cross-border transfer requirements.","Detective","Manual","Head of Audit","Annually",[],["All"],"High"),

  // ── TRN: Training (14) ────────────────────────────────────────────────────
  c("TRN",1,"AML/CTF Induction Training","Mandatory AML/CTF induction training for all new staff within 30 days of commencement covering obligations and red flags.","Preventative","Semi-Automated","Head of HR","Monthly",["Rec 18"],["All"],"Critical"),
  c("TRN",2,"Annual AML/CTF Refresher Training","Annual AML/CTF refresher training for all staff including updated typologies, regulatory changes and case studies.","Preventative","Semi-Automated","Head of HR","Annually",["Rec 18"],["All"],"Critical"),
  c("TRN",3,"Role-Specific AML Training","Tailored AML training modules for high-risk roles (CDD analysts, AMLCO, relationship managers, frontline tellers).","Preventative","Semi-Automated","CCO","Annually",["Rec 18"],["All"],"High"),
  c("TRN",4,"PEP & Sanctions Training","Specific training on PEP identification, sanctions screening procedures and escalation for relevant staff.","Preventative","Semi-Automated","CCO","Annually",["Rec 12","Rec 18"],["All"],"High"),
  c("TRN",5,"Transaction Monitoring Training","Training for TMS analysts on alert review methodology, typologies, investigation techniques and SMR writing.","Preventative","Semi-Automated","Head of AML","Annually",["Rec 18","Rec 20"],["All"],"High"),
  c("TRN",6,"SMR Preparation Training","Training on SMR preparation standards, narrative writing, authorisation process and AUSTRAC submission.","Preventative","Manual","CCO","Annually",["Rec 18","Rec 29"],["All"],"Critical"),
  c("TRN",7,"Emerging Typologies Training","Periodic training on new and emerging ML/TF typologies based on FATF, AUSTRAC and industry guidance.","Preventative","Semi-Automated","CCO","Quarterly",["Rec 18"],["All"],"High"),
  c("TRN",8,"AML Awareness Campaigns","Ongoing internal communications and awareness campaigns to maintain AML culture across the organisation.","Preventative","Manual","CCO","Quarterly",["Rec 18"],["All"],"Medium"),
  c("TRN",9,"Training Completion Tracking","System tracking training completion rates by business unit with escalation for non-completion within 30 days.","Detective","Fully Automated","Head of HR","Monthly",["Rec 18"],["All"],"High"),
  c("TRN",10,"Training Effectiveness Assessment","Assessment mechanism (quiz, scenario, observation) measuring knowledge retention and competency after training.","Detective","Semi-Automated","CCO","Annually",["Rec 18"],["All"],"High"),
  c("TRN",11,"Third-Party & Contractor Training","AML training requirements for contractors, agents and third parties with access to AML systems or customer data.","Preventative","Manual","CCO","Annually",["Rec 17","Rec 18"],["All"],"High"),
  c("TRN",12,"Board AML Awareness Briefing","Annual Board briefing on AML/CTF regulatory developments, typologies, assessment outcomes and program performance.","Preventative","Manual","CCO","Annually",["Rec 18","Rec 26"],["All"],"High"),
  c("TRN",13,"Customer-Facing Staff Training","Specialised training for branch and relationship management staff on identifying and responding to suspicious customer behaviour.","Preventative","Semi-Automated","Head of HR","Annually",["Rec 18"],["All"],"High"),
  c("TRN",14,"Training Records Management","Maintenance of training completion records for minimum 7 years per AML/CTF Act record-keeping requirements.","Directive","Semi-Automated","Head of HR","Annually",["Rec 11","Rec 18"],["All"],"Medium"),

  // ── RK: Record Keeping (10) ───────────────────────────────────────────────
  c("RK",1,"Customer Record Retention Policy","Policy requiring retention of all KYC and CDD records for 7 years from end of customer relationship.","Directive","Manual","CCO","Annually",["Rec 11"],["All"],"Critical"),
  c("RK",2,"Transaction Record Retention","Retention of transaction records (date, amount, parties, instructions) for minimum 7 years.","Directive","Fully Automated","Head of IT","Annually",["Rec 11"],["All"],"Critical"),
  c("RK",3,"CDD Document Storage","Secure storage of customer identity documents (originals or certified copies) with access controls and retrieval procedures.","Preventative","Semi-Automated","Head of IT","Annually",["Rec 11"],["All"],"Critical"),
  c("RK",4,"SMR/STR Report Archival","Archival of all submitted SMRs and supporting investigation files for minimum 7 years.","Directive","Fully Automated","CCO","Annually",["Rec 11","Rec 29"],["All"],"Critical"),
  c("RK",5,"AML Program Documentation","Retention of AML/CTF program versions, board approvals, risk assessments and supporting documentation.","Directive","Manual","CCO","Annually",["Rec 11","Rec 18"],["All"],"High"),
  c("RK",6,"Audit Trail Retention","Retention of system audit logs for AML platforms for minimum 7 years with integrity controls.","Directive","Fully Automated","Head of IT","Annually",["Rec 11"],["All"],"High"),
  c("RK",7,"Physical Record Security","Physical security controls for paper-based AML records including locked storage, access registers and fire/flood protection.","Preventative","Manual","Head of Ops","Annually",["Rec 11"],["All"],"Medium"),
  c("RK",8,"Electronic Records Management System","EDRMS ensuring AML records are stored, indexed, version-controlled and retrievable within regulatory timeframes.","Preventative","Fully Automated","Head of IT","Annually",["Rec 11"],["All"],"High"),
  c("RK",9,"Record Retrieval Procedures","Documented procedures for producing AML records in response to AUSTRAC notices or law enforcement requests.","Directive","Manual","CCO","Annually",["Rec 11","Rec 29"],["All"],"Critical"),
  c("RK",10,"Record Destruction Controls","Controlled destruction of AML records after retention period with documented destruction registers and authorisation.","Preventative","Manual","Head of IT","Annually",["Rec 11"],["All"],"Medium"),

  // ── OUT: Outsourcing (10) ─────────────────────────────────────────────────
  c("OUT",1,"Outsourcing Risk Assessment","Risk assessment of proposed outsourcing arrangements evaluating ML/TF risk, data security and regulatory compliance impact.","Preventative","Manual","CRO","Annually",["Rec 17","Rec 18"],["All"],"High"),
  c("OUT",2,"Third-Party AML Due Diligence","Due diligence on outsourced service providers covering AML program, regulatory status and control environment.","Preventative","Manual","CCO","Annually",["Rec 17"],["All"],"High"),
  c("OUT",3,"Outsourcing SLA — AML Terms","Service level agreements with outsourced providers including AML-specific obligations, audit rights and breach procedures.","Directive","Manual","CCO","Annually",["Rec 17"],["All"],"High"),
  c("OUT",4,"Outsourcing Register","Central register of all material outsourcing arrangements including AML functions with risk classification and review dates.","Detective","Manual","CRO","Annually",["Rec 17"],["All"],"Medium"),
  c("OUT",5,"Third-Party Ongoing Monitoring","Ongoing monitoring of outsourced providers including performance reviews, incident reporting and annual re-assessment.","Detective","Manual","CCO","Quarterly",["Rec 17"],["All"],"High"),
  c("OUT",6,"Sub-Agent Oversight Controls","Oversight framework for remittance sub-agents and agents including registration verification, training and site audits.","Detective","Manual","CCO","Quarterly",["Rec 17"],["Remittance"],"Critical"),
  c("OUT",7,"Technology Vendor Assessment","Security and operational assessment of technology vendors with access to AML systems or customer data.","Preventative","Manual","CISO","Annually",["Rec 15","Rec 17"],["All"],"High"),
  c("OUT",8,"Contract Review — AML Obligations","Review of all material contracts to ensure AML/CTF obligations, audit rights and regulatory cooperation clauses are included.","Preventative","Manual","CCO","Annually",["Rec 17"],["All"],"High"),
  c("OUT",9,"Correspondent Bank Assessment","Annual assessment of correspondent banking partners' AML programs, FATF status and regulatory compliance.","Preventative","Manual","CCO","Annually",["Rec 13"],["Banks"],"Critical"),
  c("OUT",10,"Outsourcing Exit Strategy","Documented exit strategy for each material outsourcing arrangement ensuring continuity of AML controls during transition.","Preventative","Manual","CRO","Annually",["Rec 17"],["All"],"Medium"),

  // ── COM: Complaints (10) ──────────────────────────────────────────────────
  c("COM",1,"Complaints Policy & Procedure","Board-approved complaints policy aligned to ASIC RG 165 / EDR scheme requirements with defined handling timeframes.","Directive","Manual","Head of Ops","Annually",[],["All"],"High"),
  c("COM",2,"Complaints Register Management","Centralised complaints register capturing all complaints, categorisation, resolution status and root cause analysis.","Detective","Semi-Automated","Head of Ops","Monthly",[],["All"],"High"),
  c("COM",3,"Complaints Triage & Routing","Process for triaging complaints to appropriate teams including AML-related complaints to the AMLCO.","Directive","Manual","Head of Ops","Monthly",[],["All"],"Medium"),
  c("COM",4,"Regulatory Complaints Handling","Defined procedure for complaints received from or escalated to AUSTRAC, ASIC, APRA or other regulators.","Directive","Manual","CCO","Monthly",[],["All"],"Critical"),
  c("COM",5,"Complaint Resolution Tracking","Tracking of complaint resolution within required timeframes (IDR: 30 days financial services, 45 days banking).","Detective","Semi-Automated","Head of Ops","Monthly",[],["All"],"High"),
  c("COM",6,"Root Cause Analysis — Complaints","Systematic root cause analysis of complaint trends to identify systemic control weaknesses.","Detective","Manual","CCO","Quarterly",[],["All"],"High"),
  c("COM",7,"Complaints Reporting to Board","Regular board reporting on complaint volumes, themes, resolution rates and remediation actions.","Detective","Manual","CCO","Quarterly",[],["All"],"Medium"),
  c("COM",8,"External Dispute Resolution Referral","Process for referring unresolved complaints to AFCA or relevant EDR scheme with documented tracking.","Corrective","Manual","Head of Ops","Monthly",[],["All"],"High"),
  c("COM",9,"AML Complaint Staff Training","Training for customer-facing staff on identifying and handling AML-related complaints or whistleblower disclosures.","Preventative","Manual","Head of HR","Annually",["Rec 18"],["All"],"Medium"),
  c("COM",10,"Customer Feedback Loop","Process to incorporate complaint learnings into AML program improvements and policy updates.","Corrective","Manual","CCO","Quarterly",[],["All"],"Medium"),

  // ── FC: Financial Crime Risk (6) ──────────────────────────────────────────
  c("FC",1,"Financial Crime Risk Assessment","Integrated assessment of ML/TF, fraud, bribery, sanctions and tax evasion risks across the entity.","Detective","Manual","CRO","Annually",["Rec 1"],["All"],"Critical"),
  c("FC",2,"Proliferation Financing Risk Assessment","Specific assessment of proliferation financing risk per FATF Recommendation 1 and Australian guidance.","Detective","Manual","CRO","Annually",["Rec 1","Rec 7"],["All"],"Critical"),
  c("FC",3,"Bribery & Corruption Controls","Anti-bribery and corruption program including policy, gifts register, facilitation payments prohibition and due diligence.","Preventative","Manual","CCO","Annually",[],["All"],"High"),
  c("FC",4,"Market Manipulation Controls","Controls to detect and prevent market manipulation and insider trading in connection with AML obligations.","Detective","Semi-Automated","CCO","Quarterly",[],["All"],"High"),
  c("FC",5,"Tax Evasion Prevention Controls","Procedures implementing ATO reporting obligations and preventing facilitation of tax evasion by customers.","Preventative","Manual","CCO","Annually",[],["All"],"High"),
  c("FC",6,"Fraud-AML Convergence Framework","Integrated framework linking fraud, AML and sanctions functions to share typologies, intelligence and case data.","Preventative","Semi-Automated","CRO","Quarterly",["Rec 1","Rec 20"],["All"],"High"),

  // ── FR: Financial Reporting (6) ───────────────────────────────────────────
  c("FR",1,"Financial Reporting Integrity Controls","Controls ensuring financial reports accurately reflect AML-related provisions, penalties and extraordinary items.","Preventative","Manual","CFO","Annually",[],["All"],"High"),
  c("FR",2,"General Ledger Reconciliation","Daily/monthly reconciliation of AML-related accounts including STR provisions, fines and regulatory deposits.","Detective","Semi-Automated","CFO","Monthly",[],["All"],"High"),
  c("FR",3,"Management Accounts Review","Monthly management accounts review by CFO including AML cost centre, regulatory fines and incident provisions.","Detective","Manual","CFO","Monthly",[],["All"],"Medium"),
  c("FR",4,"External Audit Liaison","Defined process for external auditor access to AML records, systems and personnel during financial audit.","Directive","Manual","CFO","Annually",[],["All"],"Medium"),
  c("FR",5,"Financial Reporting Policy","Policy governing financial reporting practices including treatment of AML penalties, regulatory costs and provisions.","Directive","Manual","CFO","Annually",[],["All"],"Medium"),
  c("FR",6,"Accounting Records Integrity","Controls ensuring completeness and accuracy of underlying accounting records used to produce regulatory reports.","Preventative","Semi-Automated","CFO","Monthly",[],["All"],"High"),

  // ── CM: Client Money (5) ──────────────────────────────────────────────────
  c("CM",1,"Client Money Segregation","Segregation of client money from entity operating funds in dedicated trust accounts per Corporations Act s981B.","Preventative","Manual","CFO","Monthly",[],["All"],"Critical"),
  c("CM",2,"Client Money Reconciliation","Daily reconciliation of client money accounts to individual client balances with documented exception management.","Detective","Semi-Automated","CFO","Daily",[],["All"],"Critical"),
  c("CM",3,"Client Money Trust Account Controls","Signatory controls, bank mandate management and access restrictions on client money trust accounts.","Preventative","Manual","CFO","Annually",[],["All"],"Critical"),
  c("CM",4,"Client Money Reporting to Clients","Regular reporting to clients of their client money balances with reconciliation statements.","Detective","Semi-Automated","Head of Ops","Monthly",[],["All"],"High"),
  c("CM",5,"Client Money Audit","Annual independent audit of client money arrangements by external auditors with report to Board.","Detective","Manual","Head of Audit","Annually",[],["All"],"Critical"),
];

async function seed() {
  await connectDB();
  console.log("Connected to MongoDB".cyan);

  let created = 0, updated = 0;
  for (const ctrl of controls) {
    const result = await Control.findOneAndUpdate(
      { controlId: ctrl.controlId },
      ctrl,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (result.__v === undefined || result.isNew) created++;
    else updated++;
  }

  console.log(`✓ ${controls.length} controls seeded (${created} new, ${updated} updated)`.green);
  console.log(`  Domains covered: ${[...new Set(controls.map((c) => c.domain))].join(", ")}`.gray);

  await mongoose.disconnect();
  console.log("Done. Disconnected.".gray);
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
