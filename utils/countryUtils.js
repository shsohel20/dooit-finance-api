/**
 * utils/countryUtils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ISO 3166-1 country code utilities.
 *
 * Exports:
 *   toAlpha3(input)   — convert any country identifier to ISO alpha-3 code
 *   toAlpha2(input)   — convert any country identifier to ISO alpha-2 code
 *   getCountry(input) — return the full country object { name, alpha2, alpha3 }
 *
 * Input can be:
 *   - Full English name  : "Bangladesh", "United Kingdom"
 *   - Alpha-2 code       : "BD", "GB"
 *   - Alpha-3 code       : "BGD", "GBR"
 *   - Known alias        : "Britain", "Holland", "USA", "Czechia"
 *
 * All lookups are case-insensitive and trim whitespace.
 * Returns null / undefined when no match is found — callers should handle gracefully.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const countries = require("../data/countries-alpha3.json");

// ── Build lookup maps once at module load ────────────────────────────────────
// Map: normalised string → country object
const _index = new Map();

for (const c of countries) {
  const a3 = c.alpha3.toUpperCase();
  const a2 = c.alpha2.toUpperCase();
  const name = c.name.toLowerCase().trim();

  _index.set(name, c);         // full name → country
  _index.set(a2, c);           // alpha-2   → country
  _index.set(a3, c);           // alpha-3   → country

  for (const alias of c.aliases || []) {
    const key = alias.toLowerCase().trim();
    if (!_index.has(key)) {
      _index.set(key, c);
    }
  }
}

// ── Internal resolver ─────────────────────────────────────────────────────────

/**
 * Resolve input → country object.
 * @param {string|null|undefined} input
 * @returns {Object|null}
 */
const getCountry = (input) => {
  if (!input || typeof input !== "string") return null;
  const key = input.trim().toUpperCase(); // try uppercase first (alpha-2/3)
  if (_index.has(key)) return _index.get(key);
  const lower = input.trim().toLowerCase(); // then lowercase (full name / alias)
  return _index.get(lower) || null;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * toAlpha3 — convert any country identifier to ISO 3166-1 alpha-3 code.
 *
 * @param {string} input — full name, alpha-2, alpha-3, or alias
 * @returns {string|null} — e.g. "BGD", or null if not found
 *
 * @example
 *   toAlpha3("Bangladesh")      // → "BGD"
 *   toAlpha3("BD")              // → "BGD"
 *   toAlpha3("BGD")             // → "BGD"
 *   toAlpha3("United Kingdom")  // → "GBR"
 *   toAlpha3("UK")              // → "GBR"
 *   toAlpha3("Czechia")         // → "CZE"
 *   toAlpha3(undefined)         // → null
 */
const toAlpha3 = (input) => {
  const c = getCountry(input);
  return c ? c.alpha3 : null;
};

/**
 * toAlpha2 — convert any country identifier to ISO 3166-1 alpha-2 code.
 *
 * @param {string} input
 * @returns {string|null} — e.g. "BD", or null if not found
 */
const toAlpha2 = (input) => {
  const c = getCountry(input);
  return c ? c.alpha2 : null;
};

module.exports = { toAlpha3, toAlpha2, getCountry };
