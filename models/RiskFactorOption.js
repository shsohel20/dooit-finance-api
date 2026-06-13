const mongoose = require("mongoose");

const RiskFactorOptionSchema = new mongoose.Schema({
    factor: {
        type: String,
        required: true,
        // product, channel, occupation, industry, customerType, retention
    },

    value: {
        type: String,
        required: true,
        trim: true,
    },

    score: Number,
    risk: String,       // LOW / MED / HIGH / UHR / UNACCEPTABLE
    industry: String,   // optional grouping (legacy)

    // CRA V2 — products are catalogued per reporting entity type
    // (Banks & ADIs, Remittance, VASP/DCEP, Gambling/Casino, Insurance,
    //  Lawyers/Conveyancers, Accountants, Real Estate Agents,
    //  Precious Metal Dealers, TCSPs)
    entityType: { type: String, index: true },

    // Selecting this option forces mandatory ECDD regardless of numeric band
    ecddOverride: { type: Boolean, default: false },

    notes: String,

    aliases: [String],

    active: { type: Boolean, default: true },
}, {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
});

RiskFactorOptionSchema.index(
    { factor: 1, entityType: 1, value: 1 },
    { unique: true }
);

module.exports = mongoose.model("RiskFactorOption", RiskFactorOptionSchema);
