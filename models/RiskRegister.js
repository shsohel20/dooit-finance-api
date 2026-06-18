"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

// ── Row sub-schema ────────────────────────────────────────────────────────────

const RowSchema = new Schema(
  {
    rowNum:            Number,
    sec:               String,
    secName:           String,
    ref:               { type: String, required: true },
    riskType:          String,
    ch:                String,
    riskName:          { type: String, required: true },
    description:       String,
    pfSanctionsNote:   String,
    L:                 { type: Number, min: 1, max: 5 },
    C:                 { type: Number, min: 1, max: 5 },
    inherentRisk:      { type: String, enum: ["VL","L","M","H","E",""] },
    inherentRiskLabel: String,
    existingControls:  String,
    controlIds:        [String],
    ctrlFactor:        String,
    category:          { type: String, enum: ["cdd","tm","scr","geo","gov",""] },
    controlEffectiveness: { type: Number, min: 1, max: 5 },
    residualRisk:      { type: String, enum: ["VL","L","M","H","E",""] },
    residualRiskLabel: String,
    actionRequired:    { type: Boolean, default: false },
    withinRiskAppetite:{ type: Boolean, default: true },
    controlsOwner:     String,
    preparedBy:        String,
    reviewedBy:        String,
    // Manual override fields
    manualL:           { type: Number, min: 1, max: 5 },
    manualC:           { type: Number, min: 1, max: 5 },
    manualCtrlEff:     { type: Number, min: 1, max: 5 },
    reviewerNotes:     String,
    status:            { type: String, enum: ["Draft","Reviewed","Approved"], default: "Draft" },
  },
  { _id: false }
);

// ── CtrlEff sub-schema ────────────────────────────────────────────────────────

const CtrlEffSchema = new Schema(
  {
    cdd: { type: Number, min: 1, max: 5, default: 3 },
    tm:  { type: Number, min: 1, max: 5, default: 3 },
    scr: { type: Number, min: 1, max: 5, default: 3 },
    geo: { type: Number, min: 1, max: 5, default: 3 },
    gov: { type: Number, min: 1, max: 5, default: 3 },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────

const RiskRegisterSchema = new Schema(
  {
    // Entity identity
    entityName:   { type: String, required: true, trim: true },
    entityType:   {
      type: String,
      required: true,
      enum: [
        "Lawyers/Conveyancers", "Accountants", "Real Estate Agents",
        "Precious Metal Dealers", "TCSPs",
        "Banks & ADIs", "Remittance", "VASP/DCEP",
        "Gambling/Casino", "Insurance",
      ],
    },
    abn:          { type: String, trim: true },
    assessDate:   { type: Date, default: Date.now },

    // Compliance officers
    coName:       String,
    coEmail:      String,
    coPhone:      String,
    smName:       String,
    smEmail:      String,

    // Full questionnaire answers (Onboarding_Questions maps_to keys)
    answers:      { type: Schema.Types.Mixed, default: {} },

    // Control effectiveness (5 categories, rated 1-5)
    ctrlEff:      { type: CtrlEffSchema, default: () => ({}) },

    // Generated risk register rows (scored by engine)
    rows:         [RowSchema],

    // Summary statistics (computed on generate/recalculate)
    rowCount:          { type: Number, default: 0 },
    actionCount:       { type: Number, default: 0 },
    overallResidual:   { type: String, enum: ["VL","L","M","H","E",""], default: "L" },
    overallResidualLabel: String,
    residualCounts:    { type: Schema.Types.Mixed, default: {} },

    // Workflow
    status: {
      type:    String,
      enum:    ["Draft","In Review","Approved"],
      default: "Draft",
    },
    submittedAt:  Date,
    approvedAt:   Date,
    approvedBy:   { type: Schema.Types.ObjectId, ref: "User" },

    // Tenant / user tracking
    client:       { type: Schema.Types.ObjectId, ref: "Client", index: true },
    createdBy:    { type: Schema.Types.ObjectId, ref: "User" },
    updatedBy:    { type: Schema.Types.ObjectId, ref: "User" },

    // Version / amendment tracking
    version:      { type: Number, default: 1 },
    amendedFrom:  { type: Schema.Types.ObjectId, ref: "RiskRegister" },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

RiskRegisterSchema.index({ client: 1, entityType: 1 });
RiskRegisterSchema.index({ client: 1, status: 1 });
RiskRegisterSchema.index({ client: 1, createdAt: -1 });

module.exports = mongoose.model("RiskRegister", RiskRegisterSchema);
