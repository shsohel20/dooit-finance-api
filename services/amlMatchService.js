/**
 * services/amlMatchService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Business logic for AML *matches* (AmlMatch collection).
 *
 *   normalizeHit(rawHit)                  — Sumsub/ComplyAdvantage hit → our shape
 *   upsertMatchesForCustomer(cust, hits)  — insert only new hits, leave existing matches untouched
 *   recomputeCustomerAmlStatus(customerId)— derive Customer.amlStatus from matches
 *
 * Why recompute instead of trusting the KYC review answer? A GREEN KYC applicant
 * can still have PEP / adverse-media / sanctions hits — status must reflect the
 * *matches* (and the analyst's disposition of them), never the identity result.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const AmlMatch = require("../models/AmlMatch");
const Customer = require("../models/Customer");

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const isSanctionLabel = (l) => /sanction/i.test(String(l || ""));
const isPepLabel = (l) => /pep/i.test(String(l || ""));

/**
 * Normalize one provider hit into the AmlMatch shape.
 * Field names vary across provider versions, so every extraction is defensive
 * with sensible fallbacks (e.g. derive Categories from watchlist source names
 * when the provider doesn't send an explicit categories array).
 *
 * @param {Object} rawHit
 * @returns {Object} normalized fields (no analyst decisions)
 */
const normalizeHit = (rawHit = {}) => {
  const sources = asArray(rawHit.sources);
  const riskLabels = asArray(rawHit.riskLabels).map(String).filter(Boolean);

  // Categories — prefer explicit provider categories/types; else derive from
  // the distinct watchlist source names so the column is never empty.
  let categories = asArray(rawHit.categories)
    .concat(asArray(rawHit.matchTypes), asArray(rawHit.types))
    .map((c) => (typeof c === "string" ? c : c?.name || c?.label || c?.type))
    .filter(Boolean);
  if (categories.length === 0) {
    categories = Array.from(
      new Set(
        sources
          .filter((s) => s?.type === "watchlist")
          .map((s) => s?.name)
          .filter(Boolean),
      ),
    );
  }
  categories = Array.from(new Set(categories));

  // Countries — accept array, single value, or nested field objects.
  const countries = Array.from(
    new Set(
      asArray(rawHit.countries || rawHit.fields?.countries)
        .map((c) => (typeof c === "string" ? c : c?.name || c?.code))
        .filter(Boolean),
    ),
  );

  // Name variations / aliases.
  const nameVariations = Array.from(
    new Set(
      asArray(rawHit.aka || rawHit.nameVariations || rawHit.akas)
        .map((n) => (typeof n === "string" ? n : n?.name || n?.value))
        .filter(Boolean),
    ),
  );

  const relevance =
    (typeof rawHit.relevance === "string" && rawHit.relevance) ||
    rawHit.matchType ||
    (rawHit.matchTypes ? asArray(rawHit.matchTypes).join(", ") : "") ||
    "";

  return {
    name: rawHit.name || "",
    entityType: rawHit.entityType || "individual",
    categories,
    riskLabels,
    relevance,
    countries,
    nameVariations,
    sources,
    raw: rawHit,
  };
};

/** Stable match id — fall back to a deterministic key when the hit has no id. */
const resolveMatchId = (rawHit, index) =>
  rawHit?.id ||
  rawHit?.matchId ||
  `${(rawHit?.name || "unknown").toLowerCase().replace(/\s+/g, "-")}-${index}`;

/**
 * Insert only the provider hits a customer doesn't already have a match row
 * for, keyed by matchId. Existing matches are left untouched — they may carry
 * an analyst's disposition (matchStatus, whitelisted, riskLevel…), and a
 * re-screen must never clobber that decision, so we skip them entirely
 * instead of re-writing their machine-populated fields.
 *
 * @param {Customer} customer — must have _id (and ideally sumsubApplicantId)
 * @param {Array}    hits     — raw provider hits (customer.amlHits shape)
 * @returns {Promise<number>} number of new match rows inserted
 */
const upsertMatchesForCustomer = async (customer, hits = []) => {
  if (!customer?._id || !Array.isArray(hits) || hits.length === 0) return 0;

  const existingIds = new Set(
    (await AmlMatch.find({ customer: customer._id }).select("matchId").lean()).map(
      (m) => m.matchId,
    ),
  );

  const newHits = hits
    .map((rawHit, i) => ({ rawHit, matchId: resolveMatchId(rawHit, i) }))
    .filter(({ matchId }) => !existingIds.has(matchId));

  if (newHits.length === 0) return 0;

  await Promise.all(
    newHits.map(({ rawHit, matchId }) => {
      const norm = normalizeHit(rawHit);
      return AmlMatch.updateOne(
        { customer: customer._id, matchId },
        {
          $set: {
            sumsubApplicantId: customer.sumsubApplicantId || null,
            ...norm,
            lastSeenAt: new Date(),
          },
          $setOnInsert: {
            matchStatus: "unknown",
            whitelisted: false,
            riskLevel: "",
            reviewStatus: "pending",
          },
        },
        { upsert: true },
      );
    }),
  );

  return newHits.length;
};

/**
 * Recompute Customer.amlStatus (and isPep / sanction) from that customer's
 * matches and their analyst dispositions.
 *
 * A match is "effective" (still counts against the customer) when it is NOT
 * whitelisted and NOT dismissed as a false positive.
 *   • no effective matches                         → "clear"
 *   • any effective true-positive OR sanction hit  → "flagged"
 *   • otherwise (unresolved unknown / potential)   → "yellow" (needs review)
 *
 * @param {ObjectId|string} customerId
 * @returns {Promise<string|null>} the new amlStatus
 */
const recomputeCustomerAmlStatus = async (customerId) => {
  const matches = await AmlMatch.find({ customer: customerId })
    .select("matchStatus whitelisted riskLabels")
    .lean();

  const update = {};

  if (matches.length === 0) {
    update.amlStatus = "clear";
    await Customer.updateOne({ _id: customerId }, update);
    return update.amlStatus;
  }

  const effective = matches.filter(
    (m) => !m.whitelisted && m.matchStatus !== "false_positive",
  );
  const hasSanction = effective.some((m) => asArray(m.riskLabels).some(isSanctionLabel));

  let amlStatus;
  if (effective.length === 0) amlStatus = "clear";
  else if (effective.some((m) => m.matchStatus === "true_positive") || hasSanction)
    amlStatus = "flagged";
  else amlStatus = "yellow";

  update.amlStatus = amlStatus;
  // Flags reflect only the matches that still count (whitelisting a PEP hit
  // clears the PEP flag — the correct compliance behaviour).
  update.isPep = effective.some((m) => asArray(m.riskLabels).some(isPepLabel));
  update.sanction = hasSanction;

  await Customer.updateOne({ _id: customerId }, update);
  return amlStatus;
};

module.exports = {
  normalizeHit,
  resolveMatchId,
  upsertMatchesForCustomer,
  recomputeCustomerAmlStatus,
};
