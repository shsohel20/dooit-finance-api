"use strict";

const mongoose = require("mongoose");
const CountryRisk = require("./models/CountryRisk");
const RiskFactorOption = require("./models/RiskFactorOption");

const {
    UHRC,
    HRC,
    MRC,
    LRC,
    FACTORS,
} = require("./utils/riskAssessment");

const MONGO = process.env.MONGO_URI || "mongodb://admin:StrongAdminPassword!123@31.97.71.194:27017/dooit-wallet?authSource=admin";

async function run() {
    await mongoose.connect(MONGO);

    console.log("connected");

    // साफ reset (optional)
    await CountryRisk.deleteMany({});
    await RiskFactorOption.deleteMany({});

    // --------------------------------------------------
    // ✅ COUNTRY RISK SEED
    // --------------------------------------------------

    const bandScore = {
        LRC: 10,
        MRC: 30,
        HRC: 50,
        UHRC: 100,
    };

    function mapCountries(set, band) {
        return Array.from(set).map((c) => ({
            country: c.toLowerCase().trim(),
            band,
            score: bandScore[band],
            source: "CRA Dummy Seed",
            aliases: [],
        }));
    }

    const countries = [
        ...mapCountries(LRC, "LRC"),
        ...mapCountries(MRC, "MRC"),
        ...mapCountries(HRC, "HRC"),
        ...mapCountries(UHRC, "UHRC"),
    ];

    await CountryRisk.insertMany(countries);

    console.log("countries seeded:", countries.length);

    // --------------------------------------------------
    // ✅ FACTOR OPTIONS SEED
    // --------------------------------------------------

    const factorDocs = [];

    for (const [factorName, list] of Object.entries(FACTORS)) {
        for (const item of list) {
            factorDocs.push({
                factor: factorName,
                value: item.value,
                score: item.score,
                risk: item.risk || null,
                industry: item.industry || null,
                aliases: [],
            });
        }
    }

    await RiskFactorOption.insertMany(factorDocs);

    console.log("factors seeded:", factorDocs.length);

    console.log("✅ DONE");
    process.exit();
}

run();
