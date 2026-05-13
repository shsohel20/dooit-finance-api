/**
 * Seed Entity Types + License Types + Designated Services
 * Run: node api/scripts/seedEntityTypes.js
 */
require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
require("colors");

const EntityType = require("../models/EntityType");
const LicenseType = require("../models/LicenseType");
const DesignatedService = require("../models/DesignatedService");

const entityTypes = [
  // Tranche 1
  { name: "Tranche 1 - Banks & ADIs",      category: "Tranche 1", riskModelRef: "Banks/Financial Institutions Risk Model",       description: "Authorised Deposit-taking Institutions regulated under the Banking Act" },
  { name: "Tranche 1 - Insurance",          category: "Tranche 1", riskModelRef: "Banks/Financial Institutions Risk Model",       description: "Life insurers and friendly societies providing designated insurance services" },
  { name: "Tranche 1 - VASP/DCEP",         category: "Tranche 1", riskModelRef: "VASP Risk Model",                              description: "Virtual Asset Service Providers and Digital Currency Exchange Providers" },
  { name: "Tranche 1 - Remittance",         category: "Tranche 1", riskModelRef: "Banks/Financial Institutions Risk Model",       description: "Registered AUSTRAC remittance providers (money transfer services)" },
  { name: "Tranche 1 - Gambling/Casino",    category: "Tranche 1", riskModelRef: "Banks/Financial Institutions Risk Model",       description: "Casino operators and gambling service providers" },
  // Tranche 2 (from 1 July 2026)
  { name: "Tranche 2 - Accountants",        category: "Tranche 2", riskModelRef: "Accountants Risk Model",                       description: "Tax agents, BAS agents, and public accountants" },
  { name: "Tranche 2 - Lawyers/Conveyancers", category: "Tranche 2", riskModelRef: "Real Estate / Lawyer / Conveyancer Risk Model", description: "Legal professionals and licensed conveyancers" },
  { name: "Tranche 2 - Real Estate",        category: "Tranche 2", riskModelRef: "Real Estate / Lawyer / Conveyancer Risk Model", description: "Real estate agents, buyer's agents, and property managers" },
  { name: "Tranche 2 - Precious Metal Dealers", category: "Tranche 2", riskModelRef: "Precious Metal Dealers Risk Model",        description: "Dealers in bullion, precious metals, and precious stones" },
  { name: "Tranche 2 - TCSPs",             category: "Tranche 2", riskModelRef: "Accountants Risk Model",                       description: "Trust and Company Service Providers" },
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
  { code: "BANKING",         name: "Banking (Deposits & Loans)",     applicableEntityTypes: ["Tranche 1 - Banks & ADIs"] },
  { code: "CUSTODY",         name: "Custody Services",               applicableEntityTypes: ["Tranche 1"] },
  { code: "FUND_MANAGEMENT", name: "Fund Management",                applicableEntityTypes: ["Tranche 1"] },
  { code: "CLIENT_MONEY",    name: "Client Money Handling",          applicableEntityTypes: ["Tranche 1"] },
  { code: "VASP_EXCHANGE",   name: "Virtual Asset Exchange",         applicableEntityTypes: ["Tranche 1 - VASP/DCEP"] },
  { code: "VASP_TRANSFER",   name: "Virtual Asset Transfer",         applicableEntityTypes: ["Tranche 1 - VASP/DCEP"] },
  { code: "REMITTANCE",      name: "Remittance Services",            applicableEntityTypes: ["Tranche 1 - Remittance"] },
  { code: "INSURANCE",       name: "Insurance Products",             applicableEntityTypes: ["Tranche 1 - Insurance"] },
  { code: "GAMBLING",        name: "Gambling/Casino Services",       applicableEntityTypes: ["Tranche 1 - Gambling/Casino"] },
  { code: "REAL_ESTATE",     name: "Real Estate Transactions",       applicableEntityTypes: ["Tranche 2 - Real Estate"],     applicableDate: new Date("2026-07-01") },
  { code: "CONVEYANCING",    name: "Legal Services (Conveyancing)",  applicableEntityTypes: ["Tranche 2 - Lawyers/Conveyancers"], applicableDate: new Date("2026-07-01") },
  { code: "ACCOUNTING",      name: "Accounting Services",            applicableEntityTypes: ["Tranche 2 - Accountants"],     applicableDate: new Date("2026-07-01") },
  { code: "TRUST_COMPANY",   name: "Trust & Company Services",       applicableEntityTypes: ["Tranche 2 - TCSPs"],           applicableDate: new Date("2026-07-01") },
  { code: "PRECIOUS_METAL",  name: "Precious Metal Dealing",         applicableEntityTypes: ["Tranche 2 - Precious Metal Dealers"], applicableDate: new Date("2026-07-01") },
];

async function seed() {
  await connectDB();
  console.log("Connected to MongoDB");

  // Entity Types
  for (const et of entityTypes) {
    await EntityType.findOneAndUpdate({ name: et.name }, et, { upsert: true, new: true });
  }
  console.log(`✓ ${entityTypes.length} entity types seeded`);

  // License Types
  for (const lt of licenseTypes) {
    await LicenseType.findOneAndUpdate({ code: lt.code }, lt, { upsert: true, new: true });
  }
  console.log(`✓ ${licenseTypes.length} license types seeded`);

  // Designated Services
  for (const ds of designatedServices) {
    await DesignatedService.findOneAndUpdate({ code: ds.code }, ds, { upsert: true, new: true });
  }
  console.log(`✓ ${designatedServices.length} designated services seeded`);

  await mongoose.disconnect();
  console.log("Done. Disconnected.");
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
