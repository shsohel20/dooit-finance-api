"use strict";

// Resolves a free-text clientType string → a canonical EntityType.name from the DB.
// Results are cached in-process for 5 minutes to avoid a DB round-trip on every request.
// Call invalidateCache() after any EntityType create/update/delete.

const EntityType = require("../models/EntityType");

const TTL = 5 * 60 * 1000; // 5 minutes
let _cache   = null;
let _cacheAt = 0;

async function loadEntityTypes() {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;
  _cache   = await EntityType.find({ active: true }).lean();
  _cacheAt = Date.now();
  return _cache;
}

/**
 * Resolves clientType string → canonical EntityType.name.
 * Match order (first wins):
 *   1. Exact name match (case-insensitive)
 *   2. Any matchKeyword substring in clientType (or vice versa)
 *   3. Fuzzy: the part of the name after " - " matches substring of clientType
 * Returns null if no match found.
 */
async function resolveEntityType(clientType = "") {
  if (!clientType) return null;
  const types = await loadEntityTypes();
  const lower = clientType.toLowerCase().trim();

  // 1. Exact name
  const exact = types.find(et => et.name.toLowerCase() === lower);
  if (exact) return exact.name;

  // 2. matchKeywords array
  const byKeyword = types.find(
    et => (et.matchKeywords || []).some(kw => kw && lower.includes(kw.toLowerCase()))
  );
  if (byKeyword) return byKeyword.name;

  // 3. Fuzzy name (e.g. "Tranche 1 - Banks & ADIs" → "banks & adis")
  const byFuzzy = types.find(et => {
    const tail = (et.name.split(" - ").pop() || "").toLowerCase();
    return tail.length > 3 && lower.includes(tail);
  });
  if (byFuzzy) return byFuzzy.name;

  return null;
}

function invalidateCache() {
  _cache   = null;
  _cacheAt = 0;
}

module.exports = { resolveEntityType, invalidateCache };
