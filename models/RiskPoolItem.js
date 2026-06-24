"use strict";
const mongoose = require("mongoose");

/**
 * RiskPoolItem — one row in the VDG risk pool.
 *
 * `condition` and `lMods` are stored as plain JSON (condition DSL) instead of
 * JS functions, so they can be created/edited from the UI and evaluated server-side
 * by utils/conditionEvaluator.js.
 *
 * condition DSL:
 *   { type: "always" }
 *   { type: "field_check", logic: "or"|"and", rules: ConditionRule[] }
 *
 * ConditionRule:
 *   { field, op: "equals"|"not_equals"|"includes_any"|"includes_text"|"not_includes_text"|"exists"|"not_exists",
 *     value?, values?, text?, optional? }
 *
 * lMod:
 *   { field, op: "equals"|"includes_text"|"not_equals"|"includes_any", value?, text?, values?, delta }
 */

const ruleSchema = new mongoose.Schema({
  field:    { type: String, required: true },
  op:       { type: String, required: true,
               enum: ["equals","not_equals","includes_any","includes_text","not_includes_text","exists","not_exists"] },
  value:    { type: String },
  values:   [{ type: String }],
  text:     { type: String },
  optional: { type: Boolean, default: false },
}, { _id: false });

const conditionSchema = new mongoose.Schema({
  type:  { type: String, required: true, enum: ["always","field_check"], default: "always" },
  logic: { type: String, enum: ["or","and"], default: "or" },
  rules: [ruleSchema],
}, { _id: false });

const lModSchema = new mongoose.Schema({
  field:  { type: String, required: true },
  op:     { type: String, required: true,
             enum: ["equals","includes_text","not_equals","includes_any"] },
  value:  { type: String },
  text:   { type: String },
  values: [{ type: String }],
  delta:  { type: Number, required: true, default: 1 },
}, { _id: false });

const RiskPoolItemSchema = new mongoose.Schema({
  sec:     { type: String, required: true, enum: ["S1","S2","S3","S4","S5","S6"] },
  secName: { type: String, required: true },
  ref:     { type: String, required: true, uppercase: true }, // "C-001"
  riskType:{ type: String, required: true,
              enum: ["Customer","Product","Jurisdiction","Channel","Behaviour","Operational"] },
  ch:      { type: String, required: true }, // "F,D,T"
  riskName:{ type: String, required: true },
  description:     { type: String, default: "" },
  pfSanctionsNote: { type: String, default: "" },
  L: { type: Number, required: true, min: 1, max: 5 },
  C: { type: Number, required: true, min: 1, max: 5 },
  existingControls: { type: String, default: "" },
  controlIds:  [{ type: String }],
  ctrlFactor:  { type: String, default: "" }, // "EW_C_001"

  // "ALL" or an array of entity type strings
  entities: { type: mongoose.Schema.Types.Mixed, default: "ALL" },

  condition: { type: conditionSchema, default: () => ({ type: "always" }) },
  lMods:     { type: [lModSchema], default: [] },

  sortOrder: { type: Number, default: 0 },
  isActive:  { type: Boolean, default: true },

  /**
   * client = null  → global/system default (shared across all clients, seeded once)
   * client = ObjectId → client-specific override or addition; only visible to that client
   */
  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },
}, {
  timestamps: true,
  collection: "riskpoolitems",
});

// Compound unique: same ref can exist once globally (client=null) and once per client
RiskPoolItemSchema.index({ ref: 1, client: 1 }, { unique: true });
RiskPoolItemSchema.index({ sec: 1, sortOrder: 1 });
RiskPoolItemSchema.index({ isActive: 1, client: 1 });

module.exports = mongoose.model("RiskPoolItem", RiskPoolItemSchema);
