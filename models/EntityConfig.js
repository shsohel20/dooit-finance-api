"use strict";
const mongoose = require("mongoose");

const EntityConfigSchema = new mongoose.Schema({
  entityType: {
    type: String, required: true, unique: true,
    enum: [
      "Lawyers/Conveyancers","Accountants","Real Estate Agents",
      "Precious Metal Dealers","TCSPs",
      "Banks & ADIs","Remittance","VASP/DCEP","Gambling/Casino","Insurance",
    ],
  },
  tranche:     { type: String, enum: ["T1","T2"], required: true },
  lpp:         { type: Boolean, default: false },
  travelRule:  { type: Boolean, default: false },
  gambling5k:  { type: Boolean, default: false },
  nraML:       { type: String, default: "" },
  nraTF:       { type: String, default: "" },
  nraPF:       { type: String, default: "" },
  evalYears:   { type: Number, default: 3 },
  displayLabel:{ type: String, default: "" }, // optional UI display override
  isActive:    { type: Boolean, default: true },
}, {
  timestamps: true,
  collection: "entityconfigs",
});

module.exports = mongoose.model("EntityConfig", EntityConfigSchema);
