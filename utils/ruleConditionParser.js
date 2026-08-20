// utils/ruleConditionParser.js
//
// DSL → structured conditions parser, extracted verbatim from
// ruleEngineController so it can be shared with services/ruleEvaluation
// without a circular require.
//
// Parse a rule-condition string back into the same shape the UI builder
// produces. Mirrors the inverse of `conditionToExpr` in
// `ui/.../RuleEditor.js`. Tolerant: returns `null` for anything we can't
// parse cleanly so the caller falls back to keeping the string only.
//
// Handles the operators the builder emits:
//   gt/gte/lt/lte/eq/ne, in/nin, between, contains, startsWith, endsWith,
//   exists, regex, and the common "=" alias for eq.

const stripQuotes = (s) => s.trim().replace(/^["'](.*)["']$/, '$1');

const coerceValue = (raw) => {
    const t = stripQuotes(String(raw));
    if (t === '') return t;
    // Strip thousand-separator commas (e.g. "1,000" → 1000, "50,000" → 50000)
    const stripped = t.replace(/,(?=\d{3}(\D|$))/g, '');
    if (/^-?\d+(\.\d+)?$/.test(stripped)) {
        const n = Number(stripped);
        if (Number.isFinite(n)) return n;
    }
    if (t.toLowerCase() === 'true') return true;
    if (t.toLowerCase() === 'false') return false;
    return t;
};

const splitList = (inner) =>
    inner.split(',').map((v) => coerceValue(v.trim())).filter((v) => v !== '');

// Match against a single expression (no AND/OR splitters). Order matters —
// longest/most-specific patterns first.
const LEAF_PATTERNS = [
    {
        re: /^(.+?)\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'between', min: coerceValue(m[2]), max: coerceValue(m[3]) })
    },
    {
        re: /^(.+?)\s+NOT\s+IN\s+\[(.*)\]$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'nin', values: splitList(m[2]) })
    },
    {
        re: /^(.+?)\s+IN\s+\[(.*)\]$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'in', values: splitList(m[2]) })
    },
    {
        re: /^(.+?)\s+STARTS\s+WITH\s+(.+)$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'startsWith', value: stripQuotes(m[2]) })
    },
    {
        re: /^(.+?)\s+ENDS\s+WITH\s+(.+)$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'endsWith', value: stripQuotes(m[2]) })
    },
    {
        re: /^(.+?)\s+CONTAINS\s+(.+)$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'contains', value: stripQuotes(m[2]) })
    },
    {
        re: /^(.+?)\s+MATCHES\s+\/(.+)\/$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'regex', value: m[2] })
    },
    {
        re: /^(.+?)\s+EXISTS$/i,
        build: (m) => ({ field: m[1].trim(), operator: 'exists' })
    },
    {
        re: /^(.+?)\s*>=\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'gte', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*<=\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'lte', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*!=\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'ne', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*==\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'eq', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*>\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'gt', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*<\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'lt', value: coerceValue(m[2]) })
    },
    {
        re: /^(.+?)\s*=\s*(.+)$/,
        build: (m) => ({ field: m[1].trim(), operator: 'eq', value: coerceValue(m[2]) })
    },
];

const parseLeaf = (expr) => {
    const trimmed = expr.trim();
    if (!trimmed) return null;
    for (const p of LEAF_PATTERNS) {
        const m = trimmed.match(p.re);
        if (m) return p.build(m);
    }
    return null;
};

// Split the DSL on top-level AND / OR, ignoring:
//   - AND/OR inside quoted strings ('narrative CONTAINS "cash and carry"')
//   - the AND that is part of "BETWEEN x AND y"
//   - any AND/OR appearing inside [...] lists
// Returns [{ expr, combinator }] where the first row's combinator is 'AND'.
const splitTopLevel = (s) => {
    // Mask AND/OR inside quoted strings first — the placeholder embeds the
    // original casing so unmasking restores the value verbatim.
    let masked = s.replace(/"[^"]*"|'[^']*'/g, (quoted) =>
        quoted.replace(/\b(AND|OR)\b/gi, (word) => `@@Q${word}Q@@`)
    );
    // Mask the AND inside BETWEEN so it isn't a splitter
    masked = masked.replace(
        /(\bBETWEEN\b\s+\S+(?:\s+\S+)*?)\s+AND\s+/gi,
        '$1 @@BAND@@ '
    );
    // Mask AND/OR inside bracket lists
    masked = masked.replace(/\[([^\]]*)\]/g, (_, inner) =>
        '[' +
        inner
            .replace(/\bAND\b/gi, '@@LAND@@')
            .replace(/\bOR\b/gi, '@@LOR@@') +
        ']'
    );

    const parts = masked.split(/\s+(AND|OR)\s+/i);
    if (!parts.length) return [];

    const tokens = [];
    for (let i = 0; i < parts.length; i += 2) {
        const expr = parts[i]
            .replace(/@@Q(\w+)Q@@/g, '$1')
            .replace(/@@BAND@@/g, 'AND')
            .replace(/@@LAND@@/g, 'AND')
            .replace(/@@LOR@@/g, 'OR')
            .trim();
        const combinator = i === 0 ? 'AND' : parts[i - 1].toUpperCase();
        if (expr) tokens.push({ expr, combinator });
    }
    return tokens;
};

// Build the logic tree from leaves with combinators (AND has precedence over OR)
// e.g. A AND B OR C  →  { logic: 'OR', children: [{ logic: 'AND', children: [A, B] }, C] }
const buildLogicTreeFromLeaves = (leaves) => {
    if (!leaves.length) return null;
    const stripCombinator = ({ combinator, ...rest }) => rest;
    if (leaves.length === 1) return stripCombinator(leaves[0]);

    const orGroups = [];
    let chunk = [stripCombinator(leaves[0])];
    for (let i = 1; i < leaves.length; i++) {
        if (leaves[i].combinator === 'OR') {
            orGroups.push(chunk);
            chunk = [stripCombinator(leaves[i])];
        } else {
            chunk.push(stripCombinator(leaves[i]));
        }
    }
    orGroups.push(chunk);

    const orChildren = orGroups.map((g) =>
        g.length === 1 ? g[0] : { logic: 'AND', children: g }
    );
    return orChildren.length === 1
        ? orChildren[0]
        : { logic: 'OR', children: orChildren };
};

// Top-level: parse a DSL string into { conditions, logic } or null if any
// part fails to parse (caller keeps just the string ruleCondition).
const parseRuleConditionDSL = (dsl) => {
    if (!dsl || typeof dsl !== 'string') return null;
    const tokens = splitTopLevel(dsl);
    if (!tokens.length) return null;

    const leaves = [];
    for (const t of tokens) {
        const leaf = parseLeaf(t.expr);
        if (!leaf) return null;        // bail on any unparseable expr
        leaves.push({ ...leaf, combinator: t.combinator });
    }
    if (!leaves.length) return null;

    const conditions = leaves.map(({ combinator, ...rest }) => rest);
    const logic = buildLogicTreeFromLeaves(leaves);
    return { conditions, logic };
};

module.exports = { parseRuleConditionDSL };
