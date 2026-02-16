const mongoose = require("mongoose");

const CountryRiskSchema = new mongoose.Schema({
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
  source: String, // FATF / CRA / Internal
  active: { type: Boolean, default: true },
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  timestamps: true,
});

module.exports = mongoose.model("CountryRisk", CountryRiskSchema);
