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
    risk: String,      // LR / MR / HR / UHR
    industry: String,  // optional grouping

    aliases: [String],

    active: { type: Boolean, default: true },
}, {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
});

RiskFactorOptionSchema.index(
    { factor: 1, value: 1 },
    { unique: true }
);

module.exports = mongoose.model("RiskFactorOption", RiskFactorOptionSchema);
