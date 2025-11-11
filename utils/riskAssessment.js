const { getJurisdictionRisk } = require("./highRiskCountries");


  /**
   * The canonical factor tables (small subset from your frontend).
   * Extend/replace these entries as you like.
   */
  const FACTORS = {
    customerType: [
      { value: "government", score: 1 },
      { value: "individual", score: 2 },
      { value: "association/cooperative", score: 3 },
      { value: "company", score: 4 },
      { value: "trust", score: 5 },
    ],
    jurisdiction: [
      { value: "LRC", score: 1 }, // low risk
      { value: "MRC", score: 3 }, // medium
      { value: "HRC", score: 5 }, // high
      { value: "UHRC", score: 100 }, // unacceptable
    ],
    customerRetention: [
      { value: "3+ Years", score: 1 },
      { value: "1-3 Years", score: 2 },
      { value: "New", score: 3 },
    ],
    product: [
      { value: "Custody", score: 2 },
      { value: "Stable coin", score: 3 },
      { value: "Affiliate", score: 3 },
      { value: "Bullion", score: 4 },
      { value: "Remittance/FX", score: 4 },
      { value: "DCE", score: 5 },
    ],
    channel: [
      { value: "Face to Face", score: 1 },
      { value: "Direct mobile App", score: 3 },
      { value: "Agent", score: 3 },
      { value: "Messaging/Email", score: 4 },
      { value: "Broker", score: 5 },
      { value: "in-branch", score: 1 },
      { value: "web", score: 3 },
      { value: "api", score: 3 },
    ],
    occupation: [
      { value: "Managers", score: 1 },
      { value: "Professionals", score: 1 },
      { value: "Clerical", score: 2 },
      { value: "Technician", score: 3 },
      { value: "Sales", score: 3 },
      { value: "Machinery", score: 3 },
      { value: "Service", score: 4 },
      { value: "Labourer", score: 4 },
      { value: "Business Owner", score: 4 },
      { value: "Unemployed", score: 5 },
      { value: "Student", score: 5 },
    ],
    industry: [
      { value: "Electricity", score: 1 },
      { value: "Information Technology", score: 1 },
      { value: "Public Administration", score: 1 },
      { value: "Education", score: 2 },
      { value: "Health Care", score: 2 },
      { value: "Agriculture", score: 3 },
      { value: "Mining", score: 3 },
      { value: "Manufacturing", score: 3 },
      { value: "Wholesale", score: 3 },
      { value: "Accommodation", score: 3 },
      { value: "Transport", score: 3 },
      { value: "Professional Services", score: 3 },
      { value: "Retail", score: 4 },
      { value: "Arts", score: 4 },
      { value: "Construction", score: 5 },
      { value: "Financial Services", score: 5 },
      { value: "Real Estate", score: 5 },
    ],
  };
  
  /** helper: case-insensitive fuzzy match by checking substrings */
  function lookupFactor(list, raw) {
    if (!raw || typeof raw !== "string") return { value: "", score: 0 };
  
    const s = raw.trim().toLowerCase();
    // exact or contains match
    for (const item of list) {
      if (item.value.toLowerCase() === s) return { value: item.value, score: item.score };
    }
    for (const item of list) {
      if (s.includes(item.value.toLowerCase()) || item.value.toLowerCase().includes(s))
        return { value: item.value, score: item.score };
    }
    return { value: raw, score: 0 };
  }
  

  /** customer retention from timestamps */
  function detectCustomerRetentionScore(createdAt, relationRegisteredAt) {
    const now = Date.now();
    const created = relationRegisteredAt ? new Date(relationRegisteredAt).getTime() : new Date(createdAt || now).getTime();
    const years = (now - created) / (1000 * 60 * 60 * 24 * 365.25);
    if (years >= 3) return { value: "3+ Years", score: 1 };
    if (years >= 1) return { value: "1-3 Years", score: 2 };
    return { value: "New", score: 3 };
  }
  
  /**
   * Main function: build full risk assessment from a Customer doc
   * customer: mongoose doc or plain object
   * opts: optional overrides { productLookup, defaultProduct, customFactorTables }
   */
  function buildRiskAssessmentFromCustomer(customer = {}, opts = {}) {
    const relation = Array.isArray(customer.relations) && customer.relations.length ? customer.relations[0] : {};
    const requestedType = relation?.type || customer.type || "individual";
  
    // customerType
    const customerType = lookupFactor(FACTORS.customerType, requestedType);
  
  // extract country or fallback
  const country =
    customer?.personalKyc?.address?.country ||
    customer?.metadata?.country ||
    "Unknown";

  const jurisdiction = getJurisdictionRisk(country);
    // customerRetention: prefer relation.registeredAt then customer.createdAt
    const customerRetention = detectCustomerRetentionScore(customer.createdAt, relation && relation.registeredAt);
  
    // channel: use relation.source or onboardingChannel
    const channel = lookupFactor(FACTORS.channel, relation?.source || relation?.onboardingChannel || customer.onboardingChannel || (customer.metadata && customer.metadata.channel) || "in-branch");
  
    // product: try metadata.product, otherwise empty
    const product = lookupFactor(FACTORS.product, (customer.metadata && customer.metadata.product) || "");
  
    // occupation: from personalKyc.personal_form.employment_details.occupation
    const occupationRaw = (customer.personalKyc && customer.personalKyc.personal_form && customer.personalKyc.personal_form.employment_details && customer.personalKyc.personal_form.employment_details.occupation) || "";
    const occupation = lookupFactor(FACTORS.occupation, occupationRaw);
  
    // industry: personalKyc.personal_form.employment_details.industry or metadata.industry
    const industryRaw = (customer.personalKyc && customer.personalKyc.personal_form && customer.personalKyc.personal_form.employment_details && customer.personalKyc.personal_form.employment_details.industry) || (customer.metadata && customer.metadata.industry) || "";
    const industry = lookupFactor(FACTORS.industry, industryRaw);
  
    const assessment = {
      customerType,
      jurisdiction,
      customerRetention,
      product,
      channel,
      occupation,
      industry,
    };
  
    // compute total score:
    const totalScore = Object.values(assessment).reduce((acc, cur) => acc + (cur.score || 0), 0);
  
    // label
    let riskLabel = "Low";
    if (totalScore >= 1000) riskLabel = "Unacceptable";
    else if (totalScore >= 21) riskLabel = "High";
    else if (totalScore >= 18) riskLabel = "Medium";
  
    return {
      riskAssessment: assessment,
      riskScore: totalScore,
      riskLabel,
    };
  }
  
  module.exports = {
    buildRiskAssessmentFromCustomer,
    FACTORS, // export for reuse
  };
  