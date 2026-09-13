// services/workflowValidation.js
//
// The authoritative graph validator. Errors block publish; warnings never
// block anything.
//
// A near-copy lives at ui/views/workflow-studio/lib/graphValidation.js for
// live feedback in the builder. This file is the one that decides. If you
// change a rule here, change it there — their test suites assert the same
// cases deliberately.

/** Nodes that are annotations, not steps. Exempt from flow rules. */
const isNote = (n) => n.type === 'note';

const err = (code, message, nodeId) => ({ code, message, nodeId });

/**
 * @param {{ startNodeId: string, nodes: Array, edges: Array }} workflow
 * @returns {{ errors: Array, warnings: Array }}
 */
const validateGraph = (workflow) => {
    const errors = [];
    const warnings = [];

    const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
    const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
    const startNodeId = workflow?.startNodeId || '';

    // ── Node ids ─────────────────────────────────────────────────────────────
    const byId = new Map();
    const seen = new Set();
    for (const n of nodes) {
        if (seen.has(n.id)) {
            errors.push(err('DUPLICATE_NODE_ID', `More than one node uses the id "${n.id}".`, n.id));
        }
        seen.add(n.id);
        byId.set(n.id, n);
    }

    // ── Start node ───────────────────────────────────────────────────────────
    const start = byId.get(startNodeId);
    if (!start) {
        // Distinguish "nothing to pick yet" from "steps exist but none is
        // marked": telling a user with an empty canvas to pick a step is an
        // instruction they cannot follow.
        const hasSteps = nodes.some((n) => !isNote(n));
        errors.push(err(
            'NO_START_NODE',
            hasSteps
                ? 'The workflow has no start step. Open a step and mark it as the start.'
                : 'This workflow has no steps yet. Add one from the palette to begin.'
        ));
    } else if (isNote(start)) {
        errors.push(err('START_NODE_IS_NOTE', 'A note cannot be the start step.', start.id));
    }

    // ── Condition nodes ──────────────────────────────────────────────────────
    for (const n of nodes) {
        if (n.type !== 'cond') continue;
        const branches = Array.isArray(n.branches) ? n.branches : [];
        if (!branches.length) {
            errors.push(err('COND_NO_BRANCHES', `"${n.title}" is a condition with no branches.`, n.id));
            continue;
        }
        const last = branches[branches.length - 1];
        if ((last.label || '').trim().toLowerCase() !== 'else') {
            errors.push(err(
                'COND_NO_ELSE',
                `"${n.title}" has no Else branch. Every condition needs a path for the cases none of its branches match.`,
                n.id
            ));
        }

        // A branch with no conditions always matches, so anything after it is
        // unreachable. Only the final Else may be unconditional.
        branches.slice(0, -1).forEach((b, i) => {
            if (!(b.conditions || []).length) {
                errors.push(err(
                    'BRANCH_EMPTY_NOT_LAST',
                    `Branch "${b.label}" on "${n.title}" has no conditions, so it matches everything and the branches after it can never run.`,
                    n.id
                ));
            }
        });
    }

    // ── Edges ────────────────────────────────────────────────────────────────
    for (const e of edges) {
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from) {
            errors.push(err('EDGE_SOURCE_MISSING', `A connector starts at "${e.from}", which is not a step.`, e.from));
            continue;
        }
        if (!to) {
            errors.push(err('EDGE_TARGET_MISSING', `A connector from "${from.title}" points at "${e.to}", which is not a step.`, e.from));
        }
        if (from.endOfFlow) {
            errors.push(err('EDGE_FROM_TERMINAL', `"${from.title}" is marked end of flow but still has an outgoing connector.`, from.id));
        }
        if (e.sourcePort) {
            const branches = Array.isArray(from.branches) ? from.branches : [];
            if (!branches.some((b) => b.key === e.sourcePort)) {
                errors.push(err('SOURCE_PORT_MISSING', `A connector leaves "${from.title}" from a branch that no longer exists.`, from.id));
            }
        }
    }

    // ── Reachability (warnings only) ─────────────────────────────────────────
    if (start && !isNote(start)) {
        const out = new Map();
        for (const e of edges) {
            if (!out.has(e.from)) out.set(e.from, []);
            out.get(e.from).push(e.to);
        }
        // Breadth-first with a visited set — the graph legitimately contains
        // cycles (ongoing due diligence loops), so this must not recurse blindly.
        const reached = new Set([start.id]);
        const queue = [start.id];
        while (queue.length) {
            const id = queue.shift();
            for (const next of out.get(id) || []) {
                if (reached.has(next)) continue;
                reached.add(next);
                queue.push(next);
            }
        }

        for (const n of nodes) {
            if (isNote(n)) continue;
            if (!reached.has(n.id)) {
                warnings.push(err('UNREACHABLE_NODE', `"${n.title}" cannot be reached from the start step.`, n.id));
            }
            if (!n.endOfFlow && !(out.get(n.id) || []).length) {
                warnings.push(err('DEAD_END', `"${n.title}" has no next step and is not marked end of flow.`, n.id));
            }
        }
    }

    return { errors, warnings };
};

module.exports = { validateGraph };
