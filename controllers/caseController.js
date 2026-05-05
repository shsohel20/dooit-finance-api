const asyncHandler = require('../middleware/async');
const ErrorResponse = require('../utils/errorResponse');
const Case = require('../models/Case');
const CaseNote = require('../models/CaseNote');
const AuditLog = require('../models/AuditLog');
const Alert = require('../models/Alert');
const User = require('../models/User');

// ── Status machine ────────────────────────────────────────────────────────────
const STATUS_TRANSITIONS = {
  open: ['under_investigation'],
  under_investigation: ['pending_review'],
  pending_review: ['closed', 'escalated'],
  closed: [],
  escalated: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const getTenant = (req) => ({
  client: req?.user?.client?._id || req?.user?.clientBelongs || null,
  branch: req?.user?.branch?._id || req?.user?.branchBelongs || null,
});

const logAudit = (caseId, userId, action, details, tenant) =>
  AuditLog.create({ case: caseId, user: userId, action, details, ...tenant });

// Returns an ErrorResponse if access is denied, null if allowed.
const checkCaseAccess = (caseDoc, req, { requireAssignment = false } = {}) => {
  const tenant = getTenant(req);
  if (tenant.client && caseDoc.client && caseDoc.client.toString() !== tenant.client.toString()) {
    return new ErrorResponse('Case not in your tenant', 403);
  }
  if (req.user.role === 'investigator') {
    const assignedId = caseDoc.assignedTo?._id || caseDoc.assignedTo;
    const isAssigned = assignedId && assignedId.toString() === req.user._id.toString();
    if (!isAssigned) {
      return new ErrorResponse(
        requireAssignment ? 'You must be assigned to this case' : 'Case not assigned to you',
        403
      );
    }
  }
  return null;
};

// Maps Alert.riskLabel → Case.priority
const mapRiskToPriority = (riskLabel) => {
  const r = (riskLabel || '').toLowerCase();
  if (r === 'critical') return 'critical';
  if (r === 'high') return 'high';
  if (r === 'medium') return 'medium';
  if (r === 'low') return 'low';
  return 'medium';
};

// Maps Alert.caseType → Case.type enum
const mapAlertTypeToCase = (caseType) => {
  const t = (caseType || '').toLowerCase().replace(/\s+/g, '_');
  if (t === 'sar') return 'SAR';
  if (t === 'pep') return 'PEP';
  if (t === 'transaction_monitoring') return 'transaction_monitoring';
  return 'other';
};

// Only pass alert.caseType to Case if it matches Case.caseType enum
const VALID_CASE_TYPES = ['Fraud', 'AML', 'Compliance', 'TF'];
const sanitizeCaseType = (val) => (VALID_CASE_TYPES.includes(val) ? val : null);

const populateCase = (query) =>
  query
    .populate('createdBy', 'name email avatar')
    .populate('assignedTo', 'name email avatar')
    .populate('watchers', 'name email avatar')
    .populate('linkedAlerts', 'uid caseType riskScore riskLabel status createdAt')
    .populate('linkedCustomers', 'name email')
    .populate('linkedTransactions', 'uid amount type');

// ── GET /cases ────────────────────────────────────────────────────────────────
exports.getCases = asyncHandler(async (req, res, next) => {
  const tenant = getTenant(req);

  const {
    status,
    priority,
    type,
    caseType,
    assignedTo,
    decision,
    startDate,
    endDate,
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    page = 1,
    limit = 10,
  } = req.query;

  const filter = { isDeleted: { $ne: true }, ...tenant };
  Object.keys(filter).forEach((k) => filter[k] == null && delete filter[k]);
  filter.isDeleted = { $ne: true };

  if (req.user.role === 'investigator') {
    filter.assignedTo = req.user._id;
  } else if (assignedTo) {
    filter.assignedTo = assignedTo;
  }

  if (status)   filter.status = status;
  if (priority) filter.priority = priority;
  if (type)     filter.type = type;
  if (caseType) filter.caseType = caseType;
  if (decision) filter.decision = decision;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate)   filter.createdAt.$lte = new Date(endDate);
  }
  if (search) filter.$text = { $search: search };

  const allowedSortFields = ['createdAt', 'updatedAt', 'priority', 'status', 'title', 'riskScore'];
  const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
  const sortDir   = sortOrder === 'asc' ? 1 : -1;

  const pageNum  = Math.max(1, Number(page));
  const limitNum = Math.min(Math.max(1, Number(limit)), 100);
  const skip     = (pageNum - 1) * limitNum;

  const [cases, total] = await Promise.all([
    populateCase(
      Case.find(filter).sort({ [sortField]: sortDir }).skip(skip).limit(limitNum)
    ).lean(),
    Case.countDocuments(filter),
  ]);

  res.status(200).json({
    succeed: true,
    data: cases,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum),
    },
  });
});

// ── GET /cases/:id ────────────────────────────────────────────────────────────
exports.getCaseById = asyncHandler(async (req, res, next) => {
  const caseDoc = await populateCase(
    Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
  ).lean();

  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  res.status(200).json({ succeed: true, data: caseDoc });
});

// ── POST /cases ───────────────────────────────────────────────────────────────
exports.createCase = asyncHandler(async (req, res, next) => {
  const tenant = getTenant(req);
  const {
    title,
    description,
    priority,
    type,
    caseType,
    tags,
    alertIds,
    linkedCustomers,
    linkedTransactions,
    assignedTo,
  } = req.body;

  // ── Resolve alerts (tenant-scoped) ───────────────────────────────────────────
  let resolvedAlerts = [];
  if (alertIds && alertIds.length > 0) {
    const alertFilter = { _id: { $in: alertIds }, isDeleted: { $ne: true } };
    if (tenant.client) alertFilter.client = tenant.client;
    resolvedAlerts = await Alert.find(alertFilter).lean();

    if (resolvedAlerts.length !== alertIds.length) {
      return next(new ErrorResponse('One or more alertIds not found in your tenant', 404));
    }
    const alreadyLinked = resolvedAlerts.filter((a) => a.linkedCase);
    if (alreadyLinked.length > 0) {
      return next(
        new ErrorResponse(
          `Alert(s) [${alreadyLinked.map((a) => a.uid).join(', ')}] are already linked to a case`,
          400
        )
      );
    }
  }

  const firstAlert       = resolvedAlerts[0];
  const derivedPriority  = priority  || (firstAlert ? mapRiskToPriority(firstAlert.riskLabel) : 'medium');
  const derivedType      = type      || (firstAlert ? mapAlertTypeToCase(firstAlert.caseType) : 'other');
  const derivedCaseType  = caseType  || sanitizeCaseType(firstAlert?.caseType);

  // ── Derive linked entities from alerts ───────────────────────────────────────
  const alertCustomers    = resolvedAlerts.map((a) => a.customer).filter(Boolean);
  const alertTransactions = resolvedAlerts.map((a) => a.transaction).filter(Boolean);

  const mergedCustomers    = [...new Set([...(linkedCustomers || []), ...alertCustomers.map(String)])];
  const mergedTransactions = [...new Set([...(linkedTransactions || []), ...alertTransactions.map(String)])];

  // ── Validate assignedTo is an investigator ───────────────────────────────────
  if (assignedTo) {
    const analyst = await User.findOne({ _id: assignedTo, role: 'investigator' }).select('_id').lean();
    if (!analyst) {
      return next(new ErrorResponse('assignedTo must be a valid investigator', 400));
    }
  }

  // ── Aggregate risk score ─────────────────────────────────────────────────────
  const riskScores = resolvedAlerts.map((a) => a.riskScore).filter((s) => s != null);
  const riskScore  = riskScores.length > 0
    ? Math.round(riskScores.reduce((s, v) => s + v, 0) / riskScores.length)
    : null;

  const newCase = await Case.create({
    ...tenant,
    title,
    description,
    priority: derivedPriority,
    type: derivedType,
    caseType: derivedCaseType,
    tags: tags || [],
    linkedAlerts: alertIds || [],
    linkedCustomers: mergedCustomers,
    linkedTransactions: mergedTransactions,
    riskScore,
    assignedTo: assignedTo || null,
    createdBy: req.user._id,
  });

  // ── Mark linked alerts as escalated ─────────────────────────────────────────
  if (alertIds && alertIds.length > 0) {
    await Alert.updateMany(
      { _id: { $in: alertIds } },
      {
        $set: { status: 'escalated_to_case', linkedCase: newCase._id },
        $push: {
          activity: {
            type: 'activity',
            title: 'Escalated to case',
            message: `Linked to case "${title}" by ${req.user.name || req.user._id}`,
            createdBy: req.user._id,
          },
        },
      }
    );
  }

  // ── Audit ────────────────────────────────────────────────────────────────────
  const auditPromises = [
    logAudit(
      newCase._id, req.user._id, 'case_created',
      `Case "${title}" created with type "${derivedType}" and priority "${derivedPriority}"`,
      tenant
    ),
  ];
  if (alertIds && alertIds.length > 0) {
    auditPromises.push(
      logAudit(
        newCase._id, req.user._id, 'alert_linked',
        `${alertIds.length} alert(s) linked on creation: [${resolvedAlerts.map((a) => a.uid).join(', ')}]`,
        tenant
      )
    );
  }
  if (assignedTo) {
    auditPromises.push(
      logAudit(newCase._id, req.user._id, 'assignment', `Investigator assigned on creation: ${assignedTo}`, tenant)
    );
  }
  await Promise.all(auditPromises);

  const populated = await populateCase(Case.findById(newCase._id)).lean();
  res.status(201).json({ succeed: true, data: populated });
});

// ── PUT /cases/:id ────────────────────────────────────────────────────────────
exports.updateCase = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req, { requireAssignment: true });
  if (accessErr) return next(accessErr);

  const allowedFields = [
    'title', 'description', 'priority', 'type', 'caseType',
    'closureReason', 'tags', 'decision', 'decisionNotes', 'slaDeadline', 'metadata',
  ];
  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse('No valid fields provided for update', 400));
  }

  // Record decision timestamp when decision is set
  if (updates.decision && !caseDoc.decidedAt) {
    updates.decidedAt = new Date();
    updates.decidedBy = req.user._id;
  }

  const updated = await populateCase(
    Case.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
  ).lean();

  const tenant = getTenant(req);
  await logAudit(
    req.params.id, req.user._id, 'field_update',
    `Fields updated: ${Object.keys(updates).join(', ')}`,
    tenant
  );

  res.status(200).json({ succeed: true, data: updated });
});

// ── PATCH /cases/:id/status ───────────────────────────────────────────────────
exports.updateCaseStatus = asyncHandler(async (req, res, next) => {
  const { status, closureReason } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req, { requireAssignment: true });
  if (accessErr) return next(accessErr);

  if (req.user.role === 'investigator') {
    const investigatorAllowed = ['under_investigation', 'pending_review'];
    if (!investigatorAllowed.includes(status)) {
      return next(
        new ErrorResponse(`Investigators can only transition to: ${investigatorAllowed.join(', ')}`, 403)
      );
    }
  }

  const validTransitions = STATUS_TRANSITIONS[caseDoc.status] || [];
  if (!validTransitions.includes(status)) {
    return next(
      new ErrorResponse(
        `Invalid transition from "${caseDoc.status}" to "${status}". Allowed: [${validTransitions.join(', ') || 'none'}]`,
        400
      )
    );
  }

  const previousStatus = caseDoc.status;
  caseDoc.status = status;
  if (closureReason) caseDoc.closureReason = closureReason;
  await caseDoc.save();

  const tenant = getTenant(req);
  await logAudit(
    caseDoc._id, req.user._id, 'status_change',
    `Status: "${previousStatus}" → "${status}"${closureReason ? `. Reason: ${closureReason}` : ''}`,
    tenant
  );

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── PATCH /cases/:id/assign ───────────────────────────────────────────────────
// @desc   Assign or reassign the primary investigator
exports.assignInvestigators = asyncHandler(async (req, res, next) => {
  const { investigatorId } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  if (investigatorId) {
    const found = await User.findOne({ _id: investigatorId, role: 'investigator' }).select('_id').lean();
    if (!found) {
      return next(new ErrorResponse('investigatorId is not a valid investigator', 400));
    }
  }

  const previousAssignee = caseDoc.assignedTo?.toString() || 'none';
  caseDoc.assignedTo = investigatorId || null;
  await caseDoc.save();

  const tenant = getTenant(req);
  await logAudit(
    caseDoc._id, req.user._id, 'assignment',
    `Investigator updated. Previous: ${previousAssignee}, New: ${investigatorId || 'none'}`,
    tenant
  );

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── PATCH /cases/:id/watchers ─────────────────────────────────────────────────
// @desc   Set watchers list for a case
exports.updateWatchers = asyncHandler(async (req, res, next) => {
  const { watcherIds = [] } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  caseDoc.watchers = watcherIds;
  await caseDoc.save();

  const tenant = getTenant(req);
  await logAudit(
    caseDoc._id, req.user._id, 'watchers_updated',
    `Watchers set to [${watcherIds.join(', ') || 'none'}]`,
    tenant
  );

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── GET /cases/:id/alerts ─────────────────────────────────────────────────────
exports.getCaseAlerts = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({
    _id: req.params.id,
    isDeleted: { $ne: true },
  })
    .select('linkedAlerts client assignedTo')
    .lean();

  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const alerts = await Alert.find({
    _id: { $in: caseDoc.linkedAlerts },
    isDeleted: { $ne: true },
  })
    .populate('customer', 'name email')
    .populate('analyst', 'name email')
    .populate('transaction', 'uid amount type')
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ succeed: true, data: alerts, count: alerts.length });
});

// ── POST /cases/:id/alerts ────────────────────────────────────────────────────
exports.linkAlerts = asyncHandler(async (req, res, next) => {
  const { alertIds } = req.body;

  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const tenant = getTenant(req);
  const alertFilter = { _id: { $in: alertIds }, isDeleted: { $ne: true } };
  if (tenant.client) alertFilter.client = tenant.client;

  const alerts = await Alert.find(alertFilter).lean();
  if (alerts.length !== alertIds.length) {
    return next(new ErrorResponse('One or more alertIds not found in your tenant', 404));
  }

  const alreadyLinked = alerts.filter(
    (a) => a.linkedCase && a.linkedCase.toString() !== req.params.id
  );
  if (alreadyLinked.length > 0) {
    return next(
      new ErrorResponse(
        `Alert(s) [${alreadyLinked.map((a) => a.uid).join(', ')}] are already linked to a different case`,
        400
      )
    );
  }

  const existing = caseDoc.linkedAlerts.map(String);
  const newIds   = alertIds.filter((id) => !existing.includes(String(id)));

  if (newIds.length === 0) {
    return next(new ErrorResponse('All provided alerts are already linked to this case', 400));
  }

  caseDoc.linkedAlerts.push(...newIds);
  await caseDoc.save();

  await Alert.updateMany(
    { _id: { $in: newIds } },
    {
      $set: { status: 'escalated_to_case', linkedCase: caseDoc._id },
      $push: {
        activity: {
          type: 'activity',
          title: 'Linked to case',
          message: `Linked to case "${caseDoc.title}" by ${req.user.name || req.user._id}`,
          createdBy: req.user._id,
        },
      },
    }
  );

  const uids = alerts.filter((a) => newIds.includes(String(a._id))).map((a) => a.uid);
  await logAudit(
    caseDoc._id, req.user._id, 'alert_linked',
    `${newIds.length} alert(s) linked: [${uids.join(', ')}]`,
    tenant
  );

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── DELETE /cases/:id/alerts/:alertId ────────────────────────────────────────
exports.unlinkAlert = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const alertId = req.params.alertId;
  const idx = caseDoc.linkedAlerts.findIndex((id) => id.toString() === alertId);
  if (idx === -1) {
    return next(new ErrorResponse('Alert is not linked to this case', 404));
  }

  const alert = await Alert.findById(alertId).lean();
  caseDoc.linkedAlerts.splice(idx, 1);
  await caseDoc.save();

  await Alert.findByIdAndUpdate(alertId, {
    $set: { linkedCase: null, status: 'under_review' },
    $push: {
      activity: {
        type: 'activity',
        title: 'Unlinked from case',
        message: `Unlinked from case "${caseDoc.title}" by ${req.user.name || req.user._id}`,
        createdBy: req.user._id,
      },
    },
  });

  const tenant = getTenant(req);
  await logAudit(
    caseDoc._id, req.user._id, 'alert_unlinked',
    `Alert ${alert?.uid || alertId} unlinked from case`,
    tenant
  );

  const updated = await populateCase(Case.findById(req.params.id)).lean();
  res.status(200).json({ succeed: true, data: updated });
});

// ── DELETE /cases/:id ─────────────────────────────────────────────────────────
exports.deleteCase = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  caseDoc.isDeleted = true;
  caseDoc.deletedAt = new Date();
  await caseDoc.save();

  res.status(200).json({ succeed: true, data: req.params.id });
});

// ── POST /cases/:id/notes ─────────────────────────────────────────────────────
exports.addNote = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }

  const accessErr = checkCaseAccess(caseDoc, req, { requireAssignment: true });
  if (accessErr) return next(accessErr);

  const tenant = getTenant(req);
  const { content, attachments } = req.body;

  const note = await CaseNote.create({
    ...tenant,
    case: req.params.id,
    author: req.user._id,
    content: content.trim(),
    attachments: attachments || [],
  });

  const auditPromises = [
    logAudit(req.params.id, req.user._id, 'note_added', `Note added by ${req.user.name || req.user._id}`, tenant),
  ];
  if (attachments && attachments.length > 0) {
    auditPromises.push(
      logAudit(req.params.id, req.user._id, 'evidence_added', `${attachments.length} evidence URL(s) attached`, tenant)
    );
  }
  await Promise.all(auditPromises);

  const populated = await CaseNote.findById(note._id).populate('author', 'name email avatar').lean();
  res.status(201).json({ succeed: true, data: populated });
});

// ── GET /cases/:id/notes ──────────────────────────────────────────────────────
exports.getCaseNotes = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('client assignedTo')
    .lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const notes = await CaseNote.find({ case: req.params.id })
    .populate('author', 'name email avatar')
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ succeed: true, data: notes, count: notes.length });
});

// ── GET /cases/:id/audit ──────────────────────────────────────────────────────
exports.getAuditLog = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('client assignedTo')
    .lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const logs = await AuditLog.find({ case: req.params.id })
    .populate('user', 'name email avatar')
    .sort({ createdAt: -1 })
    .lean();

  res.status(200).json({ succeed: true, data: logs, count: logs.length });
});

// ── GET /cases/investigators ──────────────────────────────────────────────────
exports.getInvestigators = asyncHandler(async (req, res, next) => {
  const tenant = getTenant(req);
  const filter = { role: 'investigator', ...tenant };
  Object.keys(filter).forEach((k) => filter[k] == null && delete filter[k]);

  const investigators = await User.find(filter).select('name email avatar role').lean();
  res.status(200).json({ succeed: true, data: investigators, count: investigators.length });
});
