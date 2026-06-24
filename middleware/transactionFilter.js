'use strict';

/**
 * transactionFilter
 *
 * Purpose-built query middleware for the Transaction model.
 * Drop-in replacement for advancedResults() on the GET /transaction route.
 *
 * Accepted query params
 * ─────────────────────
 * Pagination : page, limit (max 100)
 * Sort       : sort (field name), order ("asc" | "desc")
 * Search     : search — regex across uid / reference / narrative / party names & accounts
 * Filters    : status, type, currency, channel,
 *              dateFrom, dateTo  (ISO strings, inclusive)
 *              amountMin, amountMax
 *              riskMin, riskMax  (0–100)
 *              flagged           ("true" | "false")
 *              relatedPartyFlag  ("true" | "false")
 *
 * Response shape (res.advancedResults)
 * ─────────────────────────────────────
 * {
 *   success     : true,
 *   data        : Transaction[],
 *   totalRecords: number,
 *   count       : number,          // length of this page
 *   pagination  : {
 *     page, limit, total, pages, hasNext, hasPrev,
 *     next?, prev?                 // legacy compat for existing UI
 *   },
 *   filters : { <echos back every active filter param> },
 *   sort    : { field, order }
 * }
 *
 * Reusability
 * ───────────
 * The function accepts any Mongoose Model so it can be applied to
 * other collections that share a similar schema shape.
 */

const ALLOWED_SORT_FIELDS = new Set([
  'timestamp', 'amount', 'convertedAmountAUD', 'currency',
  'status', 'type', 'riskScore', 'createdAt', 'reference',
]);

/**
 * Normalise a query param that may arrive as either:
 *   - a comma-separated string  →  "pending,completed"
 *   - an array of strings       →  ["pending", "completed"]  (repeated ?status=)
 * Returns a clean string array with empty values removed.
 */
const toArray = (param) => {
  if (!param) return [];
  const raw = Array.isArray(param) ? param.join(',') : String(param);
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

const FILTER_KEYS = [
  'search', 'status', 'type', 'currency', 'channel',
  'dateFrom', 'dateTo', 'amountMin', 'amountMax',
  'riskMin', 'riskMax', 'flagged', 'relatedPartyFlag',
];

// Escape special regex chars in user-supplied search strings
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const transactionFilter = (model) => async (req, res, next) => {
  // ── Tenant scope (always injected from the authenticated user) ─────────────
  const client = req?.user?.client?._id || req?.user?.clientBelongs || null;
  const branch = req?.user?.branch?._id || req?.user?.branchBelongs || null;

  try {
    // ── 1. Pagination ─────────────────────────────────────────────────────────
    const page  = Math.max(parseInt(req.query.page,  10) || 1,   1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const skip  = (page - 1) * limit;

    // ── 2. Sort ───────────────────────────────────────────────────────────────
    const sortField = ALLOWED_SORT_FIELDS.has(req.query.sort)
      ? req.query.sort
      : 'timestamp';
    const sortDir = req.query.order === 'asc' ? 1 : -1;

    // ── 3. Build filter document ──────────────────────────────────────────────
    const filter = {};

    if (client) filter.client = client;
    if (branch) filter.branch = branch;

    // Status — comma-separated OR repeated params: ?status=pending&status=completed
    const statusVals = toArray(req.query.status);
    if (statusVals.length === 1) filter.status = statusVals[0];
    else if (statusVals.length > 1) filter.status = { $in: statusVals };

    // Type — same dual-format support
    const typeVals = toArray(req.query.type);
    if (typeVals.length === 1) filter.type = typeVals[0];
    else if (typeVals.length > 1) filter.type = { $in: typeVals };

    // Currency (exact, normalised to uppercase)
    if (req.query.currency && req.query.currency.trim()) {
      filter.currency = req.query.currency.toUpperCase().trim();
    }

    // Channel (case-insensitive prefix match)
    if (req.query.channel && req.query.channel.trim()) {
      filter.channel = new RegExp(escapeRegex(req.query.channel.trim()), 'i');
    }

    // Date range on timestamp (inclusive both ends)
    if (req.query.dateFrom || req.query.dateTo) {
      filter.timestamp = {};
      if (req.query.dateFrom) {
        const start = new Date(req.query.dateFrom);
        if (!isNaN(start)) filter.timestamp.$gte = start;
      }
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        if (!isNaN(end)) {
          end.setHours(23, 59, 59, 999);
          filter.timestamp.$lte = end;
        }
      }
      if (!Object.keys(filter.timestamp).length) delete filter.timestamp;
    }

    // Amount range
    if (req.query.amountMin || req.query.amountMax) {
      filter.amount = {};
      if (req.query.amountMin) {
        console.log(`${req.query.amountMin}`.bgRed)
        const v = parseFloat(req.query.amountMin);
        if (!isNaN(v)) filter.amount.$gte = v;
      }
      if (req.query.amountMax) {
        const v = parseFloat(req.query.amountMax);
        if (!isNaN(v)) filter.amount.$lte = v;
      }
      if (!Object.keys(filter.amount).length) delete filter.amount;
    }

    // Risk score range (0–100)
    if (req.query.riskMin || req.query.riskMax) {
      filter.riskScore = {};
      if (req.query.riskMin) {
        const v = parseFloat(req.query.riskMin);
        if (!isNaN(v)) filter.riskScore.$gte = v;
      }
      if (req.query.riskMax) {
        const v = parseFloat(req.query.riskMax);
        if (!isNaN(v)) filter.riskScore.$lte = v;
      }
      if (!Object.keys(filter.riskScore).length) delete filter.riskScore;
    }

    // Boolean flags
    if (req.query.flagged === 'true' || req.query.flagged === 'false') {
      filter['investigation.flagged'] = req.query.flagged === 'true';
    }
    if (req.query.relatedPartyFlag === 'true' || req.query.relatedPartyFlag === 'false') {
      filter.relatedPartyFlag = req.query.relatedPartyFlag === 'true';
    }

    // Full-text search across key identifying fields
    if (req.query.search && req.query.search.trim()) {
      const regex = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [
        { uid:                regex },
        { reference:          regex },
        { narrative:          regex },
        { 'sender.name':      regex },
        { 'sender.account':   regex },
        { 'receiver.name':    regex },
        { 'receiver.account': regex },
        { 'beneficiary.name': regex },
      ];
    }

    // ── 4. Execute count + paginated query in parallel ─────────────────────────
    const [totalRecords, data] = await Promise.all([
      model.countDocuments(filter),
      model
        .find(filter)
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(limit),
    ]);

    // ── 5. Build pagination meta ───────────────────────────────────────────────
    const totalPages = Math.max(Math.ceil(totalRecords / limit), 1);
    const pagination = {
      page,
      limit,
      total:   totalRecords,
      pages:   totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
    // Legacy next/prev objects — existing UI components read these
    if (page < totalPages) pagination.next = { page: page + 1, limit };
    if (page > 1)          pagination.prev = { page: page - 1, limit };

    // ── 6. Echo active filters (strips empty / internal values) ───────────────
    const activeFilters = {};
    FILTER_KEYS.forEach((k) => {
      const raw = req.query[k];
      if (raw === undefined || raw === '') return;
      // Normalise array params back to comma-separated for consistent echoing
      activeFilters[k] = Array.isArray(raw) ? raw.join(',') : raw;
    });

    // ── 7. Attach to response ─────────────────────────────────────────────────
    res.advancedResults = {
      success:      true,
      data,
      totalRecords,
      count:        data.length,
      pagination,
      filters:      activeFilters,
      sort: {
        field: sortField,
        order: req.query.order === 'asc' ? 'asc' : 'desc',
      },
    };

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = transactionFilter;
