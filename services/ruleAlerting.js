// services/ruleAlerting.js
//
// The rule engine's write side (doc 72 §5, phase E1). `ruleEvaluation.js` is
// pure — it answers "does this rule match this document?". This module does
// everything around that answer:
//
//   selectRules()        which active rules apply to a tenant + subject type
//   evaluateSubject()    run them against one Transaction / Customer
//   buildAlertDraft()    turn a fired rule into an Alert payload that honours
//                        the Alert schema contract (ruleRef/snapshot/dedup/SLA)
//   createAlertFromRule() persist it: dedup-aware, cooldown-aware, telemetry bump
//   processNotify()      the report-notify entry point — replaces the external
//                        AI `/risk/alert` call in notifyController
//
// Design rules:
//   - Rules are untrusted input; a rule that cannot be resolved is skipped and
//     counted, never thrown.
//   - One alert per fired rule. Duplicate-key on `deduplicationKey` means
//     "already alerted" and is reported as such, not as an error.
//   - Every side effect is best-effort *except* Alert.create — telemetry and
//     evaluation-state writes never fail the run.

const mongoose = require("mongoose");
const RuleEngine = require("../models/RuleEngine");
const Alert = require("../models/Alert");
const Notify = require("../models/Notify");
const Transaction = require("../models/Transaction");
const Customer = require("../models/Customer");
const ruleEvaluation = require("./ruleEvaluation");
const { priorityForRiskLabel, slaDeadlineFor } = require("../models/schemas/riskShared");
const { resolveTenant } = require("../utils/resolveTenant");

// Engines the per-document path can run. 'aggregate' needs a window query
// (E3) and 'manual' is for analysts — both are skipped here by design.
const RUNNABLE_ENGINES = ["predicate", "screening"];

// ── 1. Rule selection ────────────────────────────────────────────────────────

/**
 * Active rules for a tenant and subject. System rules (client:null) apply to
 * every tenant — visibility is a display concern (doc 72 §8 Q1). Branch rules
 * apply only when the branch matches.
 */
async function selectRules({ client = null, branch = null, appliesTo }) {
    const tenantClauses = [{ client: null }];
    if (client) {
        tenantClauses.push({ client, branch: null });
        tenantClauses.push({ client, branch: { $exists: false } });
        if (branch) tenantClauses.push({ client, branch });
    }
    const rules = await RuleEngine.find({
        deletedAt: null,
        status: "active",
        appliesTo,
        engine: { $in: RUNNABLE_ENGINES },
        $or: tenantClauses,
    });
    // effectiveFrom / effectiveTo live on the isInEffect virtual
    return rules.filter((r) => r.isInEffect);
}

// ── 2. Evaluation ────────────────────────────────────────────────────────────

/**
 * Evaluate `rules` against one subject document.
 * Returns { fired: [{rule, result}], evaluated, skipped: [{ruleId, reason}] }.
 */
function evaluateSubject(subjectDoc, subjectType, rules) {
    const fired = [];
    const skipped = [];
    let evaluated = 0;
    const plain = typeof subjectDoc.toObject === "function" ? subjectDoc.toObject({ virtuals: true }) : subjectDoc;

    for (const rule of rules) {
        const executable = ruleEvaluation.resolveExecutable(rule);
        if (!executable) {
            skipped.push({ ruleId: rule.ruleId, reason: "not evaluable" });
            continue;
        }
        evaluated++;
        const result = ruleEvaluation.evaluateTree(executable.tree, plain, { subject: subjectType });
        if (result.matched) fired.push({ rule, result, source: executable.source });
    }
    return { fired, evaluated, skipped };
}

// ── 3. Alert draft ───────────────────────────────────────────────────────────

const dayBucket = (d = new Date()) => d.toISOString().slice(0, 10);

/** Subject customer for an alert: the customer itself, or the txn's first party customer. */
function subjectCustomerId(subjectDoc, subjectType) {
    if (subjectType === "customer") return subjectDoc._id;
    for (const p of ["sender", "receiver", "beneficiary", "intermediary"]) {
        const c = subjectDoc?.[p]?.customer;
        if (c) return c._id ?? c;
    }
    return null;
}

/** Deterministic dedup key per rule.dedupeBy (doc 72 K14: rule + customer + txn|day). */
function dedupKeyFor(rule, { customerId, transactionId }) {
    const subject = customerId ? String(customerId) : "anon";
    if (rule.dedupeBy === "rule_customer_day" || !transactionId) {
        return `${rule.ruleId}:${subject}:${dayBucket()}`;
    }
    return `${rule.ruleId}:${subject}:${String(transactionId)}`;
}

/** The `assign` action's analyst, if the rule carries one (params.analyst | params.userId). */
function assignedAnalyst(rule) {
    const assign = (rule.actions || []).find((a) => a.type === "assign");
    const id = assign && assign.params && (assign.params.analyst || assign.params.userId);
    return id && mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}

/**
 * One fired rule → one Alert payload. Pure; no I/O.
 *
 * Sets EVERY Alert field explicitly except the ones the model owns (`uid`,
 * `sequence`, `createdAt`, `updatedAt`) — see the "covers every Alert field"
 * test, which fails if a new schema path is added without a decision here.
 */
function buildAlertDraft({ rule, result, source }, subjectDoc, subjectType, ctx = {}) {
    const now = new Date();
    const customerId = subjectCustomerId(subjectDoc, subjectType);
    const transactionId = subjectType === "transaction" ? subjectDoc._id : null;
    const matched = result.matchedLeaves.map((l) => `${l.field} ${l.operator} ${l.expected}`);
    const actionTypes = (rule.actions || []).map((a) => a.type);
    const explanation = `${rule.ruleName}: ${rule.descriptiveExplanation || rule.ruleCondition} — matched ${matched.join("; ") || "(no leaves)"}`;

    return {
        // ── Tenant / parties ──
        // Resolved by evaluateAndAlert from the user, the transaction or the
        // customer's relations — never from the rule, which may be a system
        // rule belonging to no one.
        client: ctx.client ?? null,
        branch: ctx.branch ?? null,
        customer: customerId,
        transaction: transactionId,
        // Explicit analyst on the request wins, else the rule's `assign` action
        analyst: ctx.analyst ?? assignedAnalyst(rule),
        createdBy: ctx.createdBy ?? null,
        notify: ctx.notifyId ?? null,

        // ── Rule snapshot — survives later edits/deletes of the rule ──
        ruleRef: rule._id,
        ruleId: rule.ruleId,
        ruleName: rule.ruleName,
        ruleVersion: rule.version,
        ruleMeta: {
            engine: rule.engine,
            appliesTo: subjectType,
            source,                                   // logic | conditions | dsl
            matched: result.matchedLeaves,
            missed: result.missedLeaves,
            fieldMisses: result.fieldMisses,
            logic: rule.logic ?? null,
            conditions: rule.conditions ?? null,
            dsl: rule.ruleCondition,
            description: rule.descriptiveExplanation || null,
            mainDomain: rule.mainDomain || null,
            ruleDomainSubdomain: rule.ruleDomainSubdomain || null,
            category: rule.category || null,
            riskScore: rule.riskScore,
            riskLabel: rule.riskLabel,
            caseType: rule.caseType,
            dedupeBy: rule.dedupeBy || "rule_customer_txn",
            cooldownMinutes: rule.cooldownMinutes || 0,
            slaHours: rule.slaHours ?? null,
            // Where this alert's client/branch came from — the logged-in user,
            // the transaction, or the customer's relations. `ambiguous` means
            // the customer is held by several reporting entities and nothing
            // said which one this alert is for (docs/74 C15).
            tenant: {
                source: ctx.tenantSource || "none",
                ambiguous: !!ctx.tenantAmbiguous,
            },
            actions: actionTypes,
            // actions other than create_alert/assign are recorded, not executed (E4)
            pendingActions: actionTypes.filter((t) => t !== "create_alert" && t !== "assign"),
            evaluatedAt: now,
        },
        explanation,

        // ── Classification / risk ──
        caseType: rule.caseType,
        riskScore: rule.riskScore,
        riskLabel: rule.riskLabel,
        priority: priorityForRiskLabel(rule.riskLabel),
        alertOrigin: "Rule Based",

        // ── Lifecycle ──
        status: "new",
        statusReason: null,
        closedAt: null,
        linkedCase: null,

        // ── SLA ──
        slaDeadline: slaDeadlineFor(rule.riskLabel, rule.slaHours, now),
        slaStatus: "on_time",

        // ── Dedup ──
        deduplicationKey: dedupKeyFor(rule, { customerId, transactionId }),

        // ── Timeline / audit — only what actually happened ──
        // A system event, not an analyst note: createdBy stays null ("System").
        // The human who filed the notify is on Alert.createdBy / auditLogs.
        activity: [
            {
                type: "activity",
                title: `Rule ${rule.ruleId} fired`,
                message: explanation,
                createdBy: null,
                createdAt: now,
            },
        ],
        auditLogs: [
            {
                action: "alert_created",
                performedBy: ctx.createdBy ?? null,
                timestamp: now,
                oldValue: null,
                newValue: { ruleId: rule.ruleId, ruleVersion: rule.version, riskLabel: rule.riskLabel, source },
                remark: ctx.notifyId ? "Created by the rule engine from a report-notify" : "Created by the rule engine",
            },
        ],

        // ── Meta / soft delete ──
        metadata: {
            source: "rule-engine",
            subjectType,
            subjectId: subjectDoc._id,
            subjectUid: subjectDoc.uid || null,
            notify: ctx.notifyId ?? null,
        },
        isDeleted: false,
        deletedAt: null,
    };
}

// ── 4. Persistence ───────────────────────────────────────────────────────────

/** Best-effort lastFiredAt / hitCount bump. Shared with alertController.createAlert. */
async function bumpRuleTelemetry(ruleRef) {
    if (!ruleRef) return;
    try {
        await RuleEngine.updateOne({ _id: ruleRef }, { $set: { lastFiredAt: new Date() }, $inc: { hitCount: 1 } });
    } catch (e) {
        console.error("[ruleAlerting] telemetry update failed:", e.message);
    }
}

/** True when the same rule already alerted this customer inside rule.cooldownMinutes. */
async function inCooldown(rule, customerId) {
    if (!rule.cooldownMinutes || !customerId) return false;
    const since = new Date(Date.now() - rule.cooldownMinutes * 60e3);
    return !!(await Alert.exists({ ruleRef: rule._id, customer: customerId, createdAt: { $gte: since } }));
}

/**
 * Persist one draft. Returns { alert, outcome } with outcome:
 * 'created' | 'deduplicated' | 'cooldown' | 'failed'.
 */
async function createAlertFromRule(draft, rule) {
    if (await inCooldown(rule, draft.customer)) return { alert: null, outcome: "cooldown" };
    try {
        const alert = await Alert.create(draft);
        await bumpRuleTelemetry(rule._id);
        return { alert, outcome: "created" };
    } catch (err) {
        // Alert guards deduplicationKey twice: a schema validator (ValidationError
        // on that path) and the sparse unique index (E11000). Either = already alerted.
        const dupByIndex = err && err.code === 11000;
        const dupByValidator = err && err.name === "ValidationError" && err.errors && err.errors.deduplicationKey;
        if (dupByIndex || dupByValidator) return { alert: null, outcome: "deduplicated" };
        console.error(`[ruleAlerting] alert create failed for ${rule.ruleId}:`, err.message);
        return { alert: null, outcome: "failed", error: err.message };
    }
}

/** Record what the engine did on the subject document (Transaction / Customer). */
async function writeEvaluationState(subjectDoc, subjectType, { evaluated, firedRuleIds, alertIds }) {
    const Model = subjectType === "customer" ? Customer : Transaction;
    try {
        await Model.updateOne(
            { _id: subjectDoc._id },
            {
                $set: { "evaluation.lastEvaluatedAt": new Date(), "evaluation.ruleCount": evaluated },
                $addToSet: {
                    "evaluation.firedRuleIds": { $each: firedRuleIds },
                    "evaluation.firedAlerts": { $each: alertIds },
                },
            }
        );
    } catch (e) {
        console.error("[ruleAlerting] evaluation state write failed:", e.message);
    }
}

// ── 5. Orchestration ─────────────────────────────────────────────────────────

/**
 * Evaluate one subject document and create alerts for every fired rule.
 * Returns { evaluated, skipped, fired: [ruleId], alerts: [Alert], outcomes }.
 */
async function evaluateAndAlert(subjectDoc, subjectType, ctx = {}) {
    // ── Whose alert is this? ─────────────────────────────────────────────
    // A human click carries a logged-in user; an automatic rule run carries
    // nobody, so the tenant has to come from the subject — the transaction that
    // was booked by a branch, or the customer's own relations[]. Without this
    // an automatically-fired alert (and the case it becomes) would have no
    // client at all, and neither would be visible to the entity it concerns
    // (docs/74 C15).
    //
    // Resolved BEFORE rule selection on purpose: which rules apply is itself a
    // tenant question, so a wrong tenant would evaluate the wrong catalogue.
    const tenant = resolveTenant({
        user: ctx.user,
        transaction: subjectType === "transaction" ? subjectDoc : null,
        customer: subjectType === "customer" ? subjectDoc : ctx.customerDoc,
        fallback: { client: ctx.client, branch: ctx.branch },
    });

    ctx = { ...ctx, client: tenant.client, branch: tenant.branch, tenantSource: tenant.source, tenantAmbiguous: tenant.ambiguous };

    const rules = await selectRules({ client: ctx.client, branch: ctx.branch, appliesTo: subjectType });
    const { fired, evaluated, skipped } = evaluateSubject(subjectDoc, subjectType, rules);

    const alerts = [];
    const outcomes = [];
    for (const hit of fired) {
        const draft = buildAlertDraft(hit, subjectDoc, subjectType, ctx);
        const { alert, outcome, error } = await createAlertFromRule(draft, hit.rule);
        outcomes.push({ ruleId: hit.rule.ruleId, outcome, error });
        if (alert) alerts.push(alert);
    }

    await writeEvaluationState(subjectDoc, subjectType, {
        evaluated,
        firedRuleIds: fired.map((h) => h.rule.ruleId),
        alertIds: alerts.map((a) => a._id),
    });

    // `tenant` travels back so the caller can record which entity the run was
    // for — processNotify stamps it on the Notify.
    return { ruleCount: rules.length, evaluated, skipped, fired: fired.map((h) => h.rule.ruleId), alerts, outcomes, tenant };
}

/** Resolve the Notify's resource to a subject document + type. */
async function loadNotifySubject(notify) {
    const type = String(notify.resourceType || notify.notifyFor || "").toLowerCase();
    if (!notify.resourceId) return { subjectDoc: null, subjectType: null };
    if (type === "transaction") {
        return { subjectDoc: await Transaction.findById(notify.resourceId), subjectType: "transaction" };
    }
    if (type === "customer") {
        return { subjectDoc: await Customer.findById(notify.resourceId), subjectType: "customer" };
    }
    return { subjectDoc: null, subjectType: null };
}

/**
 * Entry point for report-notify. Marks the Notify processing → processed |
 * no_match | failed, links produced alerts, and stores the evaluation summary.
 * Never throws — the caller has already returned 201.
 */
async function processNotify(notify, ctx = {}) {
    const notifyId = notify._id;
    await Notify.updateOne({ _id: notifyId }, { $set: { status: "processing" } });
    try {
        const { subjectDoc, subjectType } = await loadNotifySubject(notify);
        if (!subjectDoc) {
            await Notify.updateOne(
                { _id: notifyId },
                { $set: { status: "failed", processedAt: new Date(), error: `No ${notify.resourceType || "resource"} found for resourceId ${notify.resourceId || "(none)"}` } }
            );
            return { alerts: [], error: "subject not found" };
        }

        const summary = await evaluateAndAlert(subjectDoc, subjectType, {
            ...ctx,
            client: ctx.client ?? notify.client ?? null,
            branch: ctx.branch ?? notify.branch ?? null,
            notifyId,
        });

        await Notify.updateOne(
            { _id: notifyId },
            {
                $set: {
                    status: summary.alerts.length ? "processed" : "no_match",
                    processedAt: new Date(),
                    error: null,
                    // Record the tenant it was actually processed for. A report
                    // raised by an admin arrives with none; leaving it blank
                    // would make the request untraceable to the entity it
                    // concerns, even though its alerts carry one.
                    ...(summary.tenant?.client ? { client: summary.tenant.client } : {}),
                    ...(summary.tenant?.branch ? { branch: summary.tenant.branch } : {}),
                    evaluation: {
                        subjectType,
                        evaluatedRuleCount: summary.evaluated,
                        skippedRules: summary.skipped,
                        firedRules: summary.fired,
                        outcomes: summary.outcomes,
                    },
                },
                $addToSet: { alerts: { $each: summary.alerts.map((a) => a._id) } },
            }
        );
        return summary;
    } catch (err) {
        console.error("[ruleAlerting] processNotify failed:", err.message);
        await Notify.updateOne(
            { _id: notifyId },
            { $set: { status: "failed", processedAt: new Date(), error: String(err.message || err).slice(0, 500) } }
        ).catch(() => {});
        return { alerts: [], error: err.message };
    }
}

module.exports = {
    RUNNABLE_ENGINES,
    selectRules,
    evaluateSubject,
    buildAlertDraft,
    dedupKeyFor,
    createAlertFromRule,
    bumpRuleTelemetry,
    evaluateAndAlert,
    loadNotifySubject,
    processNotify,
};
