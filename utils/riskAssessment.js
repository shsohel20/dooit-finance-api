// utils/riskAssessment.js
"use strict";

const dayjs = require("dayjs");

/**
 * Jurisdiction bands from CRA doc (lowercased).
 * Extend these lists if you need more entries.
 */
const UHRC = new Set([
  "afghanistan",
  "belarus",
  "bosnia and herzegovina",
  "central african republic",
  "croatia",
  "cuba",
  "democratic people's republic of korea (north korea)",
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
  "serbia (including kosovo and vojvodina)",
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
  "cyprus",
  "eswatini",
  "gabon",
  "ghana",
  "gibraltar",
  "haiti",
  "isle of man",
  "jamaica",
  "kenya",
  "lao pdr",
  "laos",
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
  "micronesia, federated states of",
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
  "the bahamas",
  "the gambia",
  "tonga",
  "tunisia",
  "turkmenistan",
  "tuvalu",
  "united arab emirates",
  "uruguay",
  "uzbekistan",
  "vatican city state",
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
  "united states",
  // common variants kept for convenience (optional)
  "uk",
  "usa",
  "us",
  "south korea",
]);

/** canonical FACTORS (from your doc). Exported for reuse/testing */
const FACTORS = {
  customerType: [
    { value: "government_body", score: 10 },
    { value: "individual", score: 20 },
    { value: "sole proprietorship", score: 20 },
    { value: "association", score: 30 },
    { value: "cooperative", score: 30 },
    { value: "company", score: 40 },
    { value: "partnership", score: 40 },
    { value: "trust", score: 50 },
  ],
  jurisdiction: [
    { value: "LRC", score: 10 },
    { value: "MRC", score: 30 },
    { value: "HRC", score: 50 },
    { value: "UHRC", score: 100 }, // triggers unacceptable
  ],
  customerRetention: [
    { value: "3+ Years", score: 10 },
    { value: "1-3 Years", score: 20 },
    { value: "New", score: 30 },
  ],
  product: [
    // Banks/FI products
    { value: "retail banking", score: 20, risk: "MR", industry: "banks/fi" },
    {
      value: "payment processing",
      score: 30,
      risk: "MR",
      industry: "banks/fi",
    },
    { value: "wealth management", score: 40, risk: "HR", industry: "banks/fi" },
    { value: "private banking", score: 40, risk: "HR", industry: "banks/fi" },
    {
      value: "correspondent banking",
      score: 50,
      risk: "UHR",
      industry: "banks/fi",
    },

    // VASP products
    { value: "stablecoin transfers", score: 20, risk: "MR", industry: "vasp" },
    { value: "crypto custody", score: 30, risk: "MR", industry: "vasp" },
    { value: "crypto lending", score: 40, risk: "HR", industry: "vasp" },
    { value: "staking", score: 40, risk: "HR", industry: "vasp" },
    {
      value: "digital currency exchange",
      score: 40,
      risk: "HR",
      industry: "vasp",
    },
    { value: "anonymous crypto", score: 50, risk: "UHR", industry: "vasp" },

    // Precious Metals
    {
      value: "small jewelry",
      score: 20,
      risk: "MR",
      industry: "precious metals",
    },
    {
      value: "numismatic coins",
      score: 30,
      risk: "MR",
      industry: "precious metals",
    },
    {
      value: "high-value jewelry",
      score: 40,
      risk: "HR",
      industry: "precious metals",
    },
    {
      value: "bullion trading",
      score: 50,
      risk: "UHR",
      industry: "precious metals",
    },
  ],
  channel: [
    { value: "face to face", score: 10, risk: "LR" },
    { value: "in-branch", score: 10, risk: "LR" },
    { value: "agent", score: 20, risk: "MR" },
    { value: "representative", score: 20, risk: "MR" },
    { value: "web", score: 30, risk: "MR" },
    { value: "api", score: 30, risk: "MR" },
    { value: "online", score: 30, risk: "MR" },
    { value: "mobile app", score: 30, risk: "MR" },
    { value: "messaging", score: 40, risk: "HR" },
    { value: "email", score: 40, risk: "HR" },
    { value: "broker", score: 40, risk: "HR" },
    { value: "third-party introducer", score: 40, risk: "HR" },
    { value: "otc trading desk", score: 40, risk: "HR" },
    { value: "anonymous digital", score: 50, risk: "UHR" },
    { value: "crypto atm", score: 50, risk: "UHR" },
  ],
  occupation: [
    { value: "Professional ", score: 10 },
    { value: "Manager", score: 10 },
    { value: "Clerical", score: 20 },
    { value: "Admin", score: 20 },
    { value: "Technician", score: 30 },
    { value: "Skilled Trade", score: 30 },
    { value: "Sales", score: 30 },

    { value: "Machinery", score: 30 },
    { value: "Service", score: 40 },
    { value: "Labourer", score: 40 },

    { value: "Business Owner", score: 40 },
    { value: "Unemployed", score: 50 },
    { value: "Student", score: 50 },
    { value: "Retiree", score: 50 },
  ],
  industry: [
    { value: "Professional Services", score: 10 },
    { value: "Tech", score: 10 },
    { value: "Technology", score: 10 },
    { value: "Electricity", score: 10 },
    { value: "Information Technology", score: 10 },
    { value: "Public Administration", score: 10 },

    { value: "Retail", score: 20 },
    { value: "Hospitality", score: 20 },
    { value: "Import-Export", score: 30 },
    { value: "Wholesale", score: 30 },
    { value: "Construction", score: 40 },
    { value: "Gambling", score: 40 },
    { value: "Financial Services", score: 50 },
    { value: "Real Estate", score: 50 },
  ],
};

/** helper: normalize string */
function norm(s) {
  if (!s && s !== 0) return "";
  return String(s).trim().toLowerCase();
}

/** get jurisdiction band object from country string */
function getJurisdictionRisk(countryRaw) {
  const c = norm(countryRaw).replace(/\u2019/g, "'"); // fix curly apostrophe
  if (!c) return { value: "", score: 0, band: null };

  // Direct name matches: check sets (we used many possible forms in lists; try contains)
  if (UHRC.has(c) || (c.includes("korea") && c.includes("north"))) {
    return { value: countryRaw, score: 50, band: "UHRC" };
  }
  if (HRC.has(c)) return { value: countryRaw, score: 50, band: "HRC" };
  if (MRC.has(c)) return { value: countryRaw, score: 30, band: "MRC" };
  if (LRC.has(c)) return { value: countryRaw, score: 10, band: "LRC" };
  // fallback: treat unknown as MRC (medium)
  return { value: countryRaw, score: 30, band: "MRC" };
}

/** fuzzy lookup: exact or substring match, case-insensitive */
function lookupFactor(list, raw) {
  if (!raw) return { value: "", score: 0 };
  const s = norm(raw);
  // exact match first
  for (const item of list) {
    if (norm(item.value) === s) return { value: item.value, score: item.score };
  }
  // contains match
  for (const item of list) {
    const v = norm(item.value);
    if (s.includes(v) || v.includes(s))
      return { value: item.value, score: item.score };
  }
  // no match -> return raw as value, score 0
  return { value: raw, score: 0 };
}

/** detect retention using relation.registeredAt or customer.createdAt */
// function detectCustomerRetentionScore(customer = {}, relation = {}) {
//   const now = Date.now();
//   const registeredAt = relation?.registeredAt
//     ? new Date(relation.registeredAt).getTime()
//     : customer?.createdAt
//       ? new Date(customer.createdAt).getTime()
//       : null;
//   if (!registeredAt) return { value: "New", score: 30 };
//   const years = (now - registeredAt) / (1000 * 60 * 60 * 24 * 365.25);
//   if (years >= 3) return { value: "3+ Years", score: 10 };
//   if (years >= 1) return { value: "1-3 Years", score: 20 };
//   return { value: "New", score: 30 };
// }

function parseRetentionValue(value) {
  if (!value) return null;

  const clean = value.replace(/\(.*\)/, "").trim();

  const map = {
    New: { value: "New", score: 30 },
    "1-3 Years": { value: "1-3 Years", score: 20 },
    "3+ Years": { value: "3+ Years", score: 10 },
  };

  return map[clean] || null;
}
function detectCustomerRetentionScore(customer = {}, relation = {}) {
  // ✅ Priority: explicit retention value from payload
  if (customer.retention) {
    const parsed = parseRetentionValue(customer.retention);
    if (parsed) return parsed;
  }

  // ✅ Fallback: calculate from dates
  const now = Date.now();

  const registeredAt = relation?.registeredAt
    ? new Date(relation.registeredAt).getTime()
    : customer?.createdAt
      ? new Date(customer.createdAt).getTime()
      : null;

  if (!registeredAt) return { value: "New", score: 30 };

  const years = (now - registeredAt) / (1000 * 60 * 60 * 24 * 365.25);

  if (years >= 3) return { value: "3+ Years", score: 10 };
  if (years >= 1) return { value: "1-3 Years", score: 20 };

  return { value: "New", score: 30 };
}

/**
 * buildRiskAssessmentFromCustomer(customer)
 * returns { riskAssessment, riskScore, riskLabel }
 */
function buildRiskAssessmentFromCustomer(customer = {}, opts = {}) {
  // normalize customer doc or plain object
  const relation =
    (Array.isArray(customer.relations) && customer.relations[0]) || {};
  const requestedType = relation?.type || customer.type || "individual";
  // customerType - lookup from FACTORS.customerType
  const customerType = lookupFactor(FACTORS.customerType, requestedType);

  // jurisdiction - try multiple sources
  const country =
    customer.country || (customer.metadata && customer.metadata.country) || "";
  const jurisdiction = getJurisdictionRisk(country);

  // customerRetention
  const customerRetention = detectCustomerRetentionScore(customer, relation);

  // product: metadata.product OR metadata.products (if array) -> we must pick highest risk (rule)
  let productLookupRaw = "";
  if (customer.metadata && customer.metadata.product)
    productLookupRaw = customer.metadata.product;
  else if (
    customer.metadata &&
    Array.isArray(customer.metadata.products) &&
    customer.metadata.products.length
  ) {
    // choose the highest scoring product from FACTORS.product
    let best = { value: "", score: 0 };
    for (const p of customer.metadata.products) {
      const found = lookupFactor(FACTORS.product, p);
      if ((found.score || 0) > (best.score || 0)) best = found;
    }
    productLookupRaw = best.value;
  }
  const product = lookupFactor(FACTORS.product, productLookupRaw);

  // channel: relation.source or onboardingChannel or metadata.channel
  const channelRaw =
    relation?.source ||
    relation?.onboardingChannel ||
    customer.onboardingChannel ||
    (customer.metadata && customer.metadata.channel) ||
    "in-branch";
  const channel = lookupFactor(FACTORS.channel, channelRaw);

  // occupation: personalKyc.personal_form.employment_details.occupation or metadata.occupation
  const occupationRaw =
    (customer.personalKyc &&
      customer.personalKyc.personal_form &&
      customer.personalKyc.personal_form.employment_details &&
      customer.personalKyc.personal_form.employment_details.occupation) ||
    customer.metadata?.occupation ||
    "";
  const occupation = lookupFactor(FACTORS.occupation, occupationRaw);

  // industry: personalKyc.employment_details.industry or metadata.industry or company KYC
  const industryRaw =
    (customer.personalKyc &&
      customer.personalKyc.personal_form &&
      customer.personalKyc.personal_form.employment_details &&
      customer.personalKyc.personal_form.employment_details.industry) ||
    customer.metadata?.industry ||
    (customer.companyKyc &&
      customer.companyKyc.general_information &&
      customer.companyKyc.general_information.industry) ||
    "";
  const industry = lookupFactor(FACTORS.industry, industryRaw);

  const assessment = {
    customerType,
    jurisdiction: {
      value: jurisdiction.value || country || "",
      score: jurisdiction.score || 0,
      band: jurisdiction.band || null,
    },
    customerRetention,
    product,
    channel,
    occupation,
    industry,
  };

  // compute total (sum of component scores) but enforce "max product" already done
  const totalScore = Object.values(assessment).reduce(
    (acc, cur) => acc + (cur && cur.score ? Number(cur.score) : 0),
    0,
  );

  // Labeling rules per CRA doc
  let riskLabel = "Low";
  if (assessment.jurisdiction && assessment.jurisdiction.band === "UHRC") {
    riskLabel = "Unacceptable";
    // map to high numeric to show automatic unacceptable state - clamp between 401..500
    // ensure highest at least 401
    const finalScore = Math.max(totalScore, 401);
    return { riskAssessment: assessment, riskScore: finalScore, riskLabel };
  }

  // otherwise thresholds:
  // Low 0-179, Medium 180-200, High 201-400, Unacceptable 401+
  let finalScore = totalScore;
  if (finalScore >= 401) riskLabel = "Unacceptable";
  else if (finalScore >= 201) riskLabel = "High";
  else if (finalScore >= 180) riskLabel = "Medium";
  else riskLabel = "Low";

  return { riskAssessment: assessment, riskScore: finalScore, riskLabel };
}

/**
 * Build assessment for a single relation. This scopes customer->relation so
 * the existing buildRiskAssessmentFromCustomer logic can be reused.
 */
function buildAssessmentForRelation(customer = {}, relation = {}) {
  // shallow clone so we don't mutate original
  const ctx = Object.assign({}, customer);
  // put relation as first element so buildRiskAssessmentFromCustomer uses it
  ctx.relations = [relation];
  // prefer relation fields for metadata (registeredAt etc)
  return buildRiskAssessmentFromCustomer(ctx);
}

/**
 * Build per-relation array and aggregated summary.
 * returns { relationRisks: [...], summary: { maxScore, averageScore, highestLabel } }
 */
function buildRiskAssessmentPerRelation(customer = {}) {
  const relations = Array.isArray(customer.relations) ? customer.relations : [];

  // if no relations, compute single overall
  if (relations.length === 0) {
    const overall = buildRiskAssessmentFromCustomer(customer);
    return {
      relationRisks: [
        {
          client: customer.metadata?.client || null,
          branch: customer.metadata?.branch || null,
          type: customer.type || "individual",
          registeredAt: customer.createdAt || null,
          ...overall,
        },
      ],
      summary: {
        maxScore: overall.riskScore,
        averageScore: overall.riskScore,
        highestLabel: overall.riskLabel,
      },
    };
  }

  const relationRisks = relations.map((rel) => {
    const assessment = buildAssessmentForRelation(customer, rel);
    return {
      client: rel.client || null,
      branch: rel.branch || null,
      type: rel.type || "individual",
      registeredAt: rel.registeredAt || null,
      onboardingChannel: rel.onboardingChannel || null,
      source: rel.source || null,
      ...assessment,
    };
  });

  // Aggregation: max, average, highest label by severity
  const scores = relationRisks.map((r) => r.riskScore || 0);
  const maxScore = Math.max(...scores, 0);
  const avgScore = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  // label precedence
  const labelOrder = { Unacceptable: 4, High: 3, Medium: 2, Low: 1, "": 0 };
  const highestLabel = relationRisks.reduce((best, cur) => {
    if (!best) return cur.riskLabel;
    return labelOrder[cur.riskLabel] > labelOrder[best] ? cur.riskLabel : best;
  }, "");

  // optional: sort by score desc (useful when storing)
  relationRisks.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));

  return {
    relationRisks,
    summary: {
      maxScore,
      averageScore: avgScore,
      highestLabel,
    },
  };
}

module.exports = {
  buildRiskAssessmentFromCustomer,
  buildRiskAssessmentPerRelation,
  buildAssessmentForRelation,
  getJurisdictionRisk,
  FACTORS,
  UHRC,
  HRC,
  MRC,
  LRC,
};
