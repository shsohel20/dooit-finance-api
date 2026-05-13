/**
 * Seed RiskFactorOption — populates product, channel, occupation, industry,
 * customerType, and customerRetention options used by the CRA wizard.
 *
 * Run: node api/scripts/seedRiskFactors.js
 */
require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
require("colors");
const RiskFactorOption = require("../models/RiskFactorOption");

const SEED = [
  // ── customerType ────────────────────────────────────────────────────────────
  { factor: "customerType", value: "government_body",    score: 10 },
  { factor: "customerType", value: "individual",         score: 20 },
  { factor: "customerType", value: "sole proprietorship",score: 20 },
  { factor: "customerType", value: "association",        score: 30 },
  { factor: "customerType", value: "cooperative",        score: 30 },
  { factor: "customerType", value: "company",            score: 40 },
  { factor: "customerType", value: "partnership",        score: 40 },
  { factor: "customerType", value: "trust",              score: 50 },

  // ── customerRetention ───────────────────────────────────────────────────────
  { factor: "customerRetention", value: "3+ Years",  score: 10 },
  { factor: "customerRetention", value: "1-3 Years", score: 20 },
  { factor: "customerRetention", value: "New",        score: 30 },

  // ── product ─────────────────────────────────────────────────────────────────
  { factor: "product", value: "retail banking",         score: 20, risk: "MR",  industry: "banks/fi" },
  { factor: "product", value: "payment processing",     score: 30, risk: "MR",  industry: "banks/fi" },
  { factor: "product", value: "wealth management",      score: 40, risk: "HR",  industry: "banks/fi" },
  { factor: "product", value: "private banking",        score: 40, risk: "HR",  industry: "banks/fi" },
  { factor: "product", value: "correspondent banking",  score: 50, risk: "UHR", industry: "banks/fi" },
  { factor: "product", value: "stablecoin transfers",   score: 20, risk: "MR",  industry: "vasp" },
  { factor: "product", value: "crypto custody",         score: 30, risk: "MR",  industry: "vasp" },
  { factor: "product", value: "crypto lending",         score: 40, risk: "HR",  industry: "vasp" },
  { factor: "product", value: "staking",                score: 40, risk: "HR",  industry: "vasp" },
  { factor: "product", value: "digital currency exchange", score: 40, risk: "HR", industry: "vasp" },
  { factor: "product", value: "anonymous crypto",       score: 50, risk: "UHR", industry: "vasp" },
  { factor: "product", value: "small jewelry",          score: 20, risk: "MR",  industry: "precious metals" },
  { factor: "product", value: "numismatic coins",       score: 30, risk: "MR",  industry: "precious metals" },
  { factor: "product", value: "high-value jewelry",     score: 40, risk: "HR",  industry: "precious metals" },
  { factor: "product", value: "bullion trading",        score: 50, risk: "UHR", industry: "precious metals" },

  // ── channel ─────────────────────────────────────────────────────────────────
  { factor: "channel", value: "face to face",          score: 10, risk: "LR" },
  { factor: "channel", value: "in-branch",             score: 10, risk: "LR" },
  { factor: "channel", value: "agent",                 score: 20, risk: "MR" },
  { factor: "channel", value: "representative",        score: 20, risk: "MR" },
  { factor: "channel", value: "web",                   score: 30, risk: "MR" },
  { factor: "channel", value: "api",                   score: 30, risk: "MR" },
  { factor: "channel", value: "online",                score: 30, risk: "MR" },
  { factor: "channel", value: "mobile app",            score: 30, risk: "MR" },
  { factor: "channel", value: "messaging",             score: 40, risk: "HR" },
  { factor: "channel", value: "email",                 score: 40, risk: "HR" },
  { factor: "channel", value: "broker",                score: 40, risk: "HR" },
  { factor: "channel", value: "third-party introducer",score: 40, risk: "HR" },
  { factor: "channel", value: "otc trading desk",      score: 40, risk: "HR" },
  { factor: "channel", value: "anonymous digital",     score: 50, risk: "UHR" },
  { factor: "channel", value: "crypto atm",            score: 50, risk: "UHR" },

  // ── occupation (individuals) ─────────────────────────────────────────────────
  { factor: "occupation", value: "Professional",   score: 10 },
  { factor: "occupation", value: "Manager",        score: 10 },
  { factor: "occupation", value: "Clerical",       score: 20 },
  { factor: "occupation", value: "Admin",          score: 20 },
  { factor: "occupation", value: "Technician",     score: 30 },
  { factor: "occupation", value: "Skilled Trade",  score: 30 },
  { factor: "occupation", value: "Sales",          score: 30 },
  { factor: "occupation", value: "Machinery",      score: 30 },
  { factor: "occupation", value: "Service",        score: 40 },
  { factor: "occupation", value: "Labourer",       score: 40 },
  { factor: "occupation", value: "Business Owner", score: 40 },
  { factor: "occupation", value: "Unemployed",     score: 50 },
  { factor: "occupation", value: "Student",        score: 50 },
  { factor: "occupation", value: "Retiree",        score: 50 },

  // ── industry (entities) ──────────────────────────────────────────────────────
  { factor: "industry", value: "Professional Services", score: 10 },
  { factor: "industry", value: "Tech",                  score: 10 },
  { factor: "industry", value: "Technology",            score: 10 },
  { factor: "industry", value: "Electricity",           score: 10 },
  { factor: "industry", value: "Information Technology",score: 10 },
  { factor: "industry", value: "Public Administration", score: 10 },
  { factor: "industry", value: "Retail",                score: 20 },
  { factor: "industry", value: "Hospitality",           score: 20 },
  { factor: "industry", value: "Import-Export",         score: 30 },
  { factor: "industry", value: "Wholesale",             score: 30 },
  { factor: "industry", value: "Construction",          score: 40 },
  { factor: "industry", value: "Gambling",              score: 40 },
  { factor: "industry", value: "Financial Services",    score: 50 },
  { factor: "industry", value: "Real Estate",           score: 50 },
];

async function main() {
  await connectDB();
  console.log("Seeding RiskFactorOption…".cyan);

  const ops = SEED.map((item) => ({
    updateOne: {
      filter: { factor: item.factor, value: item.value },
      update:  { $set: item },
      upsert:  true,
    },
  }));

  const result = await RiskFactorOption.bulkWrite(ops, { ordered: false });
  console.log(
    `Done — upserted: ${result.upsertedCount}  modified: ${result.modifiedCount}  matched: ${result.matchedCount}`.green
  );

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
