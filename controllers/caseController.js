const mongoose = require('mongoose');
const asyncHandler = require('../middleware/async');
const ErrorResponse = require('../utils/errorResponse');
const Case = require('../models/Case');
const CaseNote = require('../models/CaseNote');
const AuditLog = require('../models/AuditLog');
const Alert = require('../models/Alert');
const User = require('../models/User');
const Staff = require('../models/Staff');
const EcddReport = require('../models/EcddReport');
const SMR = require('../models/SmrReport');
const TTR = require('../models/TtrReport');
const IFTI = require('../models/IftiReport');
const GFS = require('../models/gfsReport');
const RFI = require('../models/Rfi');
const { linkTransactionsToCase } = require('../utils/transactionCaseLink');

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
    .populate('reviewer', 'name email avatar')
    .populate('watchers', 'name email avatar')
    // ruleId/ruleName/explanation drive the "Alert Type" and "Detection Rule"
    // stats on the case detail page.
    .populate(
      'linkedAlerts',
      'uid caseType riskScore riskLabel status createdAt ruleId ruleName explanation alertOrigin'
    )
    .populate({
      // kycStatus/isPep/sanction/country back the customer-profile screening
      // badges. Encrypted fields (name, phone) are deliberately excluded — a
      // lean() query bypasses decryptForRole and would return ciphertext.
      path: 'linkedCustomers',
      select: 'uid user personalKyc relations kycStatus isPep sanction country',
      populate: { path: 'user', select: 'name email photoUrl avatar' },
    })
    .populate(
      'linkedTransactions',
      'uid amount currency convertedAmountAUD type status timestamp sender receiver riskScore riskFlags channel'
    );

// Σ linked-transaction value in AUD (converted where available, else raw amount).
const sumNetActivity = (txns) =>
  (txns || []).reduce((s, t) => s + (t.convertedAmountAUD || t.amount || 0), 0);

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

  // ── Enrich rows for the case-list UI (net activity, counts, filing status) ──
  if (cases.length) {
    const caseIds = cases.map((c) => c._id);
    const [noteCounts, filedIds] = await Promise.all([
      CaseNote.aggregate([
        { $match: { case: { $in: caseIds } } },
        { $group: { _id: '$case', n: { $sum: 1 } } },
      ]),
      SMR.find({ caseId: { $in: caseIds }, status: 'approved' }).distinct('caseId'),
    ]);
    const noteMap  = new Map(noteCounts.map((n) => [String(n._id), n.n]));
    const filedSet = new Set(filedIds.map(String));
    cases.forEach((c) => {
      c.netActivity  = sumNetActivity(c.linkedTransactions);
      c.alertCount   = (c.linkedAlerts || []).length;
      c.commentCount = noteMap.get(String(c._id)) || 0;
      c.sarFiled     = c.decision === 'sar_filed' || filedSet.has(String(c._id));
    });
  }

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

  // Related cases: other cases sharing a customer with this one (tenant-scoped).
  let relatedCases = [];
  const custIds = (caseDoc.linkedCustomers || []).map((c) => (c && c._id) || c).filter(Boolean);
  if (custIds.length) {
    const related = await Case.find({
      _id: { $ne: caseDoc._id },
      isDeleted: { $ne: true },
      linkedCustomers: { $in: custIds },
      ...(caseDoc.client ? { client: caseDoc.client } : {}),
    })
      .select('uid caseType type status')
      .limit(10)
      .lean();
    relatedCases = related.map((c) => ({
      _id: c._id,
      caseId: c.uid,
      caseType: c.caseType || c.type || '—',
      status: c.status,
    }));
  }

  // Derived header stats (kept API-side so the UI never recomputes business rules).
  const netActivity = sumNetActivity(caseDoc.linkedTransactions);
  const sarFiled =
    caseDoc.decision === 'sar_filed' ||
    !!(await SMR.exists({ caseId: caseDoc._id, status: 'approved' }));

  // Regulatory filings (ECDD/SMR/TTR/IFTI/GFS/RFI) are served by
  // GET /cases/:id/reports — this endpoint stays the case document only.
  res.status(200).json({
    succeed: true,
    data: { ...caseDoc, relatedCases, netActivity, sarFiled },
  });
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

  // ── Sync Transaction ↔ Case (investigation.case + flagged) ──────────────────
  if (mergedTransactions.length > 0) {
    await linkTransactionsToCase(mergedTransactions, newCase);
  }

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
    'reviewer',
  ];
  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse('No valid fields provided for update', 400));
  }

  // Compliance guard: decision 'sar_filed' must be backed by an approved SMR on
  // this case (the filing decision is derived from a real SMR, not free-set).
  if (updates.decision === 'sar_filed') {
    const hasApprovedSmr = await SMR.exists({ caseId: caseDoc._id, status: 'approved' });
    if (!hasApprovedSmr) {
      return next(new ErrorResponse(
        "Cannot set decision 'sar_filed': no approved SMR is linked to this case.",
        400
      ));
    }
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
    const { client: clientId } = getTenant(req);
    const staffMatch = await Staff.findOne({
      user: investigatorId,
      ...(clientId ? { client: clientId } : {}),
    }).select('_id').lean();
    if (!staffMatch) {
      return next(new ErrorResponse('investigatorId is not a staff member of this client', 400));
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

// ── GET /cases/:id/reports ──────────────────────────────────────────────────────
// Unified reverse view: every compliance report + RFI attached to this case.
// ECDD/SMR hang off `caseId`; TTR/IFTI/GFS/RFI off `case`.
exports.getCaseReports = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
    .select('uid client assignedTo')
    .lean();

  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const id = caseDoc._id;
  const [ecdd, smr, ttr, ifti, gfs, rfi] = await Promise.all([
    EcddReport.find({ caseId: id })
      .select('uid status createdAt customerName fullName caseNumber customer alert riskAssessment')
      .sort({ createdAt: -1 }).lean(),
    SMR.find({ caseId: id })
      .select('uid status createdAt caseNumber customer alert metadata.austracReference')
      .sort({ createdAt: -1 }).lean(),
    TTR.find({ case: id })
      .select('uid status createdAt referenceNumber completionDate customer alert')
      .sort({ createdAt: -1 }).lean(),
    IFTI.find({ case: id })
      .select('uid status createdAt customer alert')
      .sort({ createdAt: -1 }).lean(),
    GFS.find({ case: id })
      .select('uid status createdAt customerName customerUID customer alert')
      .sort({ createdAt: -1 }).lean(),
    RFI.find({ case: id })
      .select('uid status createdAt primaryContactName responseDeadline customer alert')
      .sort({ createdAt: -1 }).lean(),
  ]);

  const counts = {
    ecdd: ecdd.length, smr: smr.length, ttr: ttr.length,
    ifti: ifti.length, gfs: gfs.length, rfi: rfi.length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // Derived: a SAR is "filed" iff an approved SMR exists on this case.
  const sarFiled = smr.some((s) => s.status === 'approved');

  res.status(200).json({
    succeed: true,
    data: { ecdd, smr, ttr, ifti, gfs, rfi },
    summary: { counts, total, sarFiled },
  });
});

// ── GET /cases/analytics ────────────────────────────────────────────────────────
// Tenant-scoped aggregates for the Case Manager dashboard (cards + charts).
exports.getCaseAnalytics = asyncHandler(async (req, res, next) => {
  const tenant = getTenant(req);
  const match = { isDeleted: { $ne: true } };
  if (tenant.client) {
    try { match.client = new mongoose.Types.ObjectId(String(tenant.client)); } catch (_) { /* ignore */ }
  }

  const now = new Date();
  const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const start8 = new Date(now.getFullYear(), now.getMonth() - 7, 1);

  // ms spent in review, only for closed cases (null otherwise → ignored by $avg)
  const closedReviewMs = {
    $cond: [
      { $and: [{ $eq: ['$status', 'closed'] }, { $ne: ['$closedAt', null] }] },
      { $subtract: ['$closedAt', '$createdAt'] },
      null,
    ],
  };

  const [agg = {}] = await Case.aggregate([
    { $match: match },
    {
      $facet: {
        summary: [
          { $group: {
              _id: null,
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
              open: { $sum: { $cond: [{ $ne: ['$status', 'closed'] }, 1, 0] } },
              avgReviewMs: { $avg: closedReviewMs },
          }},
        ],
        createdThisMonth: [{ $match: { createdAt: { $gte: startThisMonth } } }, { $count: 'n' }],
        createdLastMonth: [{ $match: { createdAt: { $gte: startLastMonth, $lt: startThisMonth } } }, { $count: 'n' }],
        closedThisMonth: [{ $match: { closedAt: { $gte: startThisMonth } } }, { $count: 'n' }],
        closedLastMonth: [{ $match: { closedAt: { $gte: startLastMonth, $lt: startThisMonth } } }, { $count: 'n' }],
        typeDistribution: [
          { $group: { _id: { $ifNull: ['$caseType', 'Other'] }, count: { $sum: 1 } } },
        ],
        openedTrend: [
          { $match: { createdAt: { $gte: start8 } } },
          { $group: {
              _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
              opened: { $sum: 1 },
              inReview: { $sum: { $cond: [{ $in: ['$status', ['under_investigation', 'pending_review']] }, 1, 0] } },
          }},
        ],
        closedTrend: [
          { $match: { closedAt: { $gte: start8 } } },
          { $group: { _id: { y: { $year: '$closedAt' }, m: { $month: '$closedAt' } }, closed: { $sum: 1 } } },
        ],
        analystPerformance: [
          { $match: { assignedTo: { $ne: null } } },
          { $group: {
              _id: '$assignedTo',
              assigned: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
              avgReviewMs: { $avg: closedReviewMs },
          }},
          { $sort: { assigned: -1 } },
          { $limit: 6 },
        ],
      },
    },
  ]);

  const first = (arr) => (Array.isArray(arr) && arr[0]) || {};
  const cnt = (arr) => (Array.isArray(arr) && arr[0] && arr[0].n) || 0;
  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : 0);
  const msToDays = (ms) => (ms ? Math.round((ms / 86400000) * 10) / 10 : 0);

  const s = first(agg.summary);
  const cThis = cnt(agg.createdThisMonth);
  const cLast = cnt(agg.createdLastMonth);
  const clThis = cnt(agg.closedThisMonth);
  const clLast = cnt(agg.closedLastMonth);

  const summary = {
    totalReviews: s.total || 0,
    completedReviews: s.completed || 0,
    openReviews: s.open || 0,
    avgReviewTimeDays: msToDays(s.avgReviewMs),
    totalReviewsChange: pct(cThis, cLast),
    completedReviewsChange: pct(clThis, clLast),
    openReviewsChange: pct(cThis - clThis, cLast - clLast),
    avgReviewTimeChange: 0,
  };

  const TYPE_COLORS = { Fraud: '#f97316', AML: '#ef4444', Compliance: '#6366f1', TF: '#eab308', Other: '#94a3b8' };
  const typeTotal = (agg.typeDistribution || []).reduce((a, t) => a + t.count, 0) || 1;
  const typeDistribution = (agg.typeDistribution || []).map((t) => ({
    name: t._id || 'Other',
    count: t.count,
    value: Math.round((t.count / typeTotal) * 100),
    color: TYPE_COLORS[t._id] || TYPE_COLORS.Other,
  }));

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const openedMap = new Map((agg.openedTrend || []).map((d) => [`${d._id.y}-${d._id.m}`, d]));
  const closedMap = new Map((agg.closedTrend || []).map((d) => [`${d._id.y}-${d._id.m}`, d.closed]));
  const trend = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    const o = openedMap.get(key) || {};
    trend.push({
      month: MONTHS[d.getMonth()],
      opened: o.opened || 0,
      closed: closedMap.get(key) || 0,
      inReview: o.inReview || 0,
    });
  }

  const perfRows = agg.analystPerformance || [];
  const ids = perfRows.map((r) => r._id).filter(Boolean);
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name').lean() : [];
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));
  const analystPerformance = perfRows.map((r) => ({
    name: nameById.get(String(r._id)) || 'Unknown',
    assigned: r.assigned,
    completed: r.completed,
    avgDays: msToDays(r.avgReviewMs),
  }));

  res.status(200).json({
    succeed: true,
    data: { summary, typeDistribution, trend, analystPerformance },
  });
});

// ── POST /cases/:id/sar ──────────────────────────────────────────────────────────
// Record a SAR/SMR filing decision on the case (the deliberate compliance action).
// Sets decision='sar_filed'; the derived `sarFiled` flag also lights up when an
// approved SMR exists on the case (see getCaseById / getCases).
exports.fileSAR = asyncHandler(async (req, res, next) => {
  const caseDoc = await Case.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${req.params.id}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req, { requireAssignment: true });
  if (accessErr) return next(accessErr);

  caseDoc.decision   = 'sar_filed';
  caseDoc.decidedAt  = caseDoc.decidedAt || new Date();
  caseDoc.decidedBy  = req.user._id;
  if (req.body.sarNotes) caseDoc.decisionNotes = req.body.sarNotes;
  await caseDoc.save();

  await logAudit(
    caseDoc._id, req.user._id, 'sar_filed',
    `SAR filing recorded${req.body.sarNotes ? `: ${req.body.sarNotes}` : ''}`,
    getTenant(req)
  );

  const updated = await populateCase(Case.findById(caseDoc._id)).lean();
  res.status(200).json({
    succeed: true,
    data: { ...updated, sarFiled: true, netActivity: sumNetActivity(updated.linkedTransactions) },
  });
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
// Returns staff members belonging to the current client tenant.
// Shape matches what the frontend expects: { _id, name, email, avatar }.
exports.getInvestigators = asyncHandler(async (req, res, next) => {
  const { client: clientId } = getTenant(req);

  const staffFilter = {};
  if (clientId) staffFilter.client = clientId;

  const staffList = await Staff.find(staffFilter)
    .populate('user', 'name email avatar photoUrl')
    .lean();

  const investigators = staffList
    .filter((s) => s.user) // exclude staff without a linked user account
    .map((s) => ({
      _id: s.user._id,
      name: `${s.personal?.firstName || ''} ${s.personal?.lastName || ''}`.trim() || s.user.name,
      email: s.contact?.workEmail || s.user.email,
      avatar: s.user.photoUrl || s.user.avatar || null,
      staffId: s._id,
      jobTitle: s.employment?.jobTitle || null,
    }));

  res.status(200).json({ succeed: true, data: investigators, count: investigators.length });
});
