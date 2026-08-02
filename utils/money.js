// utils/money.js
//
// Decimal128 helpers for the billing module.
//
// WHY Decimal128 and not Number: unit prices in the product catalogue run to
// four decimal places (A$0.0065 Device Intelligence, A$0.0198 Applicant Risk
// Scoring). IEEE-754 doubles cannot represent those exactly, and the error
// accumulates when summing thousands of usage records into an invoice total.
//
// IMPORTANT: Mongoose's built-in `min` / `max` validators only apply to Number
// and Date paths. On a Decimal128 path they are silently ignored — a schema
// written as `{ type: Decimal128, min: 0 }` will happily store -5. Use the
// validators below instead.

const mongoose = require("mongoose");
const { Decimal128 } = mongoose.Types;

/** Coerce a number/string/Decimal128 into Decimal128 (6dp of headroom). */
const toDecimal = (v) => {
  if (v == null) return null;
  if (v instanceof Decimal128) return v;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`Cannot convert "${v}" to Decimal128`);
  return Decimal128.fromString(n.toFixed(6));
};

/** Decimal128 (or null) -> JS number. Display and comparison only. */
const toNumber = (d) => (d == null ? 0 : parseFloat(d.toString()));

/** Round a numeric value to 2dp (currency minor units) as Decimal128. */
const toMoney = (v) => Decimal128.fromString(Number(v).toFixed(2));

// ── Reusable path validators ─────────────────────────────────────────────────

/** Rejects negative amounts. Allows zero and null/undefined (use `required` for presence). */
const nonNegative = {
  validator(v) {
    return v == null || toNumber(v) >= 0;
  },
  message: (props) => `${props.path} cannot be negative (got ${props.value})`,
};

/** Rejects zero and negative amounts. */
const positive = {
  validator(v) {
    return v == null || toNumber(v) > 0;
  },
  message: (props) => `${props.path} must be greater than zero (got ${props.value})`,
};

/** Rejects values with more than `dp` decimal places. */
const maxScale = (dp = 6) => ({
  validator(v) {
    if (v == null) return true;
    const [, frac = ""] = v.toString().split(".");
    return frac.replace(/0+$/, "").length <= dp;
  },
  message: (props) => `${props.path} cannot have more than ${dp} decimal places`,
});

// ── API serialisation ────────────────────────────────────────────────────────

const isDecimal = (v) =>
  v != null && typeof v === "object" && v._bsontype === "Decimal128";

/**
 * Recursively replace Decimal128 values with plain JS numbers.
 *
 * Without this, `JSON.stringify(doc)` emits `{"$numberDecimal":"0.79"}`, which
 * every API consumer would have to unwrap. Wire it into a schema with:
 *
 *   toJSON: { virtuals: true, transform: (_doc, ret) => serializeDecimals(ret) }
 *
 * The stored value stays Decimal128 — this only affects what leaves the API.
 */
const serializeDecimals = (value) => {
  if (isDecimal(value)) return parseFloat(value.toString());
  if (Array.isArray(value)) return value.map(serializeDecimals);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    // Skip ObjectId and other BSON types that are not Decimal128
    if (value._bsontype) return value;
    for (const k of Object.keys(value)) value[k] = serializeDecimals(value[k]);
    return value;
  }
  return value;
};

module.exports = {
  toDecimal,
  toNumber,
  toMoney,
  nonNegative,
  positive,
  maxScale,
  isDecimal,
  serializeDecimals,
};
