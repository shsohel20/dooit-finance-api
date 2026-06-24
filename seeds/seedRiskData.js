"use strict";
require("dotenv").config({ path: "./config/config.env" });

const mongoose = require("mongoose");
const CountryRisk = require("../models/CountryRisk");
const RiskFactorOption = require("../models/RiskFactorOption");
const { connectDB } = require("../config/db");
require("colors");

const {
    UHRC,
    HRC,
    MRC,
    LRC,
    FACTORS,
} = require("../utils/riskAssessment");

// const MONGO = process.env.MONGO_URI || "mongodb://admin:StrongAdminPassword!123@31.97.71.194:27017/dooit-wallet?authSource=admin";

async function run() {
    await connectDB();
    console.log("Connected to MongoDB");

    console.log("connected");

    // --------------------------------------------------
    // ✅ COUNTRY RISK SEED  (upsert — non-destructive)
    // --------------------------------------------------

    const bandScore = { LRC: 1, MRC: 3, HRC: 5, UHRC: 100 };
    const tc = (s) => s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

    function mapCountries(set, band) {
        return Array.from(set).map((name) => {
            const key = name.toLowerCase().trim();
            return {
                country:     key,
                band,
                score:       bandScore[band],
                countryName: tc(key),
                riskTier:    band,
                source:      "CRA Seed",
                aliases:     [],
                active:      true,
            };
        });
    }

    const countries = [
        ...mapCountries(LRC,  "LRC"),
        ...mapCountries(MRC,  "MRC"),
        ...mapCountries(HRC,  "HRC"),
        ...mapCountries(UHRC, "UHRC"),
    ];

    const countryOps = countries.map((doc) => ({
        updateOne: {
            filter: { country: doc.country },
            update:  { $set: doc },
            upsert:  true,
        },
    }));
    const crResult = await CountryRisk.bulkWrite(countryOps, { ordered: false });
    console.log(`countries seeded: ${crResult.upsertedCount + crResult.modifiedCount} (${crResult.upsertedCount} new, ${crResult.modifiedCount} updated)`);

    // --------------------------------------------------
    // ✅ FACTOR OPTIONS SEED  (upsert — non-destructive)
    // --------------------------------------------------

    const factorDocs = [];
    for (const [factorName, list] of Object.entries(FACTORS)) {
        for (const item of list) {
            factorDocs.push({
                factor:   factorName,
                value:    item.value,
                score:    item.score,
                risk:     item.risk     || null,
                industry: item.industry || null,
                aliases:  [],
            });
        }
    }

    const factorOps = factorDocs.map((doc) => ({
        updateOne: {
            filter: { factor: doc.factor, value: doc.value },
            update:  { $set: doc },
            upsert:  true,
        },
    }));
    const frResult = await RiskFactorOption.bulkWrite(factorOps, { ordered: false });
    console.log(`factors seeded: ${frResult.upsertedCount + frResult.modifiedCount} (${frResult.upsertedCount} new, ${frResult.modifiedCount} updated)`);

    console.log("✅ DONE");
    process.exit();
}

run();
