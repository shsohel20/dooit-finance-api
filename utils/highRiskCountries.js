// utils/riskJurisdiction.js

/**
 * Customer Risk Assessment - Country Risk Classification
 * Based on AML / CTF compliance lists (UHRC, HRC, MRC, LRC)
 *
 * Scores:
 * - UHRC = 100  (Ultra High Risk - Unacceptable)
 * - HRC  = 5    (High Risk)
 * - MRC  = 3    (Medium Risk)
 * - LRC  = 1    (Low Risk)
 */

const UHRC = new Set([
  "afghanistan",
  "belarus",
  "bosnia and herzegovina",
  "central african republic",
  "croatia",
  "cuba",
  "democratic people’s republic of korea",
  "north korea",
  "democratic republic of the congo",
  "guinea-bissau",
  "iran",
  "iraq",
  "lebanon",
  "libya",
  "macedonia",
  "montenegro",
  "myanmar",
  "burma",
  "russia",
  "serbia",
  "kosovo",
  "vojvodina",
  "slovenia",
  "somalia",
  "south sudan",
  "sudan",
  "syria",
  "ukraine",
  "venezuela",
  "yemen",
  "zimbabwe",
]);

const HRC = new Set([
  "albania",
  "algeria",
  "american samoa",
  "angola",
  "barbados",
  "benin",
  "bermuda",
  "bolivia",
  "british virgin islands",
  "bulgaria",
  "burkina faso",
  "cameroon",
  "cape verde",
  "cayman islands",
  "chad",
  "cote d'ivoire",
  "eswatini",
  "gabon",
  "ghana",
  "gibraltar",
  "haiti",
  "isle of man",
  "jamaica",
  "kenya",
  "lao pdr",
  "liberia",
  "luxembourg",
  "mali",
  "malta",
  "mauritania",
  "mauritius",
  "mozambique",
  "namibia",
  "nepal",
  "nicaragua",
  "niger",
  "nigeria",
  "pakistan",
  "panama",
  "philippines",
  "romania",
  "saint kitts and nevis",
  "samoa",
  "senegal",
  "sierra leone",
  "solomon islands",
  "south africa",
  "suriname",
  "tanzania",
  "liechtenstein",
  "monaco",
  "nauru",
  "marshall islands",
  "togo",
  "trinidad and tobago",
  "turkey",
  "uganda",
  "vanuatu",
  "vietnam",
]);

const MRC = new Set([
  "andorra",
  "antigua and barbuda",
  "argentina",
  "armenia",
  "azerbaijan",
  "bahrain",
  "bangladesh",
  "belize",
  "bhutan",
  "botswana",
  "brazil",
  "brunei",
  "burundi",
  "cambodia",
  "chile",
  "china",
  "colombia",
  "comoros",
  "congo",
  "republic of the congo",
  "costa rica",
  "djibouti",
  "dominica",
  "dominican republic",
  "east timor",
  "timor-leste",
  "ecuador",
  "egypt",
  "el salvador",
  "equatorial guinea",
  "eritrea",
  "estonia",
  "ethiopia",
  "fiji",
  "georgia",
  "greece",
  "grenada",
  "guatemala",
  "guinea",
  "guyana",
  "honduras",
  "hungary",
  "india",
  "indonesia",
  "israel",
  "jordan",
  "kazakhstan",
  "kiribati",
  "kuwait",
  "kyrgyzstan",
  "latvia",
  "lesotho",
  "lithuania",
  "madagascar",
  "malawi",
  "malaysia",
  "maldives",
  "mexico",
  "micronesia",
  "moldova",
  "mongolia",
  "morocco",
  "oman",
  "palau",
  "papua new guinea",
  "paraguay",
  "peru",
  "qatar",
  "rwanda",
  "saint lucia",
  "saint vincent and the grenadines",
  "san marino",
  "sao tome and principe",
  "saudi arabia",
  "seychelles",
  "slovakia",
  "sri lanka",
  "taiwan",
  "tajikistan",
  "thailand",
  "bahamas",
  "gambia",
  "tonga",
  "tunisia",
  "turkmenistan",
  "tuvalu",
  "united arab emirates",
  "uruguay",
  "uzbekistan",
  "vatican city",
  "zambia",
]);

const LRC = new Set([
  "australia",
  "austria",
  "belgium",
  "canada",
  "czech republic",
  "denmark",
  "finland",
  "france",
  "germany",
  "iceland",
  "ireland",
  "italy",
  "japan",
  "korea, south",
  "south korea",
  "netherlands",
  "new zealand",
  "norway",
  "poland",
  "portugal",
  "singapore",
  "spain",
  "sweden",
  "switzerland",
  "united kingdom",
  "uk",
  "united states",
  "usa",
]);

/**
 * Determine jurisdiction risk based on country name.
 * Returns { value, score, description }
 */
function getJurisdictionRisk(countryName) {
  if (!countryName)
    return {
      value: "Unknown",
      score: 0,
      description: "No country specified",
    };

  const normalized = countryName.toLowerCase().trim();

  if (UHRC.has(normalized)) {
    return {
      value: "UHRC - Ultra High Risk Country",
      score: 50,
      description: "Sanctioned countries (Unacceptable)",
    };
  }

  if (HRC.has(normalized)) {
    return {
      value: "HRC - High Risk Country",
      score: 40,
      description: "Tax havens, Basel > 6, FATF grey list",
    };
  }

  if (MRC.has(normalized)) {
    return {
      value: "MRC - Medium Risk Country",
      score: 20,
      description: "Remaining countries",
    };
  }

  if (LRC.has(normalized)) {
    return {
      value: "LRC - Low Risk Country",
      score: 10,
      description: "Basel AML Index < 4.71",
    };
  }

  return {
    value: "Unknown Country",
    score: 0,
    description: "Not found in risk classification list",
  };
}

module.exports = {
  getJurisdictionRisk,
  UHRC,
  HRC,
  MRC,
  LRC,
};
