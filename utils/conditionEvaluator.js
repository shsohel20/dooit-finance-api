"use strict";

/**
 * conditionEvaluator.js
 *
 * Evaluates risk pool condition DSL objects and applies lMod likelihood
 * adjustments. Used by the DB-backed risk register engine.
 */

/**
 * Evaluate a single ConditionRule against questionnaire answers.
 * @param {{ field, op, value?, values?, text?, optional? }} rule
 * @param {object} answers
 * @returns {boolean}
 */
function evaluateRule(rule, answers) {
  const raw = answers[rule.field];
  const arr = Array.isArray(raw) ? raw : (raw ? [String(raw)] : []);
  const str = raw != null ? String(raw) : null;

  switch (rule.op) {
    case "exists":
      return raw != null && raw !== "";

    case "not_exists":
      return raw == null || raw === "";

    case "equals":
      return str === rule.value;

    case "not_equals":
      // field must exist AND not equal value (unless optional)
      if (rule.optional) return str == null || str !== rule.value;
      return str != null && str !== "" && str !== rule.value;

    case "includes_any": {
      const targets = rule.values || [];
      if (rule.optional && (raw == null || raw === "")) return true;
      if (raw == null) return false;
      return targets.some(v => arr.includes(v) || (str && str.includes(v)));
    }

    case "includes_text":
      if (raw == null) return false;
      return str.includes(rule.text || "");

    case "not_includes_text":
      // field must exist AND text NOT in field
      if (raw == null || raw === "") return false;
      return !str.includes(rule.text || "");

    default:
      return true;
  }
}

/**
 * Evaluate a condition DSL object.
 * @param {{ type, logic?, rules? }} condition
 * @param {object} answers
 * @returns {boolean}
 */
function evaluateCondition(condition, answers) {
  if (!condition || condition.type === "always") return true;
  if (condition.type !== "field_check") return true;

  const rules = condition.rules || [];
  if (rules.length === 0) return true;

  const results = rules.map(r => evaluateRule(r, answers));
  return condition.logic === "and"
    ? results.every(Boolean)
    : results.some(Boolean);
}

/**
 * Apply likelihood modifiers from DB lMods array.
 * @param {Array<{ field, op, value?, text?, values?, delta }>} lMods
 * @param {object} answers
 * @param {number} L  base likelihood
 * @returns {number}  adjusted likelihood (capped at 5)
 */
function applyLMods(lMods, answers, L) {
  let likelihood = L;
  for (const mod of (lMods || [])) {
    const raw = answers[mod.field];
    const str = raw != null ? String(raw) : null;
    const arr = Array.isArray(raw) ? raw : (raw ? [str] : []);
    let matches = false;

    switch (mod.op) {
      case "equals":
        matches = str === mod.value;
        break;
      case "not_equals":
        matches = str != null && str !== "" && str !== mod.value;
        break;
      case "includes_text":
        matches = str != null && str.includes(mod.text || "");
        break;
      case "includes_any": {
        const targets = mod.values || [];
        matches = targets.some(v => arr.includes(v));
        break;
      }
    }

    if (matches) likelihood = Math.min(likelihood + (mod.delta || 1), 5);
  }
  return likelihood;
}

module.exports = { evaluateCondition, applyLMods };
