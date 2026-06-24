/**
 * Seed Entity Types + License Types + Designated Services
 *
 * Run AFTER migrate-entity-type-names.js if the DB already has "Tranche X - " prefixed names.
 * Safe to re-run — all operations are upserts keyed by name / code.
 *
 * Run: node api/seeds/seedEntityTypes.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../config/config.env") });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
require("colors");

const EntityType        = require("../models/EntityType");
const LicenseType       = require("../models/LicenseType");
const DesignatedService = require("../models/DesignatedService");

const entityTypes = [
  // ── Tranche 1 ─────────────────────────────────────────────────────────────
  {
    name:          "Banks & ADIs",
    category:      "Tranche 1",
    riskModelRef:  "Banks/Financial Institutions Risk Model",
    description:   "Authorised Deposit-taking Institutions — banks, credit unions, building societies, mutual banks, and neobanks regulated under the Banking Act 1959.",
    matchKeywords: ["bank", "adi", "adis", "credit union", "building society", "mutual bank", "financial institution", "financial", "neobank", "authorised deposit"],
    active: true,
  },
  {
    name:          "Insurance",
    category:      "Tranche 1",
    riskModelRef:  "Banks/Financial Institutions Risk Model",
    description:   "Life insurers, general insurers, and insurance intermediaries providing designated insurance services under the AML/CTF Act.",
    matchKeywords: ["insurance", "insurer", "underwriter", "life insurance", "general insurance", "insurance broker", "insurance intermediary"],
    active: true,
  },
  {
    name:          "VASP/DCEP",
    category:      "Tranche 1",
    riskModelRef:  "VASP Risk Model",
    description:   "Virtual Asset Service Providers and Digital Currency Exchange Providers — crypto exchanges, NFT platforms, DeFi services, and digital asset custodians.",
    matchKeywords: ["vasp", "crypto", "cryptocurrency", "dcep", "digital asset", "digital currency", "nft", "defi", "blockchain", "virtual asset", "crypto exchange"],
    active: true,
  },
  {
    name:          "Remittance",
    category:      "Tranche 1",
    riskModelRef:  "Banks/Financial Institutions Risk Model",
    description:   "Registered AUSTRAC remittance service providers, money transfer businesses, IVTS and hawala operators.",
    matchKeywords: ["remittance", "money transfer", "forex", "foreign exchange", "wire transfer", "ivts", "hawala", "currency exchange", "money service"],
    active: true,
  },
  {
    name:          "Gambling/Casino",
    category:      "Tranche 1",
    riskModelRef:  "Banks/Financial Institutions Risk Model",
    description:   "Casino operators, wagering service providers, lottery operators, and online gambling platforms regulated under state gaming legislation.",
    matchKeywords: ["gambling", "casino", "betting", "wagering", "lottery", "gaming", "pokies", "online gambling", "sportsbet"],
    active: true,
  },

  // ── Tranche 2 (obligations commence 1 July 2026) ──────────────────────────
  {
    name:          "Accountants",
    category:      "Tranche 2",
    riskModelRef:  "Accountants Risk Model",
    description:   "Tax agents, BAS agents, public accountants, and bookkeeping services providing designated accounting services.",
    matchKeywords: ["accountant", "accounting", "cpa", "tax agent", "bookkeeper", "bookkeeping", "auditor", "audit firm", "chartered accountant", "bas agent"],
    active: true,
  },
  {
    name:          "Lawyers/Conveyancers",
    category:      "Tranche 2",
    riskModelRef:  "Real Estate / Lawyer / Conveyancer Risk Model",
    description:   "Law firms, barristers, solicitors, and licensed conveyancers providing designated legal or conveyancing services.",
    matchKeywords: ["lawyer", "conveyancer", "law firm", "solicitor", "barrister", "legal", "conveyancing", "settlement agent"],
    active: true,
  },
  {
    name:          "Real Estate Agents",
    category:      "Tranche 2",
    riskModelRef:  "Real Estate / Lawyer / Conveyancer Risk Model",
    description:   "Licensed real estate agencies, buyer's agents, and property managers buying or selling residential or commercial property.",
    matchKeywords: ["real estate", "realestate", "property agent", "real estate agent", "property manager", "buyer agent", "buyer's agent", "property"],
    active: true,
  },
  {
    name:          "Precious Metal Dealers",
    category:      "Tranche 2",
    riskModelRef:  "Precious Metal Dealers Risk Model",
    description:   "Dealers in bullion, precious metals (gold, silver, platinum), and precious stones including jewellers and pawnbrokers.",
    matchKeywords: ["precious metal", "jeweller", "jeweler", "gold dealer", "silver dealer", "bullion", "gemstone", "diamond", "pawn", "pawnbroker"],
    active: true,
  },
  {
    name:          "TCSPs",
    category:      "Tranche 2",
    riskModelRef:  "Accountants Risk Model",
    description:   "Trust and Company Service Providers — company formation agents, registered agents, nominee directors/shareholders, and trust administrators.",
    matchKeywords: ["tcsp", "trust company", "trust service", "company formation", "registered agent", "nominee director", "nominee shareholder", "trust administrator", "corporate trustee"],
    active: true,
  },
];

const licenseTypes = [
  { code: "AFSL",          name: "Australian Financial Services Licence (Full)",    regulator: "ASIC" },
  { code: "AFSL_LIMITED",  name: "Australian Financial Services Licence (Limited)", regulator: "ASIC" },
  { code: "AFSL_RE",       name: "Responsible Entity Licence",                      regulator: "ASIC" },
  { code: "ADI",           name: "Authorised Deposit-taking Institution Licence",   regulator: "APRA" },
  { code: "INSURER",       name: "Insurer Licence",                                 regulator: "APRA" },
  { code: "AUSTRAC_VASP",  name: "AUSTRAC VASP Registration",                       regulator: "AUSTRAC" },
  { code: "AUSTRAC_REMIT", name: "AUSTRAC Remittance Registration",                 regulator: "AUSTRAC" },
  { code: "NONE",          name: "None",                                             regulator: null },
];

const designatedServices = [
  { code: "BANKING",         name: "Banking (Deposits & Loans)",     applicableEntityTypes: ["Banks & ADIs"] },
  { code: "CUSTODY",         name: "Custody Services",               applicableEntityTypes: ["Banks & ADIs", "Insurance", "VASP/DCEP"] },
  { code: "FUND_MANAGEMENT", name: "Fund Management",                applicableEntityTypes: ["Banks & ADIs", "Insurance"] },
  { code: "CLIENT_MONEY",    name: "Client Money Handling",          applicableEntityTypes: ["Banks & ADIs", "Remittance"] },
  { code: "VASP_EXCHANGE",   name: "Virtual Asset Exchange",         applicableEntityTypes: ["VASP/DCEP"] },
  { code: "VASP_TRANSFER",   name: "Virtual Asset Transfer",         applicableEntityTypes: ["VASP/DCEP"] },
  { code: "REMITTANCE",      name: "Remittance Services",            applicableEntityTypes: ["Remittance"] },
  { code: "INSURANCE",       name: "Insurance Products",             applicableEntityTypes: ["Insurance"] },
  { code: "GAMBLING",        name: "Gambling/Casino Services",       applicableEntityTypes: ["Gambling/Casino"] },
  { code: "REAL_ESTATE",     name: "Real Estate Transactions",       applicableEntityTypes: ["Real Estate Agents"],      applicableDate: new Date("2026-07-01") },
  { code: "CONVEYANCING",    name: "Legal Services (Conveyancing)",  applicableEntityTypes: ["Lawyers/Conveyancers"],    applicableDate: new Date("2026-07-01") },
  { code: "ACCOUNTING",      name: "Accounting Services",            applicableEntityTypes: ["Accountants"],             applicableDate: new Date("2026-07-01") },
  { code: "TRUST_COMPANY",   name: "Trust & Company Services",       applicableEntityTypes: ["TCSPs"],                   applicableDate: new Date("2026-07-01") },
  { code: "PRECIOUS_METAL",  name: "Precious Metal Dealing",         applicableEntityTypes: ["Precious Metal Dealers"],  applicableDate: new Date("2026-07-01") },
];

async function seed() {
  await connectDB();
  console.log("Connected to MongoDB\n");

  // Entity Types — upsert by short name
  for (const et of entityTypes) {
    await EntityType.findOneAndUpdate({ name: et.name }, et, { upsert: true, new: true, runValidators: true });
    console.log(`  ✓ EntityType: ${et.name}`);
  }
  console.log(`\n✓ ${entityTypes.length} entity types seeded\n`);

  // License Types
  for (const lt of licenseTypes) {
    await LicenseType.findOneAndUpdate({ code: lt.code }, lt, { upsert: true, new: true });
  }
  console.log(`✓ ${licenseTypes.length} license types seeded\n`);

  // Designated Services
  for (const ds of designatedServices) {
    await DesignatedService.findOneAndUpdate({ code: ds.code }, ds, { upsert: true, new: true });
  }
  console.log(`✓ ${designatedServices.length} designated services seeded\n`);

  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
