/**
 * Seed RiskFactorOption — CRA Scoring Model V2 (docs/datasheet/CRA_Scoring_Method.md)
 *
 * Universal factors use the 1–5 scale (UHRC jurisdiction = 100).
 * Products are seeded per reporting entity type from seed/cra_product_scores.json
 * (Section 3 of the datasheet) including ECDD override flags.
 *
 * NOTE: this REPLACES all options for the seeded factors (V2 migration).
 * Custom options added via the UI for these factors will be removed.
 *
 * Run: node api/seeds/seedRiskFactors.js
 */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../config/config.env"),
});
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
require("colors");
const RiskFactorOption = require("../models/RiskFactorOption");

const productRows = require("../../seed/cra_product_scores.json");

const SEED = [
  // ── customerType (Section 2 — sheet: Trust 5, Assoc/Co-op 4, Company/Partnership 3,
  //    Individual/Sole Trader 2, Government Body 1) ──────────────────────────
  { factor: "customerType", value: "government_body",     score: 1, risk: "LOW" },
  { factor: "customerType", value: "individual",          score: 2, risk: "MED" },
  { factor: "customerType", value: "sole proprietorship", score: 2, risk: "MED" },
  { factor: "customerType", value: "company",             score: 3, risk: "MED" },
  { factor: "customerType", value: "partnership",         score: 3, risk: "MED" },
  { factor: "customerType", value: "association",         score: 4, risk: "MED-H" },
  { factor: "customerType", value: "cooperative",         score: 4, risk: "MED-H" },
  { factor: "customerType", value: "trust",               score: 5, risk: "HIGH" },

  // ── customerRetention ───────────────────────────────────────────────────────
  { factor: "customerRetention", value: "3+ Years",  score: 1, risk: "LOW" },
  { factor: "customerRetention", value: "1-3 Years", score: 2, risk: "MED" },
  { factor: "customerRetention", value: "New",       score: 3, risk: "HIGH" },

  // ── channel — onboarding / delivery channel ─────────────────────────────────
  // The sheet's base formula includes "+ Channel" but Section 2 enumerates no
  // options; this canonical set follows the FATF/AUSTRAC face-to-face vs
  // non-face-to-face distinction (1 = F2F verified … 5 = anonymity-preserving).
  // Aliases cover the values real customer records carry (onboardingChannel:
  // "Mobile App", "Website", "In-Branch", "Agent", "app", "websdk").
  { factor: "channel", value: "face to face",           score: 1, risk: "LOW",  aliases: ["f2f", "in person", "in-person"],            notes: "Identity verified in person; lowest impersonation risk" },
  { factor: "channel", value: "in-branch",              score: 1, risk: "LOW",  aliases: ["branch", "in branch"],                       notes: "Branch onboarding with original documents" },
  { factor: "channel", value: "phone / telephone",      score: 2, risk: "MED",  aliases: ["phone", "telephone", "call centre", "call center"], notes: "Voice channel; no visual identity confirmation" },
  { factor: "channel", value: "agent",                  score: 2, risk: "MED",  aliases: ["authorised agent", "authorized agent"],      notes: "Onboarded via authorised agent acting F2F" },
  { factor: "channel", value: "representative",         score: 2, risk: "MED",  aliases: ["authorised representative"],                 notes: "Authorised representative of the customer" },
  { factor: "channel", value: "web",                    score: 3, risk: "MED",  aliases: ["website", "websdk", "online portal"],        notes: "Non-F2F with electronic identity verification (VOI)" },
  { factor: "channel", value: "online",                 score: 3, risk: "MED",  aliases: ["digital"],                                   notes: "Generic digital onboarding; non-F2F" },
  { factor: "channel", value: "mobile app",             score: 3, risk: "MED",  aliases: ["app", "mobile"],                             notes: "App onboarding with VOI (photo ID + selfie)" },
  { factor: "channel", value: "api",                    score: 3, risk: "MED",  aliases: ["api integration", "partner api"],            notes: "Programmatic onboarding via integration partner" },
  { factor: "channel", value: "email",                  score: 4, risk: "HIGH", aliases: [],                                            notes: "Instructions by email; spoofing / no liveness check" },
  { factor: "channel", value: "messaging",              score: 4, risk: "HIGH", aliases: ["whatsapp", "sms", "chat"],                   notes: "Messaging apps; weak identity assurance" },
  { factor: "channel", value: "broker",                 score: 4, risk: "HIGH", aliases: [],                                            notes: "Intermediated; reduced visibility of the customer" },
  { factor: "channel", value: "third-party introducer", score: 4, risk: "HIGH", aliases: ["introducer", "referral"],                    notes: "Reliance on a third party's CDD" },
  { factor: "channel", value: "otc trading desk",       score: 4, risk: "HIGH", aliases: ["otc"],                                       notes: "High-value OTC; bespoke onboarding" },
  { factor: "channel", value: "anonymous digital",      score: 5, risk: "UHR",  aliases: ["anonymous"],                                 notes: "No verified identity; anonymity-preserving channel" },
  { factor: "channel", value: "crypto atm",             score: 5, risk: "UHR",  aliases: ["cryptocurrency atm", "btm"],                 notes: "Walk-in cash channel; AUD$5,000 AUSTRAC condition limit" },

  // ── occupation — ANZSCO categories (individuals) ────────────────────────────
  { factor: "occupation", value: "Managers",                                score: 1, risk: "LOW",  aliases: ["manager"] },
  { factor: "occupation", value: "Professionals",                           score: 1, risk: "LOW",  aliases: ["professional"] },
  { factor: "occupation", value: "Clerical and Administrative Workers",     score: 2, risk: "MED",  aliases: ["clerical", "admin"] },
  { factor: "occupation", value: "Technicians and Trades Workers",          score: 3, risk: "MED",  aliases: ["technician", "skilled trade"] },
  { factor: "occupation", value: "Sales Workers",                           score: 3, risk: "MED",  aliases: ["sales"] },
  { factor: "occupation", value: "Machinery Operators and Drivers",         score: 3, risk: "MED",  aliases: ["machinery", "driver"] },
  { factor: "occupation", value: "Labourers",                               score: 4, risk: "HIGH", aliases: ["labourer", "laborer"] },
  { factor: "occupation", value: "Community and Personal Service Workers",  score: 4, risk: "HIGH", aliases: ["service"] },
  { factor: "occupation", value: "Business Owner",                          score: 4, risk: "HIGH" },
  { factor: "occupation", value: "Unemployed / Retiree",                    score: 5, risk: "UHR",  aliases: ["unemployed", "retiree", "retired"] },
  { factor: "occupation", value: "Student",                                 score: 5, risk: "UHR" },

  // ── industry — ANZSIC divisions (business customers) ────────────────────────
  { factor: "industry", value: "Electricity, Gas, Water and Waste Services",       score: 1, risk: "LOW",  aliases: ["electricity", "utilities"] },
  { factor: "industry", value: "Information Media and Telecommunications",         score: 1, risk: "LOW",  aliases: ["tech", "technology", "information technology", "telecom"] },
  { factor: "industry", value: "Public Administration and Safety",                 score: 1, risk: "LOW",  aliases: ["public administration"] },
  { factor: "industry", value: "Education and Training",                           score: 2, risk: "MED",  aliases: ["education"] },
  { factor: "industry", value: "Health Care and Social Assistance",                score: 2, risk: "MED",  aliases: ["health care", "healthcare"] },
  { factor: "industry", value: "Agriculture, Forestry and Fishing",                score: 3, risk: "MED",  aliases: ["agriculture"] },
  { factor: "industry", value: "Mining",                                           score: 3, risk: "MED" },
  { factor: "industry", value: "Manufacturing",                                    score: 3, risk: "MED" },
  { factor: "industry", value: "Wholesale Trade",                                  score: 3, risk: "MED",  aliases: ["wholesale", "import-export"] },
  { factor: "industry", value: "Accommodation and Food Services",                  score: 3, risk: "MED",  aliases: ["hospitality"] },
  { factor: "industry", value: "Transport, Postal and Warehousing",                score: 3, risk: "MED",  aliases: ["transport"] },
  { factor: "industry", value: "Professional, Scientific and Technical Services",  score: 3, risk: "MED",  aliases: ["professional services"] },
  { factor: "industry", value: "Administrative and Support Services",              score: 3, risk: "MED" },
  { factor: "industry", value: "Retail Trade",                                     score: 4, risk: "HIGH", aliases: ["retail"] },
  { factor: "industry", value: "Arts and Recreation Services",                     score: 4, risk: "HIGH", aliases: ["arts", "gambling"] },
  { factor: "industry", value: "Construction",                                     score: 5, risk: "UHR" },
  { factor: "industry", value: "Financial and Insurance Services",                 score: 5, risk: "UHR",  aliases: ["financial services"] },
  { factor: "industry", value: "Rental, Hiring and Real Estate Services",          score: 5, risk: "UHR",  aliases: ["real estate"] },

  // ── pepStatus (Section 2 — scores 0; band overrides applied by the engine) ──
  { factor: "pepStatus", value: "Not a PEP",                       score: 0, risk: "LOW" },
  { factor: "pepStatus", value: "Domestic PEP / close associate",  score: 0, risk: "MED override" },
  { factor: "pepStatus", value: "Foreign PEP / close associate",   score: 0, risk: "HIGH override", ecddOverride: true },
  { factor: "pepStatus", value: "International Organisation PEP",  score: 0, risk: "MED override" },

  // ── sourceOfFunds (modifier: 0 / +3 / +10) ──────────────────────────────────
  { factor: "sourceOfFunds", value: "Clearly established and verified", score: 0,  risk: "LOW" },
  { factor: "sourceOfFunds", value: "Plausible but unverified",         score: 3,  risk: "MED" },
  { factor: "sourceOfFunds", value: "Cannot be explained / refuses",    score: 10, risk: "HIGH", ecddOverride: true },

  // ── sourceOfWealth (T1 High CRA / Foreign PEP / private banking) ────────────
  { factor: "sourceOfWealth", value: "Clearly established and verified", score: 0,  risk: "LOW" },
  { factor: "sourceOfWealth", value: "Plausible but unverified",         score: 3,  risk: "MED" },
  { factor: "sourceOfWealth", value: "Cannot be explained / refuses",    score: 10, risk: "HIGH", ecddOverride: true },

  // ── adverseMedia (auto-screened at onboarding) ──────────────────────────────
  { factor: "adverseMedia", value: "No adverse media",              score: 0,  risk: "LOW" },
  { factor: "adverseMedia", value: "Minor adverse media",           score: 2,  risk: "MED" },
  { factor: "adverseMedia", value: "Significant adverse media",     score: 5,  risk: "HIGH", ecddOverride: true },
  { factor: "adverseMedia", value: "Confirmed criminal connection", score: 10, risk: "HIGH", ecddOverride: true },
];

// ── product — Section 3, per entity type ─────────────────────────────────────
const PRODUCTS = productRows
  .filter((r) => r.entity_type && r.product_or_service && typeof r.score === "number")
  .map((r) => ({
    factor: "product",
    value: r.product_or_service,
    score: r.score,
    risk: r.risk_label || null,
    entityType: r.entity_type,
    ecddOverride: /^yes/i.test(r.ecdd_override || ""),
    notes: r.notes || undefined,
  }));

const ALL = [...SEED, ...PRODUCTS];
const FACTORS_SEEDED = [...new Set(ALL.map((s) => s.factor))];

async function main() {
  await connectDB();
  console.log("Seeding RiskFactorOption (CRA V2)…".cyan);

  // V2 migration: replace all options for the seeded factors so stale
  // 10×-scale options can't mix with the 1–5 scale.
  const removed = await RiskFactorOption.deleteMany({ factor: { $in: FACTORS_SEEDED } });
  console.log(`Removed ${removed.deletedCount} legacy options`.yellow);

  // Rebuild indexes (unique key changed to factor+entityType+value)
  await RiskFactorOption.syncIndexes();

  await RiskFactorOption.insertMany(ALL, { ordered: false });
  console.log(`Done — inserted ${ALL.length} options (${PRODUCTS.length} products across 10 entity types)`.green);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
