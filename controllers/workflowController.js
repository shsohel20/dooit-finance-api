// controllers/workflowController.js
//
// A Workflow is a definition. Nothing here creates an execution.

const mongoose = require('mongoose');
const Workflow = require('../models/Workflow');
const WorkflowVersion = require('../models/WorkflowVersion');
const { validateGraph } = require('../services/workflowValidation');
const { buildScopeFilter } = require('../middleware/workflowResults');

const isDooit = (u) => u?.userType === 'dooit';
const tenantOf = (u) => ({
    client: u?.client?._id ?? u?.clientBelongs ?? null,
    branch: u?.branch?._id ?? u?.branchBelongs ?? null,
});

const fail = (res, code, message) => res.status(code).json({ success: false, message });

/**
 * Load one workflow the caller is allowed to see, or null.
 * Scope is applied in the query itself — a "found then check" shape leaks
 * existence through timing and through 403-vs-404 differences.
 */
const findScoped = async (req, extra = {}) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return null;
    return Workflow.findOne({
        _id: id,
        deletedAt: null,
        ...buildScopeFilter(req.user, undefined),
        ...extra,
    });
};

/**
 * Writable means owned by the caller's tenant — never a system template,
 * and never another branch's workflow. Mirrors ruleEngineController's
 * sameTenant/canWrite (api/controllers/ruleEngineController.js:177-213):
 *   - dooit may write only system workflows (client === null) — the client
 *     view is read-only for dooit (spec §5.3).
 *   - a client user with no resolvable client owns nothing, not even system
 *     templates — refuse the write rather than falling back to `{ client: null }`,
 *     which IS the system-template scope.
 *   - a branch-scoped user may write their own branch's workflows plus any
 *     client-wide (no-branch) workflow, never another branch's.
 */
const findWritable = async (req) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return null;

    if (isDooit(req.user)) {
        return Workflow.findOne({ _id: id, deletedAt: null, client: null });
    }

    const { client, branch } = tenantOf(req.user);
    if (!client) return null;

    const scope = branch
        ? { client, $or: [{ branch }, { branch: null }, { branch: { $exists: false } }] }
        : { client };

    return Workflow.findOne({ _id: id, deletedAt: null, ...scope });
};

/** Next WF-#### for this tenant. */
const nextWorkflowId = async (client) => {
    const last = await Workflow.findOne({ client: client ?? null })
        .sort({ createdAt: -1 })
        .select('workflowId')
        .lean();
    const n = last && /^WF-(\d+)$/.test(last.workflowId)
        ? parseInt(last.workflowId.slice(3), 10) + 1
        : 1;
    return `WF-${String(n).padStart(4, '0')}`;
};

// ── Read ─────────────────────────────────────────────────────────────────────

exports.getWorkflows = async (req, res) => res.status(200).json(res.workflowResults);

exports.getWorkflow = async (req, res) => {
    const doc = await findScoped(req);
    if (!doc) return fail(res, 404, 'Workflow not found');
    return res.status(200).json({
        success: true,
        data: doc,
        validation: validateGraph(doc),
    });
};

exports.getWorkflowVersions = async (req, res) => {
    const doc = await findScoped(req);
    if (!doc) return fail(res, 404, 'Workflow not found');
    const data = await WorkflowVersion.find({ workflow: doc._id })
        .sort({ version: -1 })
        .select('-snapshot')
        .populate('changedBy', 'name email')
        .lean();
    return res.status(200).json({ success: true, data });
};

exports.getWorkflowVersion = async (req, res) => {
    const doc = await findScoped(req);
    if (!doc) return fail(res, 404, 'Workflow not found');
    const v = await WorkflowVersion.findOne({
        workflow: doc._id,
        version: parseInt(req.params.version, 10),
    }).lean();
    if (!v) return fail(res, 404, 'Version not found');
    return res.status(200).json({ success: true, data: v });
};

// ── Write ────────────────────────────────────────────────────────────────────

exports.createWorkflow = async (req, res) => {
    try {
        const { client, branch } = tenantOf(req.user);
        const body = req.body || {};
        const doc = await Workflow.create({
            ...body,
            workflowId: body.workflowId || (await nextWorkflowId(client)),
            client: isDooit(req.user) ? (body.client ?? null) : (client ?? null),
            branch: isDooit(req.user) ? (body.branch ?? null) : (branch ?? null),
            // Status is never taken from the body — a workflow becomes active
            // only through publish + approve.
            status: 'draft',
            createdBy: req.user?._id ?? null,
            updatedBy: req.user?._id ?? null,
        });
        return res.status(201).json({ success: true, data: doc, validation: validateGraph(doc) });
    } catch (err) {
        return fail(res, 400, err.message);
    }
};

exports.updateWorkflow = async (req, res) => {
    const doc = await findWritable(req);
    if (!doc) return fail(res, 404, 'Workflow not found');

    // Lifecycle and tenancy are moved by their own endpoints, never by a save.
    const { status, client, branch, visibleToClients, version, publishedBy,
        approvedBy, workflowId, ...patch } = req.body || {};

    Object.assign(doc, patch, { updatedBy: req.user?._id ?? null });

    // Editing an approved graph must revoke the approval. An `active` or
    // `pending_approval` workflow whose nodes/edges/startNodeId just changed
    // no longer represents what was signed off — leaving approvedBy in place
    // would let the audit trail attest to a graph nobody reviewed (C5).
    let approvalRevoked = false;
    const versionedPathChanged = Workflow.VERSIONED_PATHS.some((p) => doc.isModified(p));
    if (versionedPathChanged && ['active', 'pending_approval'].includes(doc.status)) {
        doc.status = 'draft';
        doc.publishedBy = null;
        doc.approvedBy = null;
        doc.publishedAt = null;
        approvalRevoked = true;
    }

    try {
        await doc.save();
    } catch (err) {
        return fail(res, 400, err.message);
    }

    // Advisory only. A draft is legitimately half-built; refusing the save
    // would make the builder unusable.
    return res.status(200).json({
        success: true,
        data: doc,
        validation: validateGraph(doc),
        ...(approvalRevoked && {
            approvalRevoked: true,
            message: 'This workflow was approved. Editing its graph reset it to draft and cleared the approval — it must be published and approved again.',
        }),
    });
};

exports.deleteWorkflow = async (req, res) => {
    const doc = await findWritable(req);
    if (!doc) return fail(res, 404, 'Workflow not found');
    // Soft delete — history and any future run records must still resolve it.
    doc.deletedAt = new Date();
    doc.updatedBy = req.user?._id ?? null;
    await doc.save();
    return res.status(200).json({ success: true, message: 'Workflow deleted' });
};

// ── Metadata ─────────────────────────────────────────────────────────────────

const STEP_TYPE_META = [
    { key: 'level', label: 'Level step', hint: 'Document, selfie, AML' },
    { key: 'quest', label: 'Questionnaire', hint: 'Structured applicant data' },
    { key: 'cond', label: 'Condition', hint: 'Branch on data or labels' },
    { key: 'action', label: 'Action', hint: 'Tags and risk labels' },
    { key: 'review', label: 'Review step', hint: 'Approve or reject' },
    { key: 'deleg', label: 'Delegation', hint: 'Route to a team' },
    { key: 'hook', label: 'Webhook', hint: 'Notify an external system' },
    { key: 'wait', label: 'Wait', hint: 'Hold for a period' },
    { key: 'mon', label: 'Ongoing monitoring', hint: 'Continuous checks' },
    { key: 'report', label: 'Report', hint: 'SMR or threshold report' },
];

const OPERATORS = [
    { value: 'eq', label: 'is' },
    { value: 'ne', label: 'is not' },
    { value: 'gt', label: 'is more than' },
    { value: 'gte', label: 'is at least' },
    { value: 'lt', label: 'is less than' },
    { value: 'lte', label: 'is at most' },
    { value: 'in', label: 'is in' },
    { value: 'nin', label: 'is not in' },
    { value: 'between', label: 'is between' },
    { value: 'contains', label: 'contains' },
    { value: 'startsWith', label: 'starts with' },
    { value: 'endsWith', label: 'ends with' },
    { value: 'exists', label: 'is present' },
    { value: 'regex', label: 'matches' },
];

const VARIABLES = [
    { ns: 'applicant', fields: 'type, fullName, country, review.reviewAnswer, review.rejectLabels, riskLabels.aml, riskLabels.device, assessment.scores, tags' },
    { ns: 'poi / poa', fields: 'country, idDocType, dob.ageInYears, validUntil, nationality, address.country, fullMrz' },
    { ns: 'device', fields: 'ipCountry, ipStateCode' },
    { ns: 'deviceStats', fields: 'minutes5.deviceCount, days1.sameDeviceApplicantCount, days7.riskLabels' },
    { ns: 'checks', fields: 'ip.vpn, ip.tor, ip.riskLevel, personWatchlist.matchStatuses, company.info.status, email.blacklisted' },
    { ns: 'questionnaires', fields: 'questionnaire["kyc"]["employment"]["employmentType"]' },
    { ns: 'clientLists', fields: 'risky_countries, internal_denylist, approved_introducers' },
    { ns: 'transaction', fields: 'physicalCurrencyAmount, isInternationalTransfer, convertedAmountAUD, channel' },
    { ns: 'case', fields: 'groundsToSuspect, explanation, priority' },
    { ns: 'date / random', fields: 'timestamp, year, ageInYears, ageInDays, random 0.0 to 1.0' },
];

exports.getWorkflowCatalog = async (req, res) =>
    res.status(200).json({
        success: true,
        data: {
            stepTypes: STEP_TYPE_META,
            operators: OPERATORS,
            variables: VARIABLES,
            categories: Workflow.CATEGORIES,
            statuses: Workflow.STATUSES,
        },
    });

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Draft → pending_approval. The validation gate lives here, not on save:
 * a draft may be half-built, a published workflow may not.
 */
exports.publishWorkflow = async (req, res) => {
    const doc = await findWritable(req);
    if (!doc) return fail(res, 404, 'Workflow not found');
    if (!['draft', 'paused'].includes(doc.status)) {
        return res.status(409).json({
            success: false,
            message: `A workflow with status "${doc.status}" cannot be published.`,
        });
    }

    const validation = validateGraph(doc);
    if (validation.errors.length) {
        return res.status(422).json({
            success: false,
            message: 'Fix the errors before publishing.',
            validation,
        });
    }

    doc.status = 'pending_approval';
    doc.publishedBy = req.user?._id ?? null;
    doc.updatedBy = req.user?._id ?? null;
    await doc.save();

    return res.status(200).json({
        success: true,
        data: doc,
        validation,
        message: 'Sent for approval. A second approver must activate it.',
    });
};

/**
 * pending_approval → active, by someone other than the publisher.
 *
 * Maker-checker: activating a workflow that routes sanctions matches and SMR
 * decisions is exactly the consequential transition the control exists for.
 * Self-approval would make it decorative.
 */
exports.approveWorkflow = async (req, res) => {
    const doc = await findWritable(req);
    if (!doc) return fail(res, 404, 'Workflow not found');
    if (doc.status !== 'pending_approval') {
        return res.status(409).json({
            success: false,
            message: `Only a workflow awaiting approval can be approved; this one is "${doc.status}".`,
        });
    }

    const approver = req.user?._id ?? null;
    // Fail closed. An approval nobody can be named for is worthless to an
    // auditor, and a pending_approval doc with no publisher is inconsistent
    // state — refuse both rather than activating on a technicality.
    if (!approver) return fail(res, 403, 'An approver could not be identified.');
    if (!doc.publishedBy) return fail(res, 409, 'This workflow has no recorded publisher, so it cannot be approved.');
    if (String(approver) === String(doc.publishedBy)) {
        return fail(res, 403, 'A workflow must be approved by someone other than the person who published it.');
    }

    doc.status = 'active';
    doc.approvedBy = approver;
    doc.publishedAt = new Date();
    doc.updatedBy = approver;
    await doc.save();

    return res.status(200).json({ success: true, data: doc, message: 'Workflow activated' });
};

/**
 * → archived, with a recorded reason.
 *
 * An auditor will ask why a workflow stopped being used, and the answer is
 * only reliable if it was captured at the moment of the decision.
 */
exports.archiveWorkflow = async (req, res) => {
    const doc = await findWritable(req);
    if (!doc) return fail(res, 404, 'Workflow not found');
    // Without this, re-archiving silently overwrites archivedReason, losing
    // the trace of why it was first archived.
    if (doc.status === 'archived') {
        return res.status(409).json({ success: false, message: 'This workflow is already archived.' });
    }

    const reason = String(req.body?.reason || '').trim();
    if (!reason) return fail(res, 400, 'A reason is required to archive a workflow.');

    doc.status = 'archived';
    doc.archivedReason = reason;
    doc.updatedBy = req.user?._id ?? null;
    await doc.save();

    return res.status(200).json({ success: true, data: doc, message: 'Workflow archived' });
};

/** Copy any readable workflow into the caller's tenant as a fresh draft. */
exports.duplicateWorkflow = async (req, res) => {
    const src = await findScoped(req);
    if (!src) return fail(res, 404, 'Workflow not found');

    const { client, branch } = tenantOf(req.user);
    const owner = isDooit(req.user) ? null : (client ?? null);

    const copy = await Workflow.create({
        workflowId: await nextWorkflowId(owner),
        name: `${src.name} (copy)`,
        description: src.description,
        category: src.category,
        appliesTo: src.appliesTo,
        startNodeId: src.startNodeId,
        nodes: src.toObject().nodes,
        edges: src.toObject().edges,
        client: owner,
        branch: isDooit(req.user) ? null : (branch ?? null),
        // A copy starts unapproved. Carrying the original's approval across
        // would launder one workflow's sign-off onto a different graph.
        status: 'draft',
        visibleToClients: false,
        publishedBy: null,
        approvedBy: null,
        publishedAt: null,
        createdBy: req.user?._id ?? null,
        updatedBy: req.user?._id ?? null,
    });

    return res.status(201).json({ success: true, data: copy });
};

/** Show or hide a system template to client users. dooit only. */
exports.toggleWorkflowVisibility = async (req, res) => {
    if (!isDooit(req.user)) return fail(res, 403, 'Only dooit may change template visibility.');
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return fail(res, 404, 'Workflow not found');

    const doc = await Workflow.findOne({ _id: id, deletedAt: null });
    if (!doc) return fail(res, 404, 'Workflow not found');
    if (doc.client) return fail(res, 400, 'Visibility applies to system templates only.');

    doc.visibleToClients = !doc.visibleToClients;
    doc.updatedBy = req.user?._id ?? null;
    await doc.save();

    return res.status(200).json({ success: true, data: doc });
};
