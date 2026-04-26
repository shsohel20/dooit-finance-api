/**
 * Seed Country Risk — enrich existing records with extended FATF/AML fields
 * Run: node api/scripts/seedCountryRisk.js
 *
 * Filter key: `country` (lowercase) — matches existing DB documents.
 * Uses upsert so new countries are also inserted if missing.
 *
 * Sources: FATF Mutual Evaluation, Transparency International CPI,
 *          AUSTRAC guidance, OFAC sanctions list, Basel AML Index 2024
 */
require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
require("colors");
const CountryRisk = require("../models/CountryRisk");

// Title-case helper
const tc = (s) => s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

/**
 * c(country, band, score, code, region, ml, tf, sanc, corr, fatf, sanctioned, grey, black)
 *  country  — lowercase, matches existing `country` unique key
 *  band     — LRC / MRC / HRC / UHRC  (also sets riskTier)
 *  score    — existing numeric score (10/30/50/100)
 *  code     — ISO 2-letter country code
 *  region   — geographic region string
 *  ml-corr  — component risk scores 1–5
 *  fatf     — FATF membership status
 *  sanctioned / grey / black — flags
 */
const c = (
  country, band, score, code, region,
  ml, tf, sanc, corr, fatf,
  sanctioned = false, grey = false, black = false,
) => ({
  country,
  band,
  score,
  countryCode:  code,
  countryName:  tc(country),
  region,
  riskTier:     band,
  overallScore: Math.round(((ml + tf + sanc + corr) / 4) * 10) / 10,
  mlRiskScore:      ml,
  tfRiskScore:      tf,
  sanctionsRisk:    sanc,
  corruptionScore:  corr,
  fatfStatus:       fatf,
  isSanctioned:     sanctioned,
  isHighRiskByFATF: grey || black,
  isFATFBlackList:  black,
  lastUpdated: new Date("2025-01-01"),
  active: true,
});

const countries = [
  // ─────────────────────────────────────────────────────────────────────────
  // LRC — Low Risk Countries (score 10)
  // ─────────────────────────────────────────────────────────────────────────
  c("australia",    "LRC",10,"AU","Oceania",          1,1,1,1,"Member"),
  c("austria",      "LRC",10,"AT","Europe",           1,1,1,1,"Member"),
  c("belgium",      "LRC",10,"BE","Europe",           1,1,1,1,"Member"),
  c("canada",       "LRC",10,"CA","Americas",         1,1,1,1,"Member"),
  c("czech republic","LRC",10,"CZ","Europe",          1,1,1,2,"Member"),
  c("denmark",      "LRC",10,"DK","Europe",           1,1,1,1,"Member"),
  c("finland",      "LRC",10,"FI","Europe",           1,1,1,1,"Member"),
  c("france",       "LRC",10,"FR","Europe",           1,1,1,1,"Member"),
  c("germany",      "LRC",10,"DE","Europe",           1,1,1,1,"Member"),
  c("iceland",      "LRC",10,"IS","Europe",           1,1,1,1,"Member"),
  c("ireland",      "LRC",10,"IE","Europe",           1,1,1,1,"Member"),
  c("italy",        "LRC",10,"IT","Europe",           1,1,1,2,"Member"),
  c("japan",        "LRC",10,"JP","Asia",             1,1,1,1,"Member"),
  c("korea, south", "LRC",10,"KR","Asia",             2,2,1,2,"Member"),
  c("netherlands",  "LRC",10,"NL","Europe",           1,1,1,1,"Member"),
  c("new zealand",  "LRC",10,"NZ","Oceania",          1,1,1,1,"Member"),
  c("norway",       "LRC",10,"NO","Europe",           1,1,1,1,"Member"),
  c("poland",       "LRC",10,"PL","Europe",           1,1,1,2,"Member"),
  c("portugal",     "LRC",10,"PT","Europe",           1,1,1,2,"Member"),
  c("singapore",    "LRC",10,"SG","Asia",             1,1,1,1,"Member"),
  c("spain",        "LRC",10,"ES","Europe",           1,1,1,2,"Member"),
  c("sweden",       "LRC",10,"SE","Europe",           1,1,1,1,"Member"),
  c("switzerland",  "LRC",10,"CH","Europe",           1,1,1,1,"Member"),
  c("united kingdom","LRC",10,"GB","Europe",          1,1,1,1,"Member"),
  c("united states","LRC",10,"US","Americas",         2,2,1,2,"Member"),
  // Aliases
  c("uk",           "LRC",10,"GB","Europe",           1,1,1,1,"Member"),
  c("usa",          "LRC",10,"US","Americas",         2,2,1,2,"Member"),
  c("us",           "LRC",10,"US","Americas",         2,2,1,2,"Member"),
  c("south korea",  "LRC",10,"KR","Asia",             2,2,1,2,"Member"),

  // ─────────────────────────────────────────────────────────────────────────
  // MRC — Medium Risk Countries (score 30)
  // ─────────────────────────────────────────────────────────────────────────
  c("andorra",                        "MRC",30,"AD","Europe",          2,2,2,2,"Member"),
  c("antigua and barbuda",            "MRC",30,"AG","Americas",        2,2,2,3,"Member"),
  c("argentina",                      "MRC",30,"AR","Americas",        3,2,2,3,"Member"),
  c("armenia",                        "MRC",30,"AM","Asia",            2,2,2,3,"Member"),
  c("azerbaijan",                     "MRC",30,"AZ","Asia",            3,2,2,4,"Member"),
  c("bahrain",                        "MRC",30,"BH","Middle East",     2,2,2,3,"Member"),
  c("bangladesh",                     "MRC",30,"BD","Asia",            3,3,2,3,"Member"),
  c("belize",                         "MRC",30,"BZ","Americas",        3,2,2,3,"Member"),
  c("bhutan",                         "MRC",30,"BT","Asia",            2,2,2,2,"Non-Member"),
  c("botswana",                       "MRC",30,"BW","Africa",          2,2,2,3,"Member"),
  c("brazil",                         "MRC",30,"BR","Americas",        3,2,2,3,"Member"),
  c("brunei",                         "MRC",30,"BN","Asia",            2,2,2,2,"Member"),
  c("burundi",                        "MRC",30,"BI","Africa",          3,3,2,4,"Non-Member"),
  c("cambodia",                       "MRC",30,"KH","Asia",            3,3,2,4,"Member"),
  c("chile",                          "MRC",30,"CL","Americas",        2,2,1,2,"Member"),
  c("china",                          "MRC",30,"CN","Asia",            3,3,2,3,"Member"),
  c("colombia",                       "MRC",30,"CO","Americas",        3,3,2,3,"Member"),
  c("comoros",                        "MRC",30,"KM","Africa",          3,2,2,3,"Non-Member"),
  c("costa rica",                     "MRC",30,"CR","Americas",        2,2,2,3,"Member"),
  c("djibouti",                       "MRC",30,"DJ","Africa",          3,2,2,3,"Non-Member"),
  c("dominica",                       "MRC",30,"DM","Americas",        2,2,2,3,"Member"),
  c("dominican republic",             "MRC",30,"DO","Americas",        3,2,2,3,"Member"),
  c("east timor",                     "MRC",30,"TL","Asia",            2,2,2,3,"Non-Member"),
  c("timor-leste",                    "MRC",30,"TL","Asia",            2,2,2,3,"Non-Member"),
  c("ecuador",                        "MRC",30,"EC","Americas",        3,2,2,3,"Member"),
  c("egypt",                          "MRC",30,"EG","Africa/Middle East",3,3,2,3,"Member"),
  c("el salvador",                    "MRC",30,"SV","Americas",        3,2,2,3,"Member"),
  c("equatorial guinea",              "MRC",30,"GQ","Africa",          3,2,2,4,"Non-Member"),
  c("eritrea",                        "MRC",30,"ER","Africa",          3,3,2,4,"Non-Member"),
  c("estonia",                        "MRC",30,"EE","Europe",          2,2,2,2,"Member"),
  c("ethiopia",                       "MRC",30,"ET","Africa",          3,3,2,4,"Member"),
  c("fiji",                           "MRC",30,"FJ","Oceania",         2,2,2,3,"Member"),
  c("georgia",                        "MRC",30,"GE","Asia",            2,2,2,3,"Member"),
  c("greece",                         "MRC",30,"GR","Europe",          2,2,2,3,"Member"),
  c("grenada",                        "MRC",30,"GD","Americas",        2,2,2,3,"Member"),
  c("guatemala",                      "MRC",30,"GT","Americas",        3,2,2,3,"Member"),
  c("guinea",                         "MRC",30,"GN","Africa",          3,3,2,4,"Member"),
  c("guyana",                         "MRC",30,"GY","Americas",        3,2,2,3,"Member"),
  c("honduras",                       "MRC",30,"HN","Americas",        3,3,2,4,"Member"),
  c("hungary",                        "MRC",30,"HU","Europe",          2,2,2,2,"Member"),
  c("india",                          "MRC",30,"IN","Asia",            2,2,2,3,"Member"),
  c("indonesia",                      "MRC",30,"ID","Asia",            2,2,2,3,"Member"),
  c("israel",                         "MRC",30,"IL","Middle East",     2,2,2,3,"Member"),
  c("jordan",                         "MRC",30,"JO","Middle East",     2,2,2,3,"Member"),
  c("kazakhstan",                     "MRC",30,"KZ","Asia",            3,2,2,3,"Member"),
  c("kiribati",                       "MRC",30,"KI","Oceania",         2,2,2,3,"Non-Member"),
  c("kyrgyzstan",                     "MRC",30,"KG","Asia",            3,2,2,3,"Member"),
  c("latvia",                         "MRC",30,"LV","Europe",          2,2,2,2,"Member"),
  c("lesotho",                        "MRC",30,"LS","Africa",          2,2,2,3,"Non-Member"),
  c("lithuania",                      "MRC",30,"LT","Europe",          2,2,2,2,"Member"),
  c("madagascar",                     "MRC",30,"MG","Africa",          3,2,2,3,"Non-Member"),
  c("malawi",                         "MRC",30,"MW","Africa",          3,2,2,4,"Non-Member"),
  c("malaysia",                       "MRC",30,"MY","Asia",            2,2,2,2,"Member"),
  c("maldives",                       "MRC",30,"MV","Asia",            2,2,2,3,"Member"),
  c("mexico",                         "MRC",30,"MX","Americas",        3,3,2,3,"Member"),
  c("micronesia, federated states of","MRC",30,"FM","Oceania",         2,2,2,2,"Non-Member"),
  c("moldova",                        "MRC",30,"MD","Europe",          3,2,2,3,"Member"),
  c("mongolia",                       "MRC",30,"MN","Asia",            2,2,2,3,"Member"),
  c("morocco",                        "MRC",30,"MA","Africa",          3,3,2,3,"Member"),
  c("oman",                           "MRC",30,"OM","Middle East",     2,2,2,3,"Member"),
  c("palau",                          "MRC",30,"PW","Oceania",         2,2,2,2,"Non-Member"),
  c("paraguay",                       "MRC",30,"PY","Americas",        3,2,2,3,"Member"),
  c("peru",                           "MRC",30,"PE","Americas",        3,2,2,3,"Member"),
  c("qatar",                          "MRC",30,"QA","Middle East",     2,2,2,3,"Member"),
  c("rwanda",                         "MRC",30,"RW","Africa",          2,2,2,3,"Member"),
  c("saint lucia",                    "MRC",30,"LC","Americas",        2,2,2,3,"Member"),
  c("saint vincent and the grenadines","MRC",30,"VC","Americas",       2,2,2,3,"Member"),
  c("san marino",                     "MRC",30,"SM","Europe",          2,2,2,2,"Member"),
  c("sao tome and principe",          "MRC",30,"ST","Africa",          2,2,2,3,"Non-Member"),
  c("saudi arabia",                   "MRC",30,"SA","Middle East",     2,2,2,3,"Member"),
  c("seychelles",                     "MRC",30,"SC","Africa",          2,2,2,3,"Member"),
  c("slovakia",                       "MRC",30,"SK","Europe",          2,2,2,2,"Member"),
  c("sri lanka",                      "MRC",30,"LK","Asia",            3,2,2,3,"Member"),
  c("taiwan",                         "MRC",30,"TW","Asia",            2,2,2,2,"Observer"),
  c("tajikistan",                     "MRC",30,"TJ","Asia",            3,2,2,4,"Member"),
  c("thailand",                       "MRC",30,"TH","Asia",            2,2,2,3,"Member"),
  c("the bahamas",                    "MRC",30,"BS","Americas",        2,2,2,3,"Member"),
  c("the gambia",                     "MRC",30,"GM","Africa",          3,2,2,3,"Non-Member"),
  c("tonga",                          "MRC",30,"TO","Oceania",         2,2,2,3,"Non-Member"),
  c("tunisia",                        "MRC",30,"TN","Africa",          3,3,2,3,"Member"),
  c("turkmenistan",                   "MRC",30,"TM","Asia",            3,2,2,4,"Non-Member"),
  c("tuvalu",                         "MRC",30,"TV","Oceania",         2,2,2,3,"Non-Member"),
  c("united arab emirates",           "MRC",30,"AE","Middle East",     3,3,2,3,"Member"),
  c("uruguay",                        "MRC",30,"UY","Americas",        2,2,2,2,"Member"),
  c("uzbekistan",                     "MRC",30,"UZ","Asia",            3,2,2,3,"Member"),
  c("vatican city state",             "MRC",30,"VA","Europe",          2,2,2,2,"Non-Member"),
  c("zambia",                         "MRC",30,"ZM","Africa",          3,2,2,3,"Non-Member"),

  // ─────────────────────────────────────────────────────────────────────────
  // HRC — High Risk Countries (score 50)
  // ─────────────────────────────────────────────────────────────────────────
  c("albania",                "HRC",50,"AL","Europe",          3,3,2,4,"Member"),
  c("algeria",                "HRC",50,"DZ","Africa/Middle East",3,3,2,4,"Member"),
  c("american samoa",         "HRC",50,"AS","Oceania",         3,2,2,3,"Non-Member"),
  c("angola",                 "HRC",50,"AO","Africa",          4,3,3,4,"Non-Member"),
  c("barbados",               "HRC",50,"BB","Americas",        3,2,2,3,"Member"),
  c("benin",                  "HRC",50,"BJ","Africa",          3,3,2,4,"Non-Member"),
  c("bermuda",                "HRC",50,"BM","Americas",        2,2,2,3,"Member"),
  c("bolivia",                "HRC",50,"BO","Americas",        3,3,2,4,"Member"),
  c("british virgin islands", "HRC",50,"VG","Americas",        3,2,3,3,"Member"),
  c("bulgaria",               "HRC",50,"BG","Europe",          3,3,2,3,"Member"),
  c("burkina faso",           "HRC",50,"BF","Africa",          4,4,3,4,"Grey List",   false,true,false),
  c("cameroon",               "HRC",50,"CM","Africa",          3,3,2,4,"Non-Member"),
  c("cape verde",             "HRC",50,"CV","Africa",          3,2,2,3,"Non-Member"),
  c("cayman islands",         "HRC",50,"KY","Americas",        3,2,3,3,"Member"),
  c("chad",                   "HRC",50,"TD","Africa",          4,3,3,5,"Non-Member"),
  c("cote d'ivoire",          "HRC",50,"CI","Africa",          3,3,2,4,"Non-Member"),
  c("cyprus",                 "HRC",50,"CY","Europe",          3,3,2,4,"Member"),
  c("eswatini",               "HRC",50,"SZ","Africa",          3,2,2,4,"Non-Member"),
  c("gabon",                  "HRC",50,"GA","Africa",          3,2,2,4,"Non-Member"),
  c("ghana",                  "HRC",50,"GH","Africa",          3,2,2,3,"Member"),
  c("gibraltar",              "HRC",50,"GI","Europe",          2,2,2,3,"Member"),
  c("haiti",                  "HRC",50,"HT","Americas",        4,3,3,5,"Grey List",   false,true,false),
  c("isle of man",            "HRC",50,"IM","Europe",          2,2,2,3,"Member"),
  c("jamaica",                "HRC",50,"JM","Americas",        4,3,3,4,"Grey List",   false,true,false),
  c("kenya",                  "HRC",50,"KE","Africa",          3,3,2,3,"Member"),
  c("kuwait",                 "HRC",50,"KW","Middle East",     3,3,2,3,"Member"),
  c("lao pdr",                "HRC",50,"LA","Asia",            4,3,3,4,"Grey List",   false,true,false),
  c("laos",                   "HRC",50,"LA","Asia",            4,3,3,4,"Grey List",   false,true,false),
  c("liberia",                "HRC",50,"LR","Africa",          3,3,3,4,"Non-Member"),
  c("liechtenstein",          "HRC",50,"LI","Europe",          2,2,2,2,"Member"),
  c("luxembourg",             "HRC",50,"LU","Europe",          2,2,2,2,"Member"),
  c("mali",                   "HRC",50,"ML","Africa",          4,4,4,5,"Grey List",   false,true,false),
  c("malta",                  "HRC",50,"MT","Europe",          3,2,2,3,"Member"),
  c("marshall islands",       "HRC",50,"MH","Oceania",         3,2,3,3,"Non-Member"),
  c("mauritania",             "HRC",50,"MR","Africa",          3,3,3,4,"Non-Member"),
  c("mauritius",              "HRC",50,"MU","Africa",          3,2,2,3,"Member"),
  c("monaco",                 "HRC",50,"MC","Europe",          2,2,2,2,"Member"),
  c("mozambique",             "HRC",50,"MZ","Africa",          4,3,3,4,"Grey List",   false,true,false),
  c("namibia",                "HRC",50,"NA","Africa",          3,2,2,3,"Member"),
  c("nauru",                  "HRC",50,"NR","Oceania",         3,2,3,3,"Non-Member"),
  c("nepal",                  "HRC",50,"NP","Asia",            3,3,2,4,"Member"),
  c("nicaragua",              "HRC",50,"NI","Americas",        4,3,4,4,"Grey List",   false,true,false),
  c("niger",                  "HRC",50,"NE","Africa",          4,3,3,4,"Non-Member"),
  c("nigeria",                "HRC",50,"NG","Africa",          3,3,2,4,"Member"),
  c("pakistan",               "HRC",50,"PK","Asia",            3,4,3,4,"Member"),
  c("panama",                 "HRC",50,"PA","Americas",        3,3,3,4,"Member"),
  c("papua new guinea",       "HRC",50,"PG","Oceania",         4,3,3,4,"Grey List",   false,true,false),
  c("philippines",            "HRC",50,"PH","Asia",            3,2,2,3,"Member"),
  c("romania",                "HRC",50,"RO","Europe",          3,2,2,3,"Member"),
  c("saint kitts and nevis",  "HRC",50,"KN","Americas",        2,2,2,3,"Member"),
  c("samoa",                  "HRC",50,"WS","Oceania",         2,2,2,3,"Member"),
  c("senegal",                "HRC",50,"SN","Africa",          3,3,3,4,"Grey List",   false,true,false),
  c("sierra leone",           "HRC",50,"SL","Africa",          3,3,2,4,"Non-Member"),
  c("solomon islands",        "HRC",50,"SB","Oceania",         3,2,2,3,"Non-Member"),
  c("south africa",           "HRC",50,"ZA","Africa",          3,2,2,3,"Member"),
  c("suriname",               "HRC",50,"SR","Americas",        3,2,2,3,"Member"),
  c("tanzania",               "HRC",50,"TZ","Africa",          4,3,3,4,"Grey List",   false,true,false),
  c("togo",                   "HRC",50,"TG","Africa",          3,3,2,4,"Non-Member"),
  c("trinidad and tobago",    "HRC",50,"TT","Americas",        3,3,3,3,"Member"),
  c("turkey",                 "HRC",50,"TR","Europe/Asia",     3,3,2,3,"Member"),
  c("uganda",                 "HRC",50,"UG","Africa",          4,4,3,4,"Grey List",   false,true,false),
  c("vanuatu",                "HRC",50,"VU","Oceania",         3,2,3,3,"Member"),
  c("vietnam",                "HRC",50,"VN","Asia",            3,2,2,3,"Member"),

  // ─────────────────────────────────────────────────────────────────────────
  // UHRC — Ultra-High Risk / Sanctioned (score 100)
  // ─────────────────────────────────────────────────────────────────────────
  c("afghanistan",                               "UHRC",100,"AF","Asia",          5,5,5,5,"Black List", true, false,true),
  c("belarus",                                   "UHRC",100,"BY","Europe",        4,4,4,4,"Member",     true, false,false),
  c("bosnia and herzegovina",                    "UHRC",100,"BA","Europe",        4,3,3,4,"Member",     false,false,false),
  c("burma",                                     "UHRC",100,"MM","Asia",          5,4,4,5,"Black List", false,false,true),
  c("central african republic",                  "UHRC",100,"CF","Africa",        5,4,4,5,"Non-Member", true, false,false),
  c("croatia",                                   "UHRC",100,"HR","Europe",        2,2,2,2,"Member",     false,false,false),
  c("cuba",                                      "UHRC",100,"CU","Americas",      4,4,5,4,"Non-Member", true, false,false),
  c("democratic people's republic of korea (north korea)","UHRC",100,"KP","Asia", 5,5,5,5,"Black List", true, false,true),
  c("democratic republic of the congo",          "UHRC",100,"CD","Africa",        4,4,3,5,"Non-Member", true, false,false),
  c("guinea-bissau",                             "UHRC",100,"GW","Africa",        4,4,3,5,"Grey List",  false,true, false),
  c("iran",                                      "UHRC",100,"IR","Middle East",   5,5,5,5,"Black List", true, false,true),
  c("iraq",                                      "UHRC",100,"IQ","Middle East",   4,4,4,5,"Grey List",  false,true, false),
  c("lebanon",                                   "UHRC",100,"LB","Middle East",   4,4,4,5,"Grey List",  false,true, false),
  c("libya",                                     "UHRC",100,"LY","Africa",        4,4,4,5,"Grey List",  false,true, false),
  c("macedonia",                                 "UHRC",100,"MK","Europe",        3,3,3,4,"Member",     false,false,false),
  c("montenegro",                                "UHRC",100,"ME","Europe",        3,3,3,3,"Member",     false,false,false),
  c("myanmar",                                   "UHRC",100,"MM","Asia",          5,4,4,5,"Black List", false,false,true),
  c("russia",                                    "UHRC",100,"RU","Europe",        5,5,5,5,"Member",     true, false,false),
  c("serbia (including kosovo and vojvodina)",   "UHRC",100,"RS","Europe",        3,3,3,3,"Member",     false,false,false),
  c("slovenia",                                  "UHRC",100,"SI","Europe",        2,2,2,2,"Member",     false,false,false),
  c("somalia",                                   "UHRC",100,"SO","Africa",        5,5,5,5,"Non-Member", true, false,false),
  c("south sudan",                               "UHRC",100,"SS","Africa",        5,5,5,5,"Non-Member", false,false,false),
  c("sudan",                                     "UHRC",100,"SD","Africa",        5,5,5,5,"Non-Member", true, false,false),
  c("syria",                                     "UHRC",100,"SY","Middle East",   5,5,5,5,"Black List", true, false,true),
  c("ukraine",                                   "UHRC",100,"UA","Europe",        3,3,3,4,"Member",     false,false,false),
  c("venezuela",                                 "UHRC",100,"VE","Americas",      4,4,5,5,"Non-Member", true, false,false),
  c("yemen",                                     "UHRC",100,"YE","Middle East",   4,5,5,5,"Non-Member", true, false,false),
  c("zimbabwe",                                  "UHRC",100,"ZW","Africa",        4,3,4,5,"Non-Member", true, false,false),
];

async function seed() {
  await connectDB();
  console.log("Connected to MongoDB".cyan);

  // Deduplicate by country name (keep last occurrence)
  const unique = Object.values(
    Object.fromEntries(countries.map((c) => [c.country, c]))
  );

  // Filter by `country` (lowercase) — matches existing unique key
  const ops = unique.map((item) => ({
    updateOne: {
      filter: { country: item.country },
      update:  { $set: item },
      upsert:  true,
    },
  }));

  const result = await CountryRisk.bulkWrite(ops, { ordered: false });

  console.log(`✓ ${unique.length} countries processed`.green);
  console.log(`  Upserted: ${result.upsertedCount}  Modified: ${result.modifiedCount}`.gray);
  console.log([
    `  UHRC: ${unique.filter(c=>c.band==="UHRC").length}`,
    `HRC: ${unique.filter(c=>c.band==="HRC").length}`,
    `MRC: ${unique.filter(c=>c.band==="MRC").length}`,
    `LRC: ${unique.filter(c=>c.band==="LRC").length}`,
  ].join("  ").gray);

  await mongoose.disconnect();
  console.log("Done.".gray);
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
