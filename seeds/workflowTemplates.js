// seeds/workflowTemplates.js
//
// The Dooit onboarding-to-case-closure reference workflow, transcribed from
// docs/AML Workflow Design/AML Workflow Builder.dc.html (the seed(), links()
// and CFG maps inside its <script type="text/x-dc"> block), plus eight other
// gallery entries as unauthored stubs.
//
// This file only transcribes what the design prototype already says — it
// does not invent workflow logic, wording, thresholds or routing of its own.
//
// Every jurisdictional figure the prototype states in prose (a match
// threshold, an ownership percentage, a timer, a retention period) carries
// the literal suffix " (pending validation)" here, wherever it is seeded —
// a config.fields value, a card.inset/chips string, or an outcome's cond/then
// text. The suffix is about what a compliance user reads, not which schema
// path a string sits in: a figure on a card renders as plain fact whether
// it's in a field or a chip, so it is never a constant in code and never
// presented as verified. Before this template is offered to a client as
// guidance rather than as an illustrative example, every one of these
// figures must be checked against current AUSTRAC guidance.
//
// All data here is clearly fictional.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });
const mongoose = require("mongoose");
// `colors` patches String.prototype with .bgGreen/.underline and friends.
// config/db.js and utils/riskFactorCache.js both log with those, so a script
// that calls connectDB() without loading colors first dies on
// "Cannot read properties of undefined (reading 'underline')". Every other
// standalone seeder in this directory requires it for the same reason.
require("colors");
const { connectDB } = require("../config/db");
const Workflow = require("../models/Workflow");

// The prototype lays its steps out in fixed columns: X(col) = 60 + col * 330.
const COL = (c) => 60 + c * 330;

// ─────────────────────────────────────────────────────────────────────────
// CFG helper
//
// The prototype's CFG map stores each step as a tuple:
//   [purpose, fields[][], outLabel, outcomes[][], owner, sla]
// `outLabel` ("Outcomes" vs "Branches") is only a display heading in the
// prototype's inspector panel — the Workflow schema's config shape has no
// place for it, so it is dropped here. Everything else is transcribed.
const fromCfg = (purpose, fieldRows, outcomeRows, owner, sla) => ({
    purpose,
    config: {
        fields: fieldRows.map(([label, value]) => ({ label, value })),
        outcomes: outcomeRows.map(([cond, then]) => ({ cond, then })),
        owner,
        sla,
    },
});

// 16 of the 31 steps have no entry at all in the prototype's CFG map. The
// prototype's own cfgOf() (AML Workflow Builder.dc.html, around line 475)
// falls back to this exact generic block whenever CFG[id] is missing — so
// this is transcribed prototype behaviour, not a guess filled in for steps
// the design "forgot".
const DEFAULT_CFG = fromCfg(
    "Configure the checks, thresholds and routing this step applies.",
    [
        ["Status", "Not configured"],
        ["Applies to", "All applicants"],
    ],
    [
        ["On success", "Continue to the next step"],
        ["On failure", "Route to manual review"],
    ],
    "Unassigned",
    "Not set"
);

// ─────────────────────────────────────────────────────────────────────────
// The 31 steps (n1–n31) plus the canvas note.
//
// card holds presentation (inset / chips / tags / tagLabel / decision /
// reason); config holds substance (fields / outcomes / owner / sla);
// branches carry rule-engine condition leaves for the 7 "cond" steps.
const nodes = [
    {
        id: "n1", num: "01", type: "level", title: "Customer entry",
        position: { x: COL(0), y: 50 },
        card: { inset: "Channel, product and jurisdiction", chips: ["Duplicate and prior-reject check"] },
        ...fromCfg(
            "Open the file and record the designated service sought before any personal data is collected.",
            [
                ["Entry channels", "Web, mobile app, broker portal, introducer"],
                ["Prohibited jurisdictions", "Blocked list applied at intake"],
                ["Duplicate handling", "Match on name, DOB and device"],
            ],
            [
                ["File opened", "Continue to consent collection"],
                ["Blocked at intake", "Prohibited or sanctioned country of residence"],
                ["Held", "Prior final rejection within 12 months"],
            ],
            "Automated",
            "Immediate"
        ),
    },
    {
        id: "n2", num: "02", type: "quest", title: "Consent collection",
        position: { x: COL(1), y: 50 },
        card: { inset: "Onboarding consent questionnaire", chips: ["Biometric consent optional"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n3", num: "03", type: "cond", title: "Route by customer type",
        position: { x: COL(2), y: 50 },
        card: { chips: [] },
        branches: [
            {
                key: "b1", label: "Branch 1", logic: "AND",
                conditions: [{ field: "applicant.type", operator: "eq", value: "individual" }],
            },
            {
                key: "b2", label: "Branch 2", logic: "OR",
                conditions: [
                    { field: "applicant.type", operator: "eq", value: "company" },
                    { field: "applicant.info.companyInfo.type", operator: "in", values: ["trust", "partnership"] },
                ],
            },
            // Prose-only Else ("route to onboarding operations") — no field/operator
            // was ever specified for it, so it carries no condition leaf.
            { key: "b3", label: "Else", logic: "AND", conditions: [] },
        ],
        ...fromCfg(
            "Split the flow so individuals and entities receive the correct customer identification procedure.",
            [
                ["Evaluated on", "applicant.type, applicant.entityForm"],
                ["Fallback", "Else branch routes to manual triage"],
            ],
            [
                ["If type is individual", "Go to step 04, Individual KYC"],
                ["If type is company, trust or partnership", "Go to step 07, Business KYB"],
                ["Else", "Route to onboarding operations"],
            ],
            "Automated",
            "Immediate"
        ),
    },
    {
        id: "n4", num: "04", type: "level", title: "Individual KYC",
        position: { x: COL(3), y: 50 },
        card: { inset: "Name, date of birth, address", chips: ["Two independent data sources"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n5", num: "05", type: "level", title: "Document verification",
        position: { x: COL(4), y: 50 },
        card: { inset: "ID document, MRZ and chip", chips: ["Tamper and replay detection"] },
        ...fromCfg(
            "Confirm the identity document is genuine, current, and belongs to the person presenting it.",
            [
                ["Accepted documents", "Passport, driver licence, national ID"],
                // 0.90 and 0.70 are jurisdictional figures — pending validation.
                ["Authenticity threshold", "Pass at 0.90, review from 0.70 (pending validation)"],
                ["Re-capture attempts", "Maximum two"],
            ],
            [
                // Found in the sweep: these outcome "cond" strings repeat the
                // 0.90/0.70 figures suffixed above in this step's fields.
                ["If score is 0.90 or above (pending validation)", "Continue to liveness check"],
                ["If score is 0.70 to 0.90 (pending validation)", "Delegate to the KYC analyst queue"],
                ["If a forgery indicator is present", "Final reject and open a fraud case"],
            ],
            "Verification engine, then KYC analyst",
            "24 hours for review"
        ),
    },
    {
        id: "n6", num: "06", type: "level", title: "Liveness check",
        position: { x: COL(5), y: 50 },
        card: { inset: "Selfie, passive liveness", chips: ["Face match to portrait"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n7", num: "07", type: "level", title: "Business KYB",
        position: { x: COL(3), y: 300 },
        card: { inset: "Registry extract and status", chips: ["Constitution or trust deed"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n8", num: "08", type: "level", title: "Beneficial ownership",
        position: { x: COL(4), y: 300 },
        // The prototype's own "25 percent" ownership figure lives only in this
        // inset line — n8 has no CFG entry — but the suffix is about what a
        // compliance user reads on the card, not which schema path a string
        // sits in, so it is suffixed here too. See task-6-report.md.
        card: { inset: "Ownership chain to 25 percent (pending validation)", chips: ["KYC per UBO and controller"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n9", num: "09", type: "cond", title: "Identity decision",
        position: { x: COL(5), y: 590 },
        card: { chips: [] },
        branches: [
            {
                key: "b1", label: "Branch 1", logic: "AND",
                conditions: [{ field: "applicant.review.reviewAnswer", operator: "eq", value: "GREEN" }],
            },
            {
                key: "b2", label: "Branch 2", logic: "OR",
                conditions: [
                    { field: "applicant.review.reviewAnswer", operator: "eq", value: "YELLOW" },
                    { field: "applicant.review.rejectLabels", operator: "contains", value: "LOW_QUALITY, BAD_FACE_MATCHING" },
                ],
            },
            // This Else has a real condition in the prototype (not prose), so it
            // keeps its leaf even though it is also the required Else branch.
            {
                key: "b3", label: "Else", logic: "AND",
                conditions: [{ field: "applicant.review.rejectLabels", operator: "contains", value: "FORGERY, ID_INVALID" }],
            },
        ],
        ...fromCfg(
            "Reach one recorded conclusion on whether identity has been verified to the required standard.",
            [
                ["Inputs", "Document, biometric and data-source results"],
                ["Pass rule", "Document pass and biometric pass"],
                ["Second approver", "Required for identity rejection"],
            ],
            [
                ["If identity is verified", "Continue to sanctions screening"],
                ["If evidence is incomplete", "Pending applicant action, 14 day expiry"],
                ["Else", "Final reject, identity not established"],
            ],
            "KYC analyst",
            "24 hours"
        ),
    },
    {
        id: "n10", num: "10", type: "level", title: "Sanctions screening",
        position: { x: COL(4), y: 590 },
        card: { inset: "DFAT, UN, OFAC, EU, UK", chips: ["Blocks the file on a hit"] },
        ...fromCfg(
            "Prevent any dealing with a designated person or entity under Australian sanctions law.",
            [
                ["Lists", "DFAT Consolidated, UN, OFAC, EU, UK"],
                // 0.95 is a jurisdictional figure — pending validation.
                ["Match threshold", "True match at 0.95 with corroboration (pending validation)"],
                // 50 percent is a jurisdictional figure — pending validation.
                ["Ownership test", "50 percent for entities (pending validation)"],
                ["Rescreen", "Daily and before every payment"],
            ],
            [
                // Found in the sweep: these outcome "cond" strings repeat the
                // 0.95 figure suffixed above in this step's fields.
                ["If match is 0.95 or above (pending validation)", "Freeze, notify DFAT, raise an SMR"],
                ["If match is 0.75 to 0.95 (pending validation)", "Hold for the sanctions analyst, four hour SLA"],
                ["Else", "Clear and continue to PEP screening"],
            ],
            "Sanctions analyst, Compliance Officer",
            "4 hours"
        ),
    },
    {
        id: "n11", num: "11", type: "level", title: "PEP screening",
        position: { x: COL(3), y: 590 },
        card: { inset: "PEP and RCA screening", chips: ["Role and currency of office"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n12", num: "12", type: "level", title: "Adverse media",
        position: { x: COL(2), y: 590 },
        card: { inset: "Licensed media and enforcement", chips: ["Offence-type categorisation"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n13", num: "13", type: "action", title: "Initial risk assessment",
        position: { x: COL(1), y: 590 },
        card: {
            chips: [],
            tagLabel: "Add labels to applicant",
            tags: [
                { text: "Risk score 74", tone: "warn" },
                { text: "Model v3.2", tone: "plain" },
            ],
        },
        ...DEFAULT_CFG,
    },
    {
        id: "n14", num: "14", type: "cond", title: "Risk classification",
        position: { x: COL(0), y: 590 },
        card: { chips: [] },
        branches: [
            {
                key: "b1", label: "Branch 1", logic: "OR",
                conditions: [
                    { field: "applicant.assessment.scores.score", operator: "gte", value: "70" },
                    { field: "applicant.riskLabels.aml", operator: "contains", value: "pep, sanctions" },
                ],
            },
            {
                key: "b2", label: "Branch 2", logic: "AND",
                conditions: [{ field: "applicant.assessment.scores.score", operator: "between", min: "40", max: "69" }],
            },
            // Prose-only Else ("low band, 36 month review") — no condition leaf.
            { key: "b3", label: "Else", logic: "AND", conditions: [] },
        ],
        ...fromCfg(
            "Translate the risk score into the band that sets due diligence, approval and monitoring.",
            [
                ["Weights", "Jurisdiction 30, customer 25, product 20, channel 15, labels 10"],
                ["Override", "One band by an analyst, more by the Compliance Officer"],
            ],
            [
                ["If score is 70 or above", "Go to step 15, enhanced due diligence"],
                ["If score is 40 to 69", "Approve as medium, 24 month review"],
                ["If score is 0 to 39", "Approve as low, 36 month review"],
            ],
            "Automated",
            "Immediate"
        ),
    },
    {
        id: "n15", num: "15", type: "level", title: "Enhanced due diligence",
        position: { x: COL(0), y: 900 },
        card: { inset: "Source of funds and wealth", chips: ["Senior approval to onboard"] },
        ...fromCfg(
            "Obtain and test the additional information a high-risk relationship requires before approval.",
            [
                ["Evidence requested", "Source of funds, source of wealth, proof of address"],
                ["Tags applied", "High risk, ECDD in progress"],
                ["Approver", "Senior management or the Compliance Officer"],
            ],
            [
                ["If wealth is credible and consistent", "Approve with conditions and 12 month review"],
                ["If evidence is inconsistent", "Refuse and consider an SMR"],
                // Found in the sweep: "30 days" is a jurisdictional figure.
                ["If no response in 30 days (pending validation)", "Withdraw the application"],
            ],
            "Senior analyst, then Compliance Officer",
            "10 business days"
        ),
    },
    {
        id: "n16", num: "16", type: "review", title: "Approval or rejection",
        position: { x: COL(1), y: 900 },
        card: { chips: [], decision: "Manual review", reason: "Approve, restrict or refuse with reasons" },
        ...DEFAULT_CFG,
    },
    {
        id: "n17", num: "17", type: "mon", title: "Ongoing due diligence",
        position: { x: COL(2), y: 900 },
        card: { inset: "Daily rescreening", chips: ["Periodic review by band"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n18", num: "18", type: "mon", title: "Transaction monitoring",
        position: { x: COL(3), y: 900 },
        card: { inset: "Real-time gates and batch rules", chips: ["Structuring, velocity, jurisdiction"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n19", num: "19", type: "action", title: "Alert generation",
        position: { x: COL(4), y: 900 },
        card: {
            chips: [],
            tagLabel: "Add labels to applicant",
            tags: [
                { text: "High risk", tone: "bad" },
                { text: "Alert P2", tone: "warn" },
            ],
        },
        ...DEFAULT_CFG,
    },
    {
        id: "n20", num: "20", type: "deleg", title: "Case management",
        position: { x: COL(5), y: 900 },
        card: { inset: "Assign to AML investigations", chips: ["One open case per customer"] },
        ...fromCfg(
            "Hold every alert, document and decision for one customer in a single auditable case.",
            [
                ["Assignment", "By skill and workload"],
                ["Aggregation", "One open case per customer"],
                // 30 days is a jurisdictional figure — pending validation.
                ["Stale case rule", "30 days without progress escalates (pending validation)"],
            ],
            [
                ["Under investigation", "Owned by a named investigator"],
                ["Awaiting information", "Clock paused, reason recorded"],
                ["Recommended for SMR", "Goes to quality concurrence"],
            ],
            "AML investigations team",
            "By alert priority"
        ),
    },
    {
        id: "n21", num: "21", type: "review", title: "Investigator review",
        position: { x: COL(5), y: 1200 },
        card: { chips: [], decision: "Manual review", reason: "Narrative, evidence, recommendation" },
        ...DEFAULT_CFG,
    },
    {
        id: "n22", num: "22", type: "cond", title: "SMR decision",
        position: { x: COL(4), y: 1200 },
        card: { chips: [] },
        branches: [
            {
                key: "b1", label: "Branch 1", logic: "AND",
                conditions: [{ field: "case.groundsToSuspect", operator: "eq", value: "true" }],
            },
            {
                key: "b2", label: "Branch 2", logic: "AND",
                conditions: [{ field: "case.explanation", operator: "eq", value: "documented" }],
            },
            // Prose-only Else ("escalate to the Compliance Officer") — no leaf.
            { key: "b3", label: "Else", logic: "AND", conditions: [] },
        ],
        ...fromCfg(
            "Decide, at the correct level of authority, whether a suspicious matter report is required.",
            [
                ["Timer starts", "When suspicion is formed, not when the alert fired"],
                // 24 hours is a jurisdictional figure — pending validation.
                ["Money laundering", "24 hours (pending validation)"],
                // 3 business days is a jurisdictional figure — pending validation.
                ["Terrorism financing", "3 business days (pending validation)"],
                ["Tipping off", "Prohibited, no exceptions"],
            ],
            [
                ["If reasonable grounds to suspect", "Submit the SMR through Dooit"],
                ["If explained and documented", "Close with reasons recorded"],
                ["If terrorism financing is indicated", "Escalate immediately and freeze pending advice"],
            ],
            "AML/CTF Compliance Officer",
            "Statutory"
        ),
    },
    {
        id: "n23", num: "23", type: "report", title: "Report submission",
        position: { x: COL(3), y: 1200 },
        card: { inset: "Dooit lodgement portal", chips: ["Receipt captured, no tipping off"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n24", num: "24", type: "hook", title: "Audit logging",
        position: { x: COL(2), y: 1200 },
        // Never overridden by a set() call in the prototype — these are its
        // original base chips. "Seven year retention" is a jurisdictional
        // figure rendered here as a card chip; suffixed like any other
        // unverified figure the card shows as plain fact. See task-6-report.md.
        card: { chips: ["Append-only, hash chained", "Seven year retention (pending validation)"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n25", num: "25", type: "wait", title: "Risk reassessment",
        position: { x: COL(1), y: 1200 },
        card: { inset: "Review cycle by risk band", chips: ["Rewrites band and review date"] },
        ...DEFAULT_CFG,
    },
    {
        id: "n26", num: "26", type: "review", title: "Final rejection",
        position: { x: COL(6), y: 330 },
        card: {
            chips: [],
            decision: "Final reject",
            tagLabel: "Rejection labels",
            tags: [
                { text: "FORGERY", tone: "bad" },
                { text: "ID_INVALID", tone: "bad" },
                { text: "WRONG_USER_REGION", tone: "bad" },
            ],
        },
        ...fromCfg(
            "Close the flow with a recorded rejection and the labels that explain it, without disclosing detection detail to the applicant.",
            [
                ["Decision", "Final reject"],
                ["Labels", "FORGERY, ID_INVALID, WRONG_USER_REGION"],
                ["Applicant message", "Generic, no indicators disclosed"],
            ],
            [
                ["End of flow", "No further steps run"],
                // "Seven years" here is an outcome, not a fields value, but a
                // compliance user reads it the same way either way — suffixed.
                ["Record retained", "Seven years from rejection (pending validation)"],
                ["Fraud case", "Opened where forgery is indicated"],
            ],
            "KYC analyst, second approver",
            "24 hours"
        ),
        endOfFlow: true,
    },
    {
        id: "n27", num: "27", type: "cond", title: "Device and IP check",
        position: { x: COL(1), y: 300 },
        card: { chips: [] },
        branches: [
            {
                key: "b1", label: "Branch 1", logic: "OR",
                conditions: [
                    { field: "checks.ip.vpn", operator: "eq", value: "true" },
                    { field: "applicant.riskLabels.device", operator: "contains", value: "torUsage, antiDetectBrowser" },
                ],
            },
            {
                key: "b2", label: "Branch 2", logic: "AND",
                conditions: [{ field: "device.ipCountry", operator: "in", values: ["clientLists.risky_countries"] }],
            },
            // Prose-only Else ("continue to identification") — no leaf.
            { key: "b3", label: "Else", logic: "AND", conditions: [] },
        ],
        ...fromCfg(
            "Screen the session before identification: anonymised traffic and risky-country IPs are refused at the door.",
            [
                ["Evaluated on", "checks.ip.vpn, checks.ip.tor, checks.ip.riskLevel"],
                ["Device labels", "applicant.riskLabels.device"],
                ["Client list", "clientLists.risky_countries"],
            ],
            [
                ["If checks.ip.vpn is true", "Final reject with WRONG_USER_REGION"],
                ["If device.ipCountry is in clientLists.risky_countries", "Final reject with REGULATIONS_VIOLATIONS"],
                ["Else", "Continue to step 03, route by customer type"],
            ],
            "Automated",
            "Immediate"
        ),
    },
    {
        id: "n28", num: "28", type: "cond", title: "Sanctions match decision",
        position: { x: COL(5), y: 760 },
        card: { chips: [] },
        branches: [
            {
                key: "b1", label: "Branch 1", logic: "OR",
                conditions: [
                    { field: "checks.personWatchlist.matchStatuses", operator: "contains", value: "true_match" },
                    { field: "applicant.riskLabels.aml", operator: "contains", value: "sanctions" },
                ],
            },
            {
                key: "b2", label: "Branch 2", logic: "AND",
                conditions: [{ field: "checks.personWatchlist.matchStatuses", operator: "contains", value: "potential_match" }],
            },
            // Prose-only Else ("no candidate above threshold") — no leaf.
            { key: "b3", label: "Else", logic: "AND", conditions: [] },
        ],
        ...fromCfg(
            "Stop the flow on a confirmed sanctions match. Screening alone is not a control; the match decision is.",
            [
                ["Evaluated on", "checks.personWatchlist.matchStatuses"],
                // 0.95 is a jurisdictional figure — pending validation.
                ["True match", "0.95 or above with a corroborating identifier (pending validation)"],
                // 50 percent is a jurisdictional figure — pending validation.
                ["Ownership test", "50 percent for entities (pending validation)"],
                ["Rescreen", "Daily and before every payment"],
            ],
            [
                ["If a true match is confirmed", "Freeze, notify DFAT, raise an SMR, end the flow"],
                ["If a potential match is held", "Sanctions analyst adjudicates, four hour SLA"],
                ["Else", "Continue to PEP screening"],
            ],
            "Sanctions analyst, Compliance Officer",
            "4 hours"
        ),
    },
    {
        id: "n29", num: "29", type: "report", title: "Freeze and DFAT notification",
        position: { x: COL(6), y: 760 },
        card: { inset: "No dealing permitted", chips: ["Assets frozen, payments blocked", "SMR raised, no tipping off"] },
        ...fromCfg(
            "Give effect to the absolute prohibition on dealing with a designated person or entity.",
            [
                ["Action", "Freeze assets, block all payments"],
                ["Notification", "DFAT within the required period"],
                ["Customer contact", "None. Tipping off is prohibited"],
            ],
            [
                ["End of flow", "No onboarding, no service provided"],
                ["SMR", "Raised in parallel"],
                // "Seven years" here is an outcome, not a fields value, but the
                // same reasoning applies — suffixed.
                ["Record", "Retained seven years (pending validation)"],
            ],
            "AML/CTF Compliance Officer",
            "Immediate"
        ),
        endOfFlow: true,
    },
    {
        id: "n30", num: "30", type: "report", title: "Threshold and IFTI reporting",
        position: { x: COL(2), y: 1450 },
        // "TTR at AUD 10,000 or more" repeats the same figure suffixed in this
        // step's fields below — found in the sweep for card-level figures.
        card: { inset: "Independent of the SMR decision", chips: ["TTR at AUD 10,000 or more (pending validation)", "IFTI on every cross-border transfer"] },
        ...fromCfg(
            "Meet the reporting obligations that arise from the transaction itself, whether or not any suspicion is formed.",
            [
                // AUD 10,000 is a jurisdictional figure — pending validation.
                ["Threshold transaction report", "Physical currency of AUD 10,000 or more (pending validation)"],
                ["IFTI", "Every incoming and outgoing international transfer instruction"],
                // 10 business days is a jurisdictional figure — pending validation.
                ["Timing", "Within 10 business days of the transaction (pending validation)"],
            ],
            [
                ["Report lodged", "Receipt captured and logged"],
                ["Not reportable", "Reason recorded against the transaction"],
                ["Late or rejected", "Escalated to the Compliance Officer"],
            ],
            "Automated, Compliance Officer oversight",
            // Unlike n15's identical-looking sla text, this one restates the
            // statutory TTR/IFTI reporting window (the same deadline already
            // suffixed in this node's own "Timing" field above), not an
            // internal turnaround target — so it is suffixed here too.
            "10 business days (pending validation)"
        ),
    },
    {
        id: "n31", num: "31", type: "cond", title: "Reporting obligation check",
        position: { x: COL(3), y: 1450 },
        card: { chips: [] },
        branches: [
            {
                key: "b1", label: "Branch 1", logic: "OR",
                conditions: [
                    { field: "transaction.physicalCurrencyAmount", operator: "gte", value: "10000" },
                    { field: "transaction.isInternationalTransfer", operator: "eq", value: "true" },
                ],
            },
            // Prose-only Else ("no threshold obligation, monitor only") — no leaf.
            { key: "b2", label: "Else", logic: "AND", conditions: [] },
        ],
        ...fromCfg(
            "Separate the reporting obligations that arise from the transaction itself from the suspicion-based path.",
            [
                ["Evaluated on", "transaction.physicalCurrencyAmount, transaction.isInternationalTransfer"],
                // AUD 10,000 is a jurisdictional figure — pending validation.
                ["Threshold", "AUD 10,000 or more in physical currency (pending validation)"],
                ["Aggregation", "Applied before the threshold test"],
            ],
            [
                ["If the transaction is reportable", "Go to step 30, threshold and IFTI reporting"],
                ["Else", "Continue to step 19, alert generation"],
            ],
            "Automated",
            "Immediate"
        ),
    },
    // The prototype's canvas note. Not a step — excluded from every node count,
    // from the reachability walk, and from the Else-branch rule. The schema has
    // no dedicated annotation field, so its body text is carried in `purpose`,
    // the closest existing free-text slot.
    {
        id: "note", num: "", type: "note", title: "Full Dooit onboarding to case closure",
        position: { x: COL(0), y: 300 },
        purpose:
            "Individuals and entities split at step 03. Screening runs only on a verified identity. " +
            "A high risk band, a confirmed PEP or relevant adverse media forces enhanced due diligence " +
            "before approval. Everything after approval loops through monitoring, investigation and reassessment.",
    },
];

// ─────────────────────────────────────────────────────────────────────────
// The 37 edges from links(). sourcePort is the branch key at that portIndex
// on the `from` node, or '' when that node has no branches.
const edges = [
    { from: "n1", to: "n2", sourcePort: "" },
    { from: "n2", to: "n27", sourcePort: "" },
    { from: "n27", to: "n26", sourcePort: "b1" },
    { from: "n27", to: "n26", sourcePort: "b2" },
    { from: "n27", to: "n3", sourcePort: "b3" },
    { from: "n3", to: "n4", sourcePort: "b1" },
    { from: "n3", to: "n7", sourcePort: "b2" },
    { from: "n4", to: "n5", sourcePort: "" },
    { from: "n5", to: "n6", sourcePort: "" },
    { from: "n6", to: "n9", sourcePort: "" },
    { from: "n7", to: "n8", sourcePort: "" },
    { from: "n8", to: "n9", sourcePort: "" },
    { from: "n9", to: "n10", sourcePort: "b1" },
    { from: "n9", to: "n26", sourcePort: "b3" },
    { from: "n10", to: "n28", sourcePort: "" },
    { from: "n28", to: "n29", sourcePort: "b1" },
    { from: "n28", to: "n20", sourcePort: "b2" },
    { from: "n28", to: "n11", sourcePort: "b3" },
    { from: "n18", to: "n31", sourcePort: "" },
    { from: "n31", to: "n30", sourcePort: "b1" },
    { from: "n31", to: "n19", sourcePort: "b2" },
    { from: "n30", to: "n24", sourcePort: "" },
    { from: "n11", to: "n12", sourcePort: "" },
    { from: "n12", to: "n13", sourcePort: "" },
    { from: "n13", to: "n14", sourcePort: "" },
    { from: "n14", to: "n15", sourcePort: "b1" },
    { from: "n14", to: "n16", sourcePort: "b2" },
    { from: "n15", to: "n16", sourcePort: "" },
    { from: "n16", to: "n17", sourcePort: "" },
    { from: "n17", to: "n18", sourcePort: "" },
    { from: "n19", to: "n20", sourcePort: "" },
    { from: "n20", to: "n21", sourcePort: "" },
    { from: "n21", to: "n22", sourcePort: "" },
    { from: "n22", to: "n23", sourcePort: "b1" },
    { from: "n23", to: "n24", sourcePort: "" },
    { from: "n24", to: "n25", sourcePort: "" },
    { from: "n25", to: "n17", sourcePort: "" },
];

const DOOIT_FULL_FLOW = {
    workflowId: "WF-0001",
    name: "Full Dooit onboarding to case closure",
    description:
        "Entry, KYC and KYB, screening, risk banding, ECDD, monitoring, " +
        "investigation and reporting in one flow.",
    category: "onboarding",
    appliesTo: "both",
    startNodeId: "n1",
    nodes,
    edges,
};

// Gallery stubs — named and described, deliberately unauthored. The gallery
// then shows what the design shows while staying honest that only one flow
// has a graph.
const STUBS = [
    ["WF-0002", "Enhanced due diligence", "applicant.riskLabels.aml contains pep or sanctions triggers source of funds, then delegation to compliance.", "screening"],
    ["WF-0003", "Country-based identity verification", "applicant.country selects the identification path; risky countries from clientLists are refused at entry.", "onboarding"],
    ["WF-0004", "Age-based routing", "poi.dob.ageInYears and derivatives.estimatedAge split minors, restricted and full-access flows.", "onboarding"],
    ["WF-0005", "Non-doc plus standard verification", "Database validation first; a failed match falls back to document and liveness capture.", "onboarding"],
    ["WF-0006", "Assign tags and risk labels", "Action nodes write tags from questionnaire answers and screening labels for downstream monitoring.", "monitoring"],
    ["WF-0007", "Delegate rejected applicants", "applicant.review.rejectLabels routes low-quality and mismatch rejections to a human queue instead of a final no.", "investigation"],
    ["WF-0008", "Reject VPN and anonymised traffic", "checks.ip.vpn, checks.ip.tor and riskLabels.device antiDetectBrowser end the flow with WRONG_USER_REGION.", "screening"],
    ["WF-0009", "Data reconfirmation", "Periodic re-confirmation of identity and address data, with a wait node between reminder cycles.", "monitoring"],
];

/** Idempotent: upsert by { client: null, workflowId }. */
const seedWorkflowTemplates = async () => {
    const all = [
        { ...DOOIT_FULL_FLOW, status: "draft" },
        ...STUBS.map(([workflowId, name, description, category]) => ({
            workflowId, name, description, category,
            appliesTo: "both", startNodeId: "", nodes: [], edges: [], status: "draft",
        })),
    ];

    for (const t of all) {
        await Workflow.findOneAndUpdate(
            { client: null, workflowId: t.workflowId },
            { $set: { ...t, client: null, branch: null, visibleToClients: true } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    }
    console.log(`[seed] workflow templates: ${all.length} upserted`);
    return all.length;
};

module.exports = seedWorkflowTemplates;
module.exports.DOOIT_FULL_FLOW = DOOIT_FULL_FLOW;
module.exports.STUBS = STUBS;

// ── Standalone runner ───────────────────────────────────────────────────────
// Lets seed-all.js run this file the same way it runs every other seeder:
// `node seeds/workflowTemplates.js` as its own process. Guarded by
// require.main so requiring this file from a test (as seed.test.js does, for
// DOOIT_FULL_FLOW) never opens a database connection.
if (require.main === module) {
    (async () => {
        await connectDB();
        await seedWorkflowTemplates();
        await mongoose.disconnect();
        process.exit(0);
    })().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
