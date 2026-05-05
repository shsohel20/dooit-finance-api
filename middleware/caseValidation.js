const ErrorResponse = require('../utils/errorResponse');

const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_TYPES      = ['SAR', 'PEP', 'transaction_monitoring', 'other'];
const VALID_CASE_TYPES = ['Fraud', 'AML', 'Compliance', 'TF'];
const VALID_STATUSES   = ['open', 'under_investigation', 'pending_review', 'closed', 'escalated'];
const VALID_DECISIONS  = ['true_positive', 'false_positive', 'sar_filed', 'no_action'];

const isObjectIdLike = (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);

exports.validateCreateCase = (req, res, next) => {
  const { title, type, caseType, priority, assignedTo, alertIds, linkedCustomers, linkedTransactions } = req.body;
  const errors = [];

  if (!title || !String(title).trim())                  errors.push('title is required');
  if (String(title || '').trim().length > 200)          errors.push('title cannot exceed 200 characters');
  if (type && !VALID_TYPES.includes(type))              errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  if (caseType && !VALID_CASE_TYPES.includes(caseType)) errors.push(`caseType must be one of: ${VALID_CASE_TYPES.join(', ')}`);
  if (priority && !VALID_PRIORITIES.includes(priority)) errors.push(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);

  if (assignedTo !== undefined && !isObjectIdLike(String(assignedTo)))
    errors.push('assignedTo must be a valid user ID');

  if (alertIds !== undefined) {
    if (!Array.isArray(alertIds))                               errors.push('alertIds must be an array');
    else if (alertIds.some((id) => !isObjectIdLike(id)))        errors.push('alertIds must contain valid IDs');
  }
  if (linkedCustomers !== undefined) {
    if (!Array.isArray(linkedCustomers))                        errors.push('linkedCustomers must be an array');
    else if (linkedCustomers.some((id) => !isObjectIdLike(id))) errors.push('linkedCustomers must contain valid IDs');
  }
  if (linkedTransactions !== undefined) {
    if (!Array.isArray(linkedTransactions))                           errors.push('linkedTransactions must be an array');
    else if (linkedTransactions.some((id) => !isObjectIdLike(id)))    errors.push('linkedTransactions must contain valid IDs');
  }

  if (errors.length) return next(new ErrorResponse(errors.join('; '), 400));
  next();
};

exports.validateUpdateCase = (req, res, next) => {
  const { priority, type, caseType, closureReason, decision, tags } = req.body;
  const errors = [];

  if (priority && !VALID_PRIORITIES.includes(priority))
    errors.push(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
  if (type && !VALID_TYPES.includes(type))
    errors.push(`type must be one of: ${VALID_TYPES.join(', ')}`);
  if (caseType && !VALID_CASE_TYPES.includes(caseType))
    errors.push(`caseType must be one of: ${VALID_CASE_TYPES.join(', ')}`);
  if (decision && !VALID_DECISIONS.includes(decision))
    errors.push(`decision must be one of: ${VALID_DECISIONS.join(', ')}`);
  if (closureReason !== undefined && typeof closureReason !== 'string')
    errors.push('closureReason must be a string');
  if (tags !== undefined && !Array.isArray(tags))
    errors.push('tags must be an array of strings');

  if (errors.length) return next(new ErrorResponse(errors.join('; '), 400));
  next();
};

exports.validateStatusUpdate = (req, res, next) => {
  const { status, closureReason } = req.body;

  if (!status) return next(new ErrorResponse('status is required', 400));
  if (!VALID_STATUSES.includes(status))
    return next(new ErrorResponse(`status must be one of: ${VALID_STATUSES.join(', ')}`, 400));
  if (closureReason !== undefined && typeof closureReason !== 'string')
    return next(new ErrorResponse('closureReason must be a string', 400));
  next();
};

exports.validateAddNote = (req, res, next) => {
  const { content, attachments } = req.body;

  if (!content || !String(content).trim())
    return next(new ErrorResponse('Note content is required', 400));
  if (attachments !== undefined && !Array.isArray(attachments))
    return next(new ErrorResponse('attachments must be an array of URLs', 400));
  next();
};

exports.validateAssignment = (req, res, next) => {
  const { investigatorId } = req.body;

  // investigatorId can be null/undefined to unassign
  if (investigatorId !== undefined && investigatorId !== null && !isObjectIdLike(String(investigatorId)))
    return next(new ErrorResponse('investigatorId must be a valid user ID', 400));
  next();
};

exports.validateLinkAlerts = (req, res, next) => {
  const { alertIds } = req.body;

  if (!alertIds)                return next(new ErrorResponse('alertIds is required', 400));
  if (!Array.isArray(alertIds)) return next(new ErrorResponse('alertIds must be an array', 400));
  if (alertIds.length === 0)    return next(new ErrorResponse('alertIds must not be empty', 400));
  if (alertIds.some((id) => !isObjectIdLike(id)))
    return next(new ErrorResponse('alertIds must contain valid IDs', 400));
  next();
};


