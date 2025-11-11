// utils/highRiskCountries.js

/**
 * Country risk classification lists
 * Source: FATF, Basel AML Index, EU & OFAC sanctions
 * All names are stored lowercase for normalized matching.
 */

// 🔴 Ultra High Risk (UHRC - sanctioned/unacceptable)
const isoCountriesUltraHighRisk = new Set([
    "north korea",  // DPRK
    "iran",
    "sudan",
    "south sudan",
    "syria",
    "venezuela",
    "russia",
    "belarus",
    "myanmar",
    "cuba",
    "afghanistan",
  ]);
  
  // 🔶 High Risk (HRC - FATF grey list, high Basel Index > 6)
  const isoCountriesHighRisk = new Set([
    "yemen",
    "nicaragua",
    "pakistan",
    "haiti",
    "libya",
    "somalia",
    "lebanon",
    "zimbabwe",
    "burkina faso",
    "tanzania",
    "turkey",
  ]);
  
  // 🟡 Medium Risk (MRC - developing or regulatory gaps)
  const isoCountriesMediumRisk = new Set([
    "malaysia",
    "jamaica",
    "philippines",
    "vietnam",
    "namibia",
    "uganda",
    "albania",
    "senegal",
  ]);
  
  // 🟢 Low Risk (LRC - Basel AML Index < 4.71)
  const isoCountriesLowRisk = new Set([
    "bangladesh",
    "singapore",
    "japan",
    "canada",
    "australia",
    "new zealand",
    "sweden",
    "norway",
    "denmark",
    "switzerland",
    "finland",
    "germany",
  ]);
  
  /**
   * Returns jurisdiction classification and score
   */
  function getJurisdictionRisk(countryName) {
    if (!countryName)
      return {
        value: "Unknown",
        score: 0,
        description: "No country specified",
      };
  
    const normalized = countryName.toLowerCase().trim();
  
    if (isoCountriesUltraHighRisk.has(normalized)) {
      return {
        value: "UHRC - Ultra High Risk Country",
        score: 100,
        description: "Sanctioned countries (Unacceptable)",
      };
    }
  
    if (isoCountriesHighRisk.has(normalized)) {
      return {
        value: "HRC - High Risk Country",
        score: 5,
        description: "Tax havens, Basel > 6, FATF grey list",
      };
    }
  
    if (isoCountriesMediumRisk.has(normalized)) {
      return {
        value: "MRC - Medium Risk Country",
        score: 3,
        description: "Remaining countries with moderate AML risk",
      };
    }
  
    return {
      value: "LRC - Low Risk Country",
      score: 1,
      description: "Basel AML Index < 4.71",
    };
  }
  
  module.exports = {
    isoCountriesUltraHighRisk,
    isoCountriesHighRisk,
    isoCountriesMediumRisk,
    isoCountriesLowRisk,
    getJurisdictionRisk,
  };
  