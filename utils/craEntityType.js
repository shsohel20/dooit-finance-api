"use strict";

/**
 * Derive the CRA product-catalogue entity type(s) for a client from its
 * registered EntityProfile(s) (spec: "System shows only the product options
 * relevant to the entity's registered entity_type").
 *
 * EntityType.name values are tranche-prefixed ("Tranche 1 - Banks & ADIs",
 * "Tranche 2 - Real Estate") while the CRA catalogue (RiskFactorOption
 * .entityType) uses the bare names from CRA_Scoring_Method.md Section 3 —
 * including "Real Estate Agents", which differs from the EntityType name.
 */

const EntityProfile = require("../models/EntityProfile");

/** The 10 canonical catalogue names (must match RiskFactorOption.entityType) */
const CRA_ENTITY_TYPES = [
  "Banks & ADIs",
  "Remittance",
  "VASP/DCEP",
  "Gambling/Casino",
  "Insurance",
  "Lawyers/Conveyancers",
  "Accountants",
  "Real Estate Agents",
  "Precious Metal Dealers",
  "TCSPs",
];

// EntityType names whose bare form differs from the catalogue name
const NAME_EXCEPTIONS = {
  "real estate": "Real Estate Agents",
};

/**
 * Map an EntityType.name (or already-bare name) to the canonical CRA
 * catalogue entity type. Returns null when it can't be mapped.
 */
function mapEntityTypeName(name) {
  if (!name) return null;
  const bare = String(name).replace(/^tranche\s*\d+\s*-\s*/i, "").trim();
  const exception = NAME_EXCEPTIONS[bare.toLowerCase()];
  if (exception) return exception;
  return (
    CRA_ENTITY_TYPES.find((t) => t.toLowerCase() === bare.toLowerCase()) || null
  );
}

/**
 * Entity types for a client's Active entity profiles, mapped to catalogue
 * names, deduped. Returns [] when the client has no profiles (or none map).
 */
async function deriveClientEntityTypes(clientId) {
  if (!clientId) return [];
  const profiles = await EntityProfile.find({ client: clientId, status: "Active" })
    .populate("entityType", "name")
    .select("entityType")
    .lean();

  const mapped = profiles
    .map((p) => mapEntityTypeName(p.entityType?.name))
    .filter(Boolean);

  return [...new Set(mapped)];
}

module.exports = { CRA_ENTITY_TYPES, mapEntityTypeName, deriveClientEntityTypes };
