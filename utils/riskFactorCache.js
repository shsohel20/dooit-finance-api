const CountryRisk = require("../models/CountryRisk");
const RiskFactorOption = require("../models/RiskFactorOption");

let CACHE = {
    countries: [],
    factors: {},
};

async function loadRiskCache() {
    console.log(`CACHE Start`.bgGreen.underline);

    CACHE.countries = await CountryRisk.find({ active: true }).lean();

    const allFactors = await RiskFactorOption.find({ active: true }).lean();

    CACHE.factors = allFactors.reduce((acc, f) => {
        if (!acc[f.factor]) acc[f.factor] = [];
        acc[f.factor].push(f);
        return acc;
    }, {});
}

function getCache() {
    return CACHE;
}

module.exports = { loadRiskCache, getCache };
