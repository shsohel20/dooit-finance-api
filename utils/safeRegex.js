// utils/safeRegex.js
//
// Linear-time regex compilation for untrusted rule patterns.
//
// Rule conditions arrive from the API, CSV imports, and inline backtest
// drafts — an attacker-supplied pattern like (a+)+$ makes JavaScript's
// backtracking RegExp engine take exponential time and blocks the event
// loop across a 20k-transaction backtest scan. Google's RE2 (the `re2`
// native binding) guarantees linear-time matching for every pattern it
// accepts, at the cost of not supporting backreferences or lookarounds —
// patterns RE2 rejects evaluate as non-matching, consistent with the
// evaluator's tolerant-false design.
//
// `re2` is an optionalDependency: on a platform with no prebuilt binary the
// install skips it and we FAIL CLOSED — regex leaves refuse to execute
// (evaluate false) rather than run the exploitable backtracking engine.
// Length caps cannot fix RegExp's complexity class: (a+)+$ against 60
// characters is already ~2^60 steps, so a "capped fallback" is not a real
// safety net on a single-threaded API.

let RE2 = null;
try {
    RE2 = require('re2');
} catch (err) {
    console.warn(
        '[safeRegex] native re2 unavailable — regex rule conditions are DISABLED ' +
        '(they evaluate as non-matching) until `npm install re2` succeeds on this ' +
        'platform:',
        err.message
    );
}

// A rule holds few distinct patterns but each one is tested against
// thousands of transactions per backtest — cache the compiled objects.
// Bounded so attacker-varied inline patterns can't grow memory forever.
const MAX_CACHE_ENTRIES = 500;
const cache = new Map(); // pattern → compiled matcher | null (null = invalid)

const MAX_PATTERN_LENGTH = 200;

const compile = (pattern) => {
    try {
        return new RE2(pattern, 'i');
    } catch {
        return null; // invalid or unsupported syntax
    }
};

/**
 * Case-insensitive matcher for an untrusted pattern.
 * Returns an object with .test(str), or null when the pattern is invalid,
 * unsupported, oversized, or RE2 is unavailable — the caller treats null as
 * "leaf evaluates false", like any other malformed rule input.
 */
const getSafeRegex = (pattern) => {
    if (!RE2) return null; // fail closed — see header comment
    if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN_LENGTH) {
        return null;
    }
    if (cache.has(pattern)) return cache.get(pattern);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear(); // simple reset beats unbounded growth
    const compiled = compile(pattern);
    cache.set(pattern, compiled);
    return compiled;
};

module.exports = { getSafeRegex, usingRE2: !!RE2 };
