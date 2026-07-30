/**
 * models/AmlMatch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One document per AML/PEP/Sanctions/Adverse-Media *match* returned by Sumsub
 * (ComplyAdvantage Mesh) for a customer. Split out of Customer.amlHits so that
 * a compliance analyst can review each match independently — mark it a false
 * positive / true positive, whitelist it, set a risk level — without those
 * decisions being blown away the next time screening re-runs.
 *
 * A re-screen only inserts hits the customer doesn't already have a row for
 * (matched by matchId); existing rows — machine-populated fields and analyst
 * decisions (matchStatus, whitelisted, riskLevel, reviewStatus…) alike — are
 * left untouched so a review is never overwritten or reset.
 *
 * See services/amlMatchService.js for the insert + status-recompute logic.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

// Analyst decision on a single match — mirrors the Sumsub / ComplyAdvantage
// "Match status" dropdown (Unknown / False positive / Potential / True positive).
const MATCH_STATUS = ["unknown", "false_positive", "potential_match", "true_positive"];
const RISK_LEVEL = ["", "low", "medium", "high"];
const REVIEW_STATUS = ["pending", "reviewed"];

const AmlMatchSchema = new Schema(
  {
    // ── Ownership / linkage ──────────────────────────────────────────────────
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    sumsubApplicantId: { type: String, default: null },
    // Stable id of the hit from the AML provider — the upsert key with customer.
    matchId: { type: String, required: true },

    // ── Machine-populated match data (refreshed on every screen) ─────────────
    name: { type: String, default: "" },
    entityType: { type: String, default: "individual" }, // individual | company
    categories: { type: [String], default: [] }, // e.g. "Adverse Media Violence", "Pep Class 2"
    riskLabels: { type: [String], default: [] }, // e.g. ["adverseMedia","crime","pep"]
    relevance: { type: String, default: "" }, // e.g. "Exact name match"
    countries: { type: [String], default: [] },
    nameVariations: { type: [String], default: [] }, // aka / alternate spellings
    sources: { type: [Schema.Types.Mixed], default: [] }, // watchlist + media entries
    raw: { type: Schema.Types.Mixed, default: null }, // full provider hit (future-proofing)
    lastSeenAt: { type: Date, default: Date.now }, // last screen that returned this match

    // ── Analyst decision (preserved across re-screens) ───────────────────────
    matchStatus: { type: String, enum: MATCH_STATUS, default: "unknown" },
    whitelisted: { type: Boolean, default: false },
    riskLevel: { type: String, enum: RISK_LEVEL, default: "" },
    reviewStatus: { type: String, enum: REVIEW_STATUS, default: "pending" },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: "" },
  },
  { timestamps: true }
);

// One match per (customer, provider hit) — the upsert target.
AmlMatchSchema.index({ customer: 1, matchId: 1 }, { unique: true });

AmlMatchSchema.statics.MATCH_STATUS = MATCH_STATUS;
AmlMatchSchema.statics.RISK_LEVEL = RISK_LEVEL;
AmlMatchSchema.statics.REVIEW_STATUS = REVIEW_STATUS;

module.exports = mongoose.model("AmlMatch", AmlMatchSchema);
