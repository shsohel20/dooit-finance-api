const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const CountryRiskSchema = new mongoose.Schema({
  // ── Original fields (unchanged) ───────────────────────────────────────────
  country: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },

  band: {
    type: String,
    enum: ["LRC", "MRC", "HRC", "UHRC"],
    required: true,
    index: true,
  },

  score: {
    type: Number,
    required: true,
  },

  aliases: [String], // optional variants: "usa","us","united states"
  source: String,    // FATF / CRA / Internal
  active: { type: Boolean, default: true },

  // ── Extended fields ───────────────────────────────────────────────────────
  countryCode: {
    type: String,
    uppercase: true,
    trim: true,
    maxlength: 3,
    index: true,
    sparse: true,
  },
  countryName: { type: String, trim: true },
  region:      { type: String, trim: true },

  // Risk tier (mirrors band with explicit UHRC/HRC/MRC/LRC enum)
  riskTier: {
    type: String,
    enum: ["UHRC", "HRC", "MRC", "LRC"],
    index: true,
  },
  overallScore: { type: Number, min: 1, max: 5, default: null },

  // Component scores (1–5)
  mlRiskScore:     { type: Number, min: 1, max: 5, default: null },
  tfRiskScore:     { type: Number, min: 1, max: 5, default: null },
  pfRiskScore:     { type: Number, min: 1, max: 5, default: null }, // Proliferation Financing
  sanctionsRisk:   { type: Number, min: 1, max: 5, default: null },
  corruptionScore: { type: Number, min: 1, max: 5, default: null },

  // FATF
  fatfStatus: {
    type: String,
    enum: ["Member", "Observer", "Grey List", "Black List", "Non-Member", "Monitored"],
    default: null,
  },
  fatfMutualEvalYear: { type: Number, default: null },

  // Supplementary flags
  isSanctioned:      { type: Boolean, default: false },
  isHighRiskByFATF:  { type: Boolean, default: false },
  isFATFBlackList:   { type: Boolean, default: false },
  ausAustracGuidance: { type: String, default: "" },

  lastUpdated: { type: Date, default: null },
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  timestamps: true,
});

CountryRiskSchema.index({ riskTier: 1, countryName: 1 });
CountryRiskSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("CountryRisk", CountryRiskSchema);
