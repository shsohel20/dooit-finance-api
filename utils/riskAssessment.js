// utils/riskAssessment.js
"use strict";

const dayjs = require("dayjs");
const { getCache } = require("./riskFactorCache");

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
  "kuwait",
  "papua new guinea",
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

/**
 * canonical FACTORS — CRA Scoring Model V2 (docs/datasheet/CRA_Scoring_Method.md).
 * 1–5 scale (UHRC jurisdiction = 100). Static fallback / testing reference;
 * runtime lookups read RiskFactorOption via riskFactorCache.
 */
const FACTORS = {
  customerType: [
    { value: "government_body", score: 1 },
    { value: "individual", score: 2 },
    { value: "sole proprietorship", score: 2 },
    { value: "company", score: 3 },
    { value: "partnership", score: 3 },
    { value: "association", score: 4 },
    { value: "cooperative", score: 4 },
    { value: "trust", score: 5 },
  ],
  jurisdiction: [
    { value: "LRC", score: 1 },
    { value: "MRC", score: 3 },
    { value: "HRC", score: 5 },
    { value: "UHRC", score: 100 }, // triggers unacceptable
  ],
  customerRetention: [
    { value: "3+ Years", score: 1 },
    { value: "1-3 Years", score: 2 },
    { value: "New", score: 3 },
  ],
  // F2F verified (1) … anonymity-preserving (5); canonical set in seedRiskFactors.js
  channel: [
    { value: "face to face", score: 1, risk: "LOW" },
    { value: "in-branch", score: 1, risk: "LOW" },
    { value: "phone / telephone", score: 2, risk: "MED" },
    { value: "agent", score: 2, risk: "MED" },
    { value: "representative", score: 2, risk: "MED" },
    { value: "web", score: 3, risk: "MED" },
    { value: "online", score: 3, risk: "MED" },
    { value: "mobile app", score: 3, risk: "MED" },
    { value: "api", score: 3, risk: "MED" },
    { value: "email", score: 4, risk: "HIGH" },
    { value: "messaging", score: 4, risk: "HIGH" },
    { value: "broker", score: 4, risk: "HIGH" },
    { value: "third-party introducer", score: 4, risk: "HIGH" },
    { value: "otc trading desk", score: 4, risk: "HIGH" },
    { value: "anonymous digital", score: 5, risk: "UHR" },
    { value: "crypto atm", score: 5, risk: "UHR" },
  ],
  occupation: [
    { value: "Managers", score: 1 },
    { value: "Professionals", score: 1 },
    { value: "Clerical and Administrative Workers", score: 2 },
    { value: "Technicians and Trades Workers", score: 3 },
    { value: "Sales Workers", score: 3 },
    { value: "Machinery Operators and Drivers", score: 3 },
    { value: "Labourers", score: 4 },
    { value: "Community and Personal Service Workers", score: 4 },
    { value: "Business Owner", score: 4 },
    { value: "Unemployed / Retiree", score: 5 },
    { value: "Student", score: 5 },
  ],
  industry: [
    { value: "Electricity, Gas, Water and Waste Services", score: 1 },
    { value: "Information Media and Telecommunications", score: 1 },
    { value: "Public Administration and Safety", score: 1 },
    { value: "Education and Training", score: 2 },
    { value: "Health Care and Social Assistance", score: 2 },
    { value: "Agriculture, Forestry and Fishing", score: 3 },
    { value: "Mining", score: 3 },
    { value: "Manufacturing", score: 3 },
    { value: "Wholesale Trade", score: 3 },
    { value: "Accommodation and Food Services", score: 3 },
    { value: "Transport, Postal and Warehousing", score: 3 },
    { value: "Professional, Scientific and Technical Services", score: 3 },
    { value: "Administrative and Support Services", score: 3 },
    { value: "Retail Trade", score: 4 },
    { value: "Arts and Recreation Services", score: 4 },
    { value: "Construction", score: 5 },
    { value: "Financial and Insurance Services", score: 5 },
    { value: "Rental, Hiring and Real Estate Services", score: 5 },
  ],
  pepStatus: [
    { value: "Not a PEP", score: 0 },
    { value: "Domestic PEP / close associate", score: 0 },        // min MEDIUM
    { value: "Foreign PEP / close associate", score: 0 },         // min HIGH + ECDD
    { value: "International Organisation PEP", score: 0 },        // min MEDIUM
  ],
  sourceOfFunds: [
    { value: "Clearly established and verified", score: 0 },
    { value: "Plausible but unverified", score: 3 },
    { value: "Cannot be explained / refuses", score: 10 },        // + ECDD
  ],
  sourceOfWealth: [
    { value: "Clearly established and verified", score: 0 },
    { value: "Plausible but unverified", score: 3 },
    { value: "Cannot be explained / refuses", score: 10 },        // + ECDD
  ],
  adverseMedia: [
    { value: "No adverse media", score: 0 },
    { value: "Minor adverse media", score: 2 },
    { value: "Significant adverse media", score: 5 },             // + ECDD
    { value: "Confirmed criminal connection", score: 10 },        // + ECDD
  ],
};

/** Score bands (Section 1): Low 0–17 · Medium 18–20 · High 21–99 · Unacceptable 100+ */
const BANDS = [
  { label: "Unacceptable", min: 100, reviewYears: null },
  { label: "High", min: 21, reviewYears: 1 },
  { label: "Medium", min: 18, reviewYears: 2 },
  { label: "Low", min: 0, reviewYears: 3 },
];

const LABEL_ORDER = { Low: 1, Medium: 2, High: 3, Unacceptable: 4 };

function bandForScore(score) {
  return BANDS.find((b) => score >= b.min) || BANDS[BANDS.length - 1];
}

/** helper: normalize string */
function norm(s) {
  if (!s && s !== 0) return "";
  return String(s).trim().toLowerCase();
}

/** get jurisdiction band object from country string */
// function getJurisdictionRisk(countryRaw) {
//   const c = norm(countryRaw).replace(/\u2019/g, "'"); // fix curly apostrophe
//   if (!c) return { value: "", score: 0, band: null };

//   // Direct name matches: check sets (we used many possible forms in lists; try contains)
//   if (UHRC.has(c) || (c.includes("korea") && c.includes("north"))) {
//     return { value: countryRaw, score: 50, band: "UHRC" };
//   }
//   if (HRC.has(c)) return { value: countryRaw, score: 50, band: "HRC" };
//   if (MRC.has(c)) return { value: countryRaw, score: 30, band: "MRC" };
//   if (LRC.has(c)) return { value: countryRaw, score: 10, band: "LRC" };
//   // fallback: treat unknown as MRC (medium)
//   return { value: countryRaw, score: 30, band: "MRC" };
// }

function getJurisdictionRisk(countryRaw) {
  const { countries } = getCache();
  const s = norm(countryRaw);

  const found = countries.find(c =>
    c.country === s ||
    (c.aliases || []).includes(s)
  );

  if (!found) {
    // unknown country — treat as Medium Risk Country (CRA V2: MRC = 3)
    return { value: countryRaw, score: 3, band: "MRC" };
  }

  return {
    value: countryRaw,
    score: found.score,
    band: found.band,
  };
}


/** fuzzy lookup: exact or substring match, case-insensitive */
// function lookupFactor(list, raw) {
//   if (!raw) return { value: "", score: 0 };
//   const s = norm(raw);
//   // exact match first
//   for (const item of list) {
//     if (norm(item.value) === s) return { value: item.value, score: item.score };
//   }
//   // contains match
//   for (const item of list) {
//     const v = norm(item.value);
//     if (s.includes(v) || v.includes(s))
//       return { value: item.value, score: item.score };
//   }
//   // no match -> return raw as value, score 0
//   return { value: raw, score: 0 };
// }


function lookupFactorDynamic(factorName, raw, { entityType } = {}) {
  const { factors } = getCache();
  let list = factors[factorName] || [];
  if (entityType) {
    const scoped = list.filter((x) => norm(x.entityType) === norm(entityType));
    if (scoped.length) list = scoped;
  }
  const s = norm(raw);

  const found =
    list.find(x => norm(x.value) === s) ||
    list.find(x => (x.aliases || []).includes(s));

  return found
    ? { value: found.value, score: found.score, ecddOverride: !!found.ecddOverride }
    : { value: raw, score: 0, ecddOverride: false };
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
    New: { value: "New", score: 3 },
    "1-3 Years": { value: "1-3 Years", score: 2 },
    "3+ Years": { value: "3+ Years", score: 1 },
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

  if (!registeredAt) return { value: "New", score: 3 };

  const years = (now - registeredAt) / (1000 * 60 * 60 * 24 * 365.25);

  if (years >= 3) return { value: "3+ Years", score: 1 };
  if (years >= 1) return { value: "1-3 Years", score: 2 };

  return { value: "New", score: 3 };
}

/**
 * Normalise the PEP input. Accepts the V2 string options or the legacy
 * boolean flag. An unspecified "is a PEP" is treated conservatively as a
 * Foreign PEP (min HIGH + mandatory ECDD) until classified.
 */
function resolvePepStatus(raw) {
  if (raw === true) return "Foreign PEP / close associate";
  if (raw === false || raw == null || raw === "") return "Not a PEP";
  return String(raw);
}

/**
 * buildRiskAssessmentFromCustomer(customer)
 * returns { riskAssessment, riskScore, riskLabel }
 */
function buildRiskAssessmentFromCustomer(customer = {}, opts = {}) {
  // normalize customer doc or plain object
  const relations = Array.isArray(customer.relations) ? customer.relations : [];

  // A Customer document represents a person, but its `relations[]` can mix the
  // person's own individual relation with linked entity relations (company /
  // trust / partnership). For the customer's own risk profile + displayed type
  // we prefer the individual relation; callers can override via opts.preferType
  // (e.g. the per-relation path passes a single-relation context). Falls back to
  // the first relation for pure entity onboarding with no individual relation.
  const preferType = norm(opts.preferType || "individual");
  const relation =
    relations.find((r) => norm(r?.type) === preferType) || relations[0] || {};
  const requestedType = relation?.type || customer.type || "individual";
  // customerType - lookup from FACTORS.customerType
  // const customerType = lookupFactor(FACTORS.customerType, requestedType);
  const customerType = lookupFactorDynamic("customerType", requestedType);

  // jurisdiction - try multiple sources
  const country =
    customer.country || (customer.metadata && customer.metadata.country) || "";
  const jurisdiction = getJurisdictionRisk(country);

  // customerRetention
  const customerRetention = detectCustomerRetentionScore(customer, relation);

  // entity type of the reporting entity — products are catalogued per entity type
  const entityType =
    customer.entityType || (customer.metadata && customer.metadata.entityType) || "";

  // product: metadata.product OR metadata.products (if array) -> we must pick highest risk (rule)
  let productLookupRaw = "";
  if (customer.metadata && customer.metadata.product)
    productLookupRaw = customer.metadata.product;
  else if (
    customer.metadata &&
    Array.isArray(customer.metadata.products) &&
    customer.metadata.products.length
  ) {
    // choose the highest scoring product for this entity type
    let best = { value: "", score: 0 };
    for (const p of customer.metadata.products) {
      const found = lookupFactorDynamic("product", p, { entityType });
      if ((found.score || 0) > (best.score || 0)) best = found;
    }
    productLookupRaw = best.value;
  }
  const product = lookupFactorDynamic("product", productLookupRaw, { entityType });

  // channel: relation.source or onboardingChannel or metadata.channel
  const channelRaw =
    relation?.source ||
    relation?.onboardingChannel ||
    customer.onboardingChannel ||
    (customer.metadata && customer.metadata.channel) ||
    "in-branch";
  // const channel = lookupFactor(FACTORS.channel, channelRaw);
  const channel = lookupFactorDynamic("channel", channelRaw);

  // occupation: personalKyc.personal_form.employment_details.occupation or metadata.occupation
  const occupationRaw =
    (customer.personalKyc &&
      customer.personalKyc.personal_form &&
      customer.personalKyc.personal_form.employment_details &&
      customer.personalKyc.personal_form.employment_details.occupation) ||
    customer.metadata?.occupation ||
    "";
  // const occupation = lookupFactor(FACTORS.occupation, occupationRaw);
  const occupation = lookupFactorDynamic("occupation", occupationRaw);

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
  // const industry = lookupFactor(FACTORS.industry, industryRaw);
  const industry = lookupFactorDynamic("industry", industryRaw);

  // ── EDD factors (CRA V2 Section 2) ──────────────────────────────────────────
  const pepRaw = resolvePepStatus(
    customer.pepStatus ?? customer.metadata?.pepStatus,
  );
  const pepStatus = lookupFactorDynamic("pepStatus", pepRaw);

  const sofRaw =
    customer.sourceOfFunds || customer.metadata?.sourceOfFunds || "";
  const sourceOfFunds = sofRaw
    ? lookupFactorDynamic("sourceOfFunds", sofRaw)
    : { value: "", score: 0, ecddOverride: false };

  const sowRaw =
    customer.sourceOfWealth || customer.metadata?.sourceOfWealth || "";
  const sourceOfWealth = sowRaw
    ? lookupFactorDynamic("sourceOfWealth", sowRaw)
    : { value: "", score: 0, ecddOverride: false };

  const amRaw =
    customer.adverseMedia || customer.metadata?.adverseMedia || "";
  const adverseMedia = amRaw
    ? lookupFactorDynamic("adverseMedia", amRaw)
    : { value: "", score: 0, ecddOverride: false };

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
    pepStatus,
    sourceOfFunds,
    sourceOfWealth,
    adverseMedia,
  };

  // Base formula (Section 4): sum of component scores
  const totalScore = Object.values(assessment).reduce(
    (acc, cur) => acc + (cur && cur.score ? Number(cur.score) : 0),
    0,
  );

  // ── Band + overrides (Section 4) ────────────────────────────────────────────
  const overrides = [];
  let band = bandForScore(totalScore);
  let riskLabel = band.label;
  let ecddRequired = false;
  let serviceBlocked = false;

  const raiseLabelTo = (minLabel, reason) => {
    if (LABEL_ORDER[minLabel] > LABEL_ORDER[riskLabel]) {
      riskLabel = minLabel;
      band = BANDS.find((b) => b.label === minLabel) || band;
    }
    overrides.push(reason);
  };

  // UHRC jurisdiction → Unacceptable, block service
  if (assessment.jurisdiction.band === "UHRC") {
    raiseLabelTo("Unacceptable", "UHRC jurisdiction — service blocked; contact ASO + AFP; SMR assessment");
    ecddRequired = true;
    serviceBlocked = true;
  }
  // HRC jurisdiction → mandatory ECDD
  if (assessment.jurisdiction.band === "HRC") {
    overrides.push("HRC jurisdiction — mandatory ECDD");
    ecddRequired = true;
  }

  // PEP overrides
  const pepNorm = norm(pepStatus.value);
  if (pepNorm.startsWith("foreign pep")) {
    raiseLabelTo("High", "Foreign PEP — minimum HIGH; ECDD + Governing Body approval required");
    ecddRequired = true;
  } else if (pepNorm.startsWith("domestic pep") || pepNorm.startsWith("international organisation")) {
    raiseLabelTo("Medium", "PEP — minimum MEDIUM; elevated monitoring");
  }

  // Option-level ECDD overrides (product, SOF/SOW refusal, adverse media ≥ significant)
  for (const [key, detail] of Object.entries(assessment)) {
    if (detail && detail.ecddOverride) {
      overrides.push(`${key} option '${detail.value}' — mandatory ECDD`);
      ecddRequired = true;
    }
  }
  // Fallback triggers independent of seeded flags (Section 2 mandates these)
  if (norm(sourceOfFunds.value).startsWith("cannot")) {
    overrides.push("SOF cannot be explained / refused — mandatory ECDD");
    ecddRequired = true;
  }
  if (norm(sourceOfWealth.value).startsWith("cannot")) {
    overrides.push("SOW cannot be explained / refused — mandatory ECDD");
    ecddRequired = true;
  }
  if (/^(significant|confirmed)/.test(norm(adverseMedia.value))) {
    overrides.push("Adverse media (significant or confirmed) — mandatory ECDD");
    ecddRequired = true;
  }

  // High / Unacceptable band always require ECDD (Section 1)
  if (LABEL_ORDER[riskLabel] >= LABEL_ORDER.High) ecddRequired = true;
  if (riskLabel === "Unacceptable") serviceBlocked = true;

  return {
    riskAssessment: assessment,
    riskScore: totalScore,
    riskLabel,
    ecddRequired,
    serviceBlocked,
    reviewYears: band.reviewYears,
    overrides,
  };
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
  bandForScore,
  FACTORS,
  BANDS,
  UHRC,
  HRC,
  MRC,
  LRC,
};
