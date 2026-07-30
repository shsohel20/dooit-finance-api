// controllers/transactionController.js
const mongoose = require("mongoose");
const { Readable } = require("stream");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Transaction = require("../models/Transaction");
const Customer = require("../models/Customer");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const User = require("../models/User");
const { Parser: CsvParser } = require("json2csv");
const csv = require("csv-parser");
const puppeteer = require("puppeteer");

// ── shared helpers (mirrors transactionFilter.js) ──────────────────────────
const _toArray = (param) => {
  if (!param) return [];
  const raw = Array.isArray(param) ? param.join(",") : String(param);
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
};
const _escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const _ALLOWED_SORT = new Set([
  "timestamp", "amount", "convertedAmountAUD", "currency",
  "status", "type", "riskScore", "createdAt", "reference",
]);

function buildTxFilter(query, user) {
  const client = user?.client?._id || user?.clientBelongs || null;
  const branch = user?.branch?._id || user?.branchBelongs || null;
  const filter = {};
  if (client) filter.client = client;
  if (branch) filter.branch = branch;

  const statusVals = _toArray(query.status);
  if (statusVals.length === 1) filter.status = statusVals[0];
  else if (statusVals.length > 1) filter.status = { $in: statusVals };

  const typeVals = _toArray(query.type);
  if (typeVals.length === 1) filter.type = typeVals[0];
  else if (typeVals.length > 1) filter.type = { $in: typeVals };

  if (query.currency?.trim())
    filter.currency = query.currency.toUpperCase().trim();

  if (query.channel?.trim())
    filter.channel = new RegExp(_escapeRegex(query.channel.trim()), "i");

  if (query.dateFrom || query.dateTo) {
    filter.timestamp = {};
    if (query.dateFrom) {
      const d = new Date(query.dateFrom);
      if (!isNaN(d)) filter.timestamp.$gte = d;
    }
    if (query.dateTo) {
      const d = new Date(query.dateTo);
      if (!isNaN(d)) { d.setHours(23, 59, 59, 999); filter.timestamp.$lte = d; }
    }
    if (!Object.keys(filter.timestamp).length) delete filter.timestamp;
  }

  if (query.amountMin || query.amountMax) {
    filter.amount = {};
    if (query.amountMin) { const v = parseFloat(query.amountMin); if (!isNaN(v)) filter.amount.$gte = v; }
    if (query.amountMax) { const v = parseFloat(query.amountMax); if (!isNaN(v)) filter.amount.$lte = v; }
    if (!Object.keys(filter.amount).length) delete filter.amount;
  }

  if (query.riskMin || query.riskMax) {
    filter.riskScore = {};
    if (query.riskMin) { const v = parseFloat(query.riskMin); if (!isNaN(v)) filter.riskScore.$gte = v; }
    if (query.riskMax) { const v = parseFloat(query.riskMax); if (!isNaN(v)) filter.riskScore.$lte = v; }
    if (!Object.keys(filter.riskScore).length) delete filter.riskScore;
  }

  if (query.flagged === "true") filter["investigation.flagged"] = true;
  else if (query.flagged === "false") filter["investigation.flagged"] = { $ne: true };

  if (query.relatedPartyFlag === "true") filter.relatedPartyFlag = true;
  else if (query.relatedPartyFlag === "false") filter.relatedPartyFlag = false;

  if (query.search?.trim()) {
    const regex = new RegExp(_escapeRegex(query.search.trim()), "i");
    filter.$or = [
      { uid: regex }, { reference: regex }, { narrative: regex },
      { "sender.name": regex }, { "sender.account": regex },
      { "receiver.name": regex }, { "receiver.account": regex },
      { "beneficiary.name": regex },
    ];
  }

  return filter;
}

// Helper: validate ObjectId
function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// @desc Get single transaction
// @route GET /api/v1/transactions/:id
// @access Protected
exports.getTransaction = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Transactions']
  #swagger.summary = 'Get by Id'
  #swagger.security = [{ "BearerAuth": [] }]
 
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const loggedInUser = req.user;
  const tx = await Transaction.findById(req.params.id).populate(
    "client branch createdBy"
  );
  if (!tx)
    return next(
      new ErrorResponse(`Transaction not found ${req.params.id}`, 404)
    );
  res.status(200).json({ success: true, data: tx });
});

// // @desc List transactions (filter + pagination + simple text search)
// // @route GET /api/v1/transactions
// // @access Protected
// exports.getTransactions = asyncHandler(async (req, res, next) => {
//   /*
//   #swagger.tags = ['Transaction']
//   #swagger.summary = 'Get All Transaction'
//   #swagger.responses[200] = { description: 'Success' }
//   #swagger.responses[400] = { description: 'Bad Request' }
//   #swagger.responses[401] = { description: 'Unauthorized' }
// */
//   const {
//     page = 1,
//     limit = 25,
//     customer,
//     client,
//     branch,
//     status,
//     type,
//     currency,
//     date_from,
//     date_to,
//     min_amount,
//     max_amount,
//     search,
//     sort = "-timestamp",
//   } = req.query;

//   const q = {};

//   if (customer && isValidId(customer)) q.customer = customer;
//   if (client && isValidId(client)) q.client = client;
//   if (branch && isValidId(branch)) q.branch = branch;
//   if (status) q.status = status;
//   if (type) q.type = type;
//   if (currency) q.currency = currency.toUpperCase();
//   if (min_amount || max_amount) q.amount = {};
//   if (min_amount) q.amount.$gte = Number(min_amount);
//   if (max_amount) q.amount.$lte = Number(max_amount);
//   if (date_from || date_to) q.timestamp = {};
//   if (date_from) q.timestamp.$gte = new Date(date_from);
//   if (date_to) q.timestamp.$lte = new Date(date_to);

//   let mongoQuery = Transaction.find(q);

//   // Text search (reference or narrative)
//   if (search && String(search).trim().length) {
//     mongoQuery = Transaction.find({ $text: { $search: search }, ...q });
//   }

//   // Pagination
//   const pageNum = parseInt(page, 10);
//   const pageSize = Math.min(parseInt(limit, 10) || 25, 200);

//   const total = await Transaction.countDocuments(
//     search ? { $text: { $search: search }, ...q } : q
//   );
//   const skip = (pageNum - 1) * pageSize;

//   const results = await mongoQuery
//     .sort(sort)
//     .skip(skip)
//     .limit(pageSize)
//     .lean()
//     .exec();

//   res.status(200).json({
//     success: true,
//     count: results.length,
//     total,
//     page: pageNum,
//     pageSize,
//     data: results,
//   });
// });

// @desc   Get all Transactions
// @route  GET /api/v1/transaction
// @access Public
exports.getTransactions = asyncHandler(async (req, res, next) => {

  // console.log(req?.user?.client?._id || null)
  // console.log(req?.user?.branch?._id || null)
  /*
  #swagger.tags = ['Transactions']
  #swagger.summary = 'Get All Transactions'
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});

// @desc Create a transaction
// @route POST /api/v1/transactions
// @access Protected (transaction user)
exports.createTransaction = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Transactions']
  #swagger.summary = 'Create Transaction'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: {  } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const {
    transactionId,
    type = "transfer",
    subtype,
    amount,
    currency,
    reference,
    narrative,
    status = "pending",
    channel,
    sender,
    beneficiary,
    intermediary,
    purpose,
    remittancePurposeCode,
    crypto,
    receiver,
    bullion,
    metadata,
  } = req.body;

  // required fields
  if (!amount || !currency) {
    return next(new ErrorResponse("amount and currency are required", 400));
  }
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  // If provided, validate ids
  if (client && !isValidId(client))
    return next(new ErrorResponse("Invalid client id", 400));
  if (branch && !isValidId(branch))
    return next(new ErrorResponse("Invalid branch id", 400));

  if (client) {
    const cl = await Client.findById(client).select("_id");
    if (!cl) return next(new ErrorResponse("Client not found", 404));
  }

  // Build payload — customer reference lives inside sender.customer / receiver.customer
  const payload = {
    transactionId,
    client,
    branch,
    type,
    subtype,
    amount,
    currency,
    convertedAmountAUD: req.body.convertedAmountAUD,
    reference,
    narrative,
    status,
    channel,
    sender,
    receiver,
    beneficiary,
    intermediary,
    purpose,
    remittancePurposeCode,
    crypto,
    bullion,
    createdBy: req.user ? req.user._id : undefined,
    metadata,
  };

  // Create transaction
  const tx = await Transaction.create(payload);

  res.status(201).json({
    success: true,
    data: tx,
  });
});
// @desc Create Dummy a transaction
// @route POST /api/v1/transactions
// @access Protected (client/branch user)
exports.createDummyTransaction = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Transactions']
  #swagger.summary = 'Create Dummy Transaction'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: {  } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
  #swagger.security = [] // public
  */

  const {
    transactionId,
    customerName,
    clientName,
    branchName,
    type = "transfer",
    subtype,
    amount,
    currency,
    reference,
    narrative,
    status = "pending",
    channel,
    sender,
    beneficiary,
    intermediary,
    purpose,
    remittancePurposeCode,
    crypto,
    receiver,
    bullion,
    metadata,
  } = req.body;

  // required fields - validate early to avoid DB work
  if (!amount || !currency) {
    return next(new ErrorResponse("amount and currency are required", 400));
  }

  // helper: find a doc by id or name (returns doc with _id or null)
  const findByIdOrName = async (Model, value) => {
    if (!value) return null;
    if (isValidId(value)) return Model.findById(value).select("_id").lean();
    return Model.findOne({ name: value }).select("_id").lean();
  };

  // Validate presence of sender/receiver based on type early
  if (type === "transfer" && !sender) {
    return next(
      new ErrorResponse("Sender is required for transfer transactions", 400)
    );
  }
  if (type === "deposit" && !receiver) {
    return next(
      new ErrorResponse("Receiver is required for deposit transactions", 400)
    );
  }

  // 1) Fetch user by customerName, client and branch in parallel
  const userPromise = User.findOne({ name: customerName }).select("_id").lean();
  const clientPromise = findByIdOrName(Client, clientName);
  const branchPromise = findByIdOrName(Branch, branchName);

  const [userDoc, clientDoc, branchDoc] = await Promise.all([
    userPromise,
    clientPromise,
    branchPromise,
  ]);

  if (!userDoc) {
    return next(new ErrorResponse("This customer not found by this name", 400));
  }

  // Find Customer by user id (the "primary" customer referenced by customerName)
  const customerDoc = await Customer.findOne({ user: userDoc._id })
    .select("_id")
    .lean();
  if (!customerDoc) {
    return next(new ErrorResponse("This customer not found by this name", 400));
  }

  // client and branch are optional but if provided we already attempted to fetch them.
  let client = null;
  if (clientName) {
    if (!clientDoc) return next(new ErrorResponse("Client not found", 404));
    client = clientDoc._id;
  }

  let branch = null;
  if (branchName) {
    if (!branchDoc) return next(new ErrorResponse("Branch not found", 404));
    branch = branchDoc._id;
  }

  // Additional validation:
  if (type === "transfer" && customerName !== sender?.name) {
    return next(
      new ErrorResponse(
        "The Customer Name and Sender should be same, because transaction type is transfer",
        400
      )
    );
  }
  if (type === "deposit" && customerName !== receiver?.name) {
    return next(
      new ErrorResponse(
        "The Customer Name and Receiver should be same, because transaction type is deposit",
        400
      )
    );
  }

  // Find receiver user & customer only if receiver provided (do it now)
  let userReceiverDoc = null;
  let customerReceiverDoc = null;
  if (receiver?.name) {
    userReceiverDoc = await User.findOne({ name: receiver.name })
      .select("_id")
      .lean();
    if (userReceiverDoc) {
      customerReceiverDoc = await Customer.findOne({
        user: userReceiverDoc._id,
      })
        .select("_id")
        .lean();
    }
  }

  // Build senderWithId (attach the found customer id for the primary customer)
  const senderWithId = sender
    ? {
      ...sender,
      id: customerDoc._id,
    }
    : undefined;

  // Build receiverWithId (if receiver exists and we found a customer)
  const receiverWithId = receiver
    ? {
      ...receiver,
      id: customerReceiverDoc ? customerReceiverDoc._id : undefined,
    }
    : undefined;

  // Determine which Customer._id should be set on transaction.customer based on type
  // - transfer => sender's customer (customerDoc)
  // - deposit  => receiver's customer (customerReceiverDoc) if found, else fallback to customerDoc
  let transactionCustomerId = null;
  if (type === "transfer") {
    transactionCustomerId = customerDoc._id;
  } else if (type === "deposit") {
    // if receiver's customer not found, return 400 because you validated customerName must equal receiver.name
    if (!customerReceiverDoc) {
      return next(
        new ErrorResponse(
          "Receiver customer not found for deposit transaction",
          404
        )
      );
    }
    transactionCustomerId = customerReceiverDoc._id;
  } else {
    // default fallback: set to primary customer
    transactionCustomerId = customerDoc._id;
  }

  // Build payload (keep same fields as original)
  const payload = {
    customer: transactionCustomerId,
    client: client || undefined,
    branch: branch || undefined,
    transactionId: transactionId || undefined,
    type,
    subtype,
    amount,
    currency,
    convertedAmountAUD: req.body.convertedAmountAUD,
    reference,
    narrative,
    status,
    channel,
    sender: senderWithId,
    receiver: receiverWithId,
    beneficiary,
    intermediary,
    purpose,
    remittancePurposeCode,
    crypto,
    bullion,
    createdBy: req.user ? req.user._id : undefined,
    metadata,
  };

  // Create transaction
  const tx = await Transaction.create(payload);

  res.status(201).json({
    success: true,
    data: tx,
  });
});

// @desc Update transaction status or partial update
// @route PUT /api/v1/transactions/:id
// @access Protected (admin/operator)
exports.updateTransaction = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Transactions']
  #swagger.summary = 'Update Transaction'
  #swagger.security = [{ "BearerAuth": [] }]
  #swagger.parameters['body'] = { in: 'body', required: true, schema: {  } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const allowed = [
    "status",
    "reference",
    "narrative",
    "convertedAmountAUD",
    "riskScore",
    "riskFlags",
    "forensic",
    "metadata",
    "investigation",
  ];

  const updates = {};
  allowed.forEach((k) => {
    if (typeof req.body[k] !== "undefined") updates[k] = req.body[k];
  });

  if (Object.keys(updates).length === 0)
    return next(new ErrorResponse("No updatable fields provided", 400));

  const tx = await Transaction.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });
  if (!tx) return next(new ErrorResponse("Transaction not found", 404));

  return res.status(200).json({ success: true, data: tx });
});

// @desc  Comprehensive dashboard stats for the transaction analytics toolbar
// @route GET /api/v1/transaction/stats?period=30d|6m|1y|all
// @access Protected
exports.getTransactionStats = asyncHandler(async (req, res, next) => {
  const now = new Date();
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ── Period windows ────────────────────────────────────────────────────────
  const period = ["30d", "6m", "1y", "all"].includes(req.query.period)
    ? req.query.period
    : "30d";

  let periodStart, prevStart, prevEnd, chartStart, chartMonths, periodLabel;

  if (period === "30d") {
    periodStart = new Date(now - 30 * 24 * 60 * 60 * 1000);
    prevStart = new Date(now - 60 * 24 * 60 * 60 * 1000);
    prevEnd = periodStart;
    chartStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    chartMonths = 12;
    periodLabel = "Last 30 Days";
  } else if (period === "6m") {
    periodStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    prevEnd = periodStart;
    chartStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    chartMonths = 12;
    periodLabel = "Last 6 Months";
  } else if (period === "1y") {
    periodStart = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    prevStart = new Date(now.getFullYear() - 2, now.getMonth(), 1);
    prevEnd = periodStart;
    chartStart = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    chartMonths = 12;
    periodLabel = "Last 12 Months";
  } else {
    // all — no date filter on headline; chart shows all months grouped
    periodStart = null;
    prevStart = null;
    prevEnd = null;
    chartStart = null;
    chartMonths = null;
    periodLabel = "All Time";
  }

  // ── Tenant scope ──────────────────────────────────────────────────────────
  const clientId = req?.user?.client?._id || req?.user?.clientBelongs || null;
  const branchId = req?.user?.branch?._id || req?.user?.branchBelongs || null;
  const baseMatch = {};
  if (clientId) baseMatch.client = new mongoose.Types.ObjectId(String(clientId));
  if (branchId) baseMatch.branch = new mongoose.Types.ObjectId(String(branchId));

  // Period-scoped match (headline + chart queries)
  const periodMatch = periodStart
    ? { ...baseMatch, timestamp: { $gte: periodStart } }
    : { ...baseMatch };

  const prevMatch = prevStart
    ? { ...baseMatch, timestamp: { $gte: prevStart, $lt: prevEnd } }
    : null;

  const chartMatch = chartStart
    ? { ...baseMatch, timestamp: { $gte: chartStart } }
    : { ...baseMatch };

  // ── All queries in parallel ───────────────────────────────────────────────
  const [
    statusCounts,
    flaggedCount,
    currentVolume,
    prevVolume,
    monthlyCashFlow,
    senderCountries,
    receiverCountries,
    currencyBreakdown,
    typeBreakdown,
    riskBuckets,
  ] = await Promise.all([

    // 1. Status counts — scoped to period
    Transaction.aggregate([
      { $match: periodMatch },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // 2. Flagged — scoped to period
    Transaction.countDocuments({ ...periodMatch, "investigation.flagged": true }),

    // 3. Current period: total AUD + count
    Transaction.aggregate([
      { $match: periodMatch },
      { $group: { _id: null, totalAmount: { $sum: { $ifNull: ["$convertedAmountAUD", "$amount"] } }, count: { $sum: 1 } } },
    ]),

    // 4. Previous period (null for "all")
    prevMatch
      ? Transaction.aggregate([
        { $match: prevMatch },
        { $group: { _id: null, totalAmount: { $sum: { $ifNull: ["$convertedAmountAUD", "$amount"] } }, count: { $sum: 1 } } },
      ])
      : Promise.resolve([]),

    // 5. Monthly volume chart
    Transaction.aggregate([
      { $match: chartMatch },
      {
        $group: {
          _id: { year: { $year: "$timestamp" }, month: { $month: "$timestamp" } },
          count: { $sum: 1 },
          totalAmount: { $sum: { $ifNull: ["$convertedAmountAUD", "$amount"] } },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    // 6a. Distinct sender countries — scoped to period
    Transaction.distinct("sender.institutionCountry", periodMatch),

    // 6b. Distinct receiver countries — scoped to period
    Transaction.distinct("receiver.institutionCountry", periodMatch),

    // 7. Top 5 currencies — scoped to period
    Transaction.aggregate([
      { $match: periodMatch },
      {
        $group: {
          _id: "$currency",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),

    // 8. Transaction types — scoped to period
    Transaction.aggregate([
      { $match: periodMatch },
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    // 9. Risk buckets — scoped to period
    Transaction.aggregate([
      { $match: periodMatch },
      {
        $bucket: {
          groupBy: "$riskScore",
          boundaries: [0, 40, 70, 101],
          default: "unknown",
          output: { count: { $sum: 1 } },
        },
      },
    ]),
  ]);

  // ── Derived values ────────────────────────────────────────────────────────
  const byStatus = statusCounts.reduce((acc, { _id, count }) => {
    if (_id) acc[_id] = count;
    return acc;
  }, {});
  const totalAllTime = Object.values(byStatus).reduce((s, v) => s + v, 0);

  const totalAmount = currentVolume[0]?.totalAmount || 0;
  const totalCount = currentVolume[0]?.count || 0;
  const prevTotalAmt = prevVolume[0]?.totalAmount || 0;
  const prevTotalCount = prevVolume[0]?.count || 0;

  const amountTrendPct = (period === "all" || prevTotalAmt === 0)
    ? (totalAmount > 0 ? 100 : 0)
    : +((totalAmount - prevTotalAmt) / prevTotalAmt * 100).toFixed(1);

  const countTrendPct = (period === "all" || prevTotalCount === 0)
    ? (totalCount > 0 ? 100 : 0)
    : +((totalCount - prevTotalCount) / prevTotalCount * 100).toFixed(1);

  const monthlyData = monthlyCashFlow.map(({ _id, count, totalAmount }) => ({
    month: `${_id.year}-${String(_id.month).padStart(2, "0")}`,
    label: `${MONTHS[_id.month - 1]} ${_id.year !== now.getFullYear() ? _id.year : ""}`.trim(),
    count,
    totalAmount: Math.round(totalAmount || 0),
  }));

  const allCountries = new Set([...senderCountries, ...receiverCountries].filter(Boolean));
  const activeCountries = allCountries.size;

  const riskMap = { low: 0, medium: 0, high: 0 };
  riskBuckets.forEach(({ _id, count }) => {
    if (_id === 0) riskMap.low = count;
    if (_id === 40) riskMap.medium = count;
    if (_id === 70) riskMap.high = count;
  });

  res.status(200).json({
    success: true,
    data: {
      period,
      periodLabel,

      // Period headline
      totalAmount,
      totalCount,
      prevTotalAmt: Math.round(prevTotalAmt),
      prevTotalCount,
      amountTrendPct: period === "all" ? null : amountTrendPct,
      countTrendPct: period === "all" ? null : countTrendPct,

      // Breakdowns (scoped to period)
      totalAllTime,
      byStatus,
      flaggedCount,
      activeCountries,
      riskBuckets: riskMap,

      // Chart + breakdowns
      monthlyCashFlow: monthlyData,
      byCurrency: currencyBreakdown.map(({ _id, count, totalAmount }) => ({
        currency: _id || "N/A",
        count,
        totalAmount: Math.round(totalAmount || 0),
      })),
      byType: typeBreakdown.map(({ _id, count }) => ({
        type: _id || "unknown",
        count,
      })),
    },
  });
});

// simple allowed state transitions (tweak to your business rules)
const ALLOWED_TRANSITIONS = {
  pending: ["completed", "failed", "cancelled"],
  completed: ["closed"], // completed -> closed (final)
  failed: ["pending"], // re-open failed -> pending (if allowed)
  cancelled: [], // final
  closed: [], // final
};

// change single transaction status
exports.changeTransactionStatus = asyncHandler(async (req, res, next) => {
  /*
    PUT /api/v1/transactions/:id/status
    body: { status: "completed", notes: "Verified by ops", notify: false }
  */
  const txId = req.params.id;
  if (!isValidId(txId))
    return next(new ErrorResponse("Invalid transaction id", 400));

  const { status: newStatus, notes } = req.body;
  if (!newStatus)
    return next(new ErrorResponse("Missing status in request body", 400));

  // check allowed transitions
  const current = await Transaction.findById(txId).lean();
  if (!current) return next(new ErrorResponse("Transaction not found", 404));

  const fromStatus = current.status || "pending";
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];

  // allow setting same status again (idempotent) OR if allowed list contains it
  if (newStatus !== fromStatus && !allowed.includes(newStatus)) {
    return next(
      new ErrorResponse(
        `Invalid status transition from "${fromStatus}" to "${newStatus}"`,
        400
      )
    );
  }

  // update fields
  const updates = {
    status: newStatus,
  };

  // optionally set submissionDate if moving to 'completed' or 'submitted' style states
  if (newStatus === "completed") {
    updates["metadata.submissionDate"] = new Date();
  }
  updates["metadata.updatedBy"] = req.user?.id;

  // apply DB update with runValidators
  const tx = await Transaction.findByIdAndUpdate(txId, updates, {
    new: true,
    runValidators: true,
  });

  // append workflowHistory (use push and save to keep array)
  tx.metadata = tx.metadata || {};
  tx.metadata.workflowHistory = tx.metadata.workflowHistory || [];
  tx.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id || "",
    action: "status_change",
    fromStatus,
    toStatus: newStatus,
    notes: notes || "",
  });

  await tx.save();

  return res.status(200).json({ success: true, data: tx });
});

// ─────────────────────────────────────────────────────────────────────────────
// Export CSV
// GET /api/v1/transaction/export/csv
// Respects the same query filters as the list view (no pagination limit)
// ─────────────────────────────────────────────────────────────────────────────
const CSV_FIELDS = [
  { label: "ID", value: "uid" },
  { label: "Sequence", value: "sequence" },
  { label: "Type", value: "type" },
  { label: "Status", value: "status" },
  { label: "Channel", value: "channel" },
  { label: "Reference", value: "reference" },
  { label: "Narrative", value: "narrative" },
  { label: "Amount", value: "amount" },
  { label: "Currency", value: "currency" },
  { label: "Amount (AUD)", value: "convertedAmountAUD" },
  { label: "Risk Score", value: "riskScore" },
  { label: "Flagged", value: (r) => (r.investigation?.flagged ? "Yes" : "No") },
  { label: "Related Party", value: (r) => (r.relatedPartyFlag ? "Yes" : "No") },
  { label: "Sender Name", value: (r) => r.sender?.name || "" },
  { label: "Sender Account", value: (r) => r.sender?.account || "" },
  { label: "Sender Institution", value: (r) => r.sender?.institution || "" },
  { label: "Receiver Name", value: (r) => r.receiver?.name || "" },
  { label: "Receiver Account", value: (r) => r.receiver?.account || "" },
  { label: "Beneficiary Name", value: (r) => r.beneficiary?.name || "" },
  { label: "Beneficiary Account", value: (r) => r.beneficiary?.account || "" },
  { label: "Purpose", value: "purpose" },
  { label: "Risk Flags", value: (r) => (r.riskFlags || []).join(";") },
  { label: "Timestamp", value: (r) => r.timestamp ? new Date(r.timestamp).toISOString() : "" },
  { label: "Created At", value: (r) => r.createdAt ? new Date(r.createdAt).toISOString() : "" },
];

exports.exportTransactionsCsv = asyncHandler(async (req, res, next) => {
  const filter = buildTxFilter(req.query, req.user);
  const sortField = _ALLOWED_SORT.has(req.query.sort) ? req.query.sort : "timestamp";
  const sortDir = req.query.order === "asc" ? 1 : -1;

  const transactions = await Transaction
    .find(filter)
    .sort({ [sortField]: sortDir })
    .limit(10000)
    .lean();

  const parser = new CsvParser({ fields: CSV_FIELDS });
  const csvData = parser.parse(transactions);

  const date = new Date().toISOString().slice(0, 10);
  const filename = `transactions-${date}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(200).send(csvData);
});

// ─────────────────────────────────────────────────────────────────────────────
// Import CSV
// POST /api/v1/transaction/import/csv   (multipart/form-data, field: "file")
// ─────────────────────────────────────────────────────────────────────────────
function bufferToStream(buffer) {
  const readable = new Readable();
  readable.push(buffer);
  readable.push(null);
  return readable;
}

// Maps a CSV row (header names from our export template) → transaction payload
function mapCsvRowToTx(row, user) {
  const get = (keys) => {
    for (const k of keys) {
      const val = row[k] ?? row[k.toLowerCase()] ?? row[k.toUpperCase()];
      if (val !== undefined && val !== "") return String(val).trim();
    }
    return undefined;
  };

  const amount = parseFloat(get(["Amount", "amount"]));
  const currency = get(["Currency", "currency"]);
  const type = get(["Type", "type"]) || "transfer";

  if (!currency || isNaN(amount)) return null; // skip invalid rows

  return {
    uid: get(["ID", "uid"]) || undefined,
    type,
    status: get(["Status", "status"]) || "pending",
    channel: get(["Channel", "channel"]),
    reference: get(["Reference", "reference"]),
    narrative: get(["Narrative", "narrative"]),
    purpose: get(["Purpose", "purpose"]),
    amount,
    currency: currency.toUpperCase(),
    convertedAmountAUD: parseFloat(get(["Amount (AUD)", "convertedAmountAUD"])) || undefined,
    riskScore: parseFloat(get(["Risk Score", "riskScore"])) || 0,
    sender: {
      name: get(["Sender Name", "sender_name"]),
      account: get(["Sender Account", "sender_account"]),
      institution: get(["Sender Institution", "sender_institution"]),
    },
    receiver: {
      name: get(["Receiver Name", "receiver_name"]),
      account: get(["Receiver Account", "receiver_account"]),
    },
    beneficiary: {
      name: get(["Beneficiary Name", "beneficiary_name"]),
      account: get(["Beneficiary Account", "beneficiary_account"]),
    },
    client: user?.client?._id || undefined,
    branch: user?.branch?._id || undefined,
    createdBy: user?._id || undefined,
  };
}

exports.importTransactionsCsv = asyncHandler(async (req, res, next) => {
  if (!req.file) return next(new ErrorResponse("No CSV file uploaded (field: file)", 400));

  const rows = await new Promise((resolve, reject) => {
    const results = [];
    bufferToStream(req.file.buffer)
      .pipe(csv())
      .on("data", (row) => results.push(row))
      .on("end", () => resolve(results))
      .on("error", (err) => reject(err));
  });

  if (rows.length === 0) return next(new ErrorResponse("CSV file is empty", 400));

  const created = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const payload = mapCsvRowToTx(rows[i], req.user);
    if (!payload) {
      errors.push({ row: i + 2, reason: "Missing required fields: amount, currency" });
      continue;
    }
    try {
      const tx = await Transaction.create(payload);
      created.push(tx._id);
    } catch (err) {
      errors.push({ row: i + 2, reason: err.message });
    }
  }

  res.status(200).json({
    success: true,
    message: `Imported ${created.length} of ${rows.length} transactions`,
    created: created.length,
    failed: errors.length,
    errors,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Download single transaction as PDF
// GET /api/v1/transaction/:id/pdf
// ─────────────────────────────────────────────────────────────────────────────
function buildTxHtml(tx) {
  const fmt = (v) => (v !== undefined && v !== null && v !== "" ? String(v) : "—");
  const fmtDate = (v) => v ? new Date(v).toLocaleString("en-AU", { dateStyle: "long", timeStyle: "short" }) : "—";
  const fmtAmt = (amount, currency) =>
    amount != null
      ? `${fmt(currency)}&nbsp;${Number(amount).toLocaleString("en-AU", { minimumFractionDigits: 2 })}`
      : "—";

  const score = Math.min(tx.riskScore || 0, 100);
  const riskColor = score >= 70 ? "#dc2626" : score >= 40 ? "#d97706" : "#16a34a";
  const riskLabel = score >= 70 ? "HIGH RISK" : score >= 40 ? "MEDIUM RISK" : "LOW RISK";
  const riskBg = score >= 70 ? "#fef2f2" : score >= 40 ? "#fffbeb" : "#f0fdf4";
  const riskBorder = score >= 70 ? "#fecaca" : score >= 40 ? "#fde68a" : "#bbf7d0";

  const statusCfg = {
    pending: { bg: "#fefce8", text: "#854d0e", border: "#fde68a", dot: "#f59e0b" },
    completed: { bg: "#f0fdf4", text: "#166534", border: "#bbf7d0", dot: "#22c55e" },
    failed: { bg: "#fef2f2", text: "#991b1b", border: "#fecaca", dot: "#ef4444" },
    cancelled: { bg: "#f9fafb", text: "#374151", border: "#e5e7eb", dot: "#9ca3af" },
  };
  const sc = statusCfg[tx.status] || statusCfg.pending;

  const row = (label, value, mono = false) =>
    value && value !== "—"
      ? `<tr>
           <td class="tl">${label}</td>
           <td class="tv">${mono ? `<code>${value}</code>` : value}</td>
         </tr>`
      : "";

  const partyCard = (label, party, accentColor) => {
    if (!party?.name && !party?.account) return "";
    return `
    <div class="party-card" style="border-left:4px solid ${accentColor}">
      <div class="party-label" style="color:${accentColor}">${label}</div>
      <div class="party-name">${fmt(party.name)}</div>
      ${party.account ? `<div class="party-meta"><span class="party-tag">Account</span><code>${fmt(party.account)}</code></div>` : ""}
      ${party.institution ? `<div class="party-meta"><span class="party-tag">Institution</span>${fmt(party.institution)}</div>` : ""}
      ${party.institutionCountry ? `<div class="party-meta"><span class="party-tag">Country</span>${fmt(party.institutionCountry)}</div>` : ""}
      ${party.address ? `<div class="party-meta"><span class="party-tag">Address</span>${fmt(party.address)}</div>` : ""}
    </div>`;
  };

  const genDate = new Date().toLocaleString("en-AU", { dateStyle: "long", timeStyle: "short" });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Transaction ${fmt(tx.uid)}</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12.5px; color: #1e293b; background: #fff; }

    /* ── Top banner ── */
    .banner {
      background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 60%, #1d4ed8 100%);
      padding: 28px 36px 24px;
      position: relative;
      overflow: hidden;
    }
    .banner::after {
      content: "";
      position: absolute;
      right: -40px; top: -40px;
      width: 220px; height: 220px;
      border-radius: 50%;
      background: rgba(255,255,255,.04);
    }
    .banner-top { display: flex; justify-content: space-between; align-items: flex-start; }
    .banner-title { color: #fff; font-size: 22px; font-weight: 700; letter-spacing: -.3px; }
    .banner-sub   { color: #93c5fd; font-size: 11.5px; margin-top: 3px; font-family: monospace; letter-spacing: .03em; }
    .banner-type  {
      background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.2);
      color: #e0f2fe; font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; padding: 4px 12px; border-radius: 99px;
    }
    .banner-meta { display: flex; gap: 24px; margin-top: 18px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.12); }
    .banner-kv   { display: flex; flex-direction: column; gap: 2px; }
    .banner-kv .k { color: #7dd3fc; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
    .banner-kv .v { color: #f0f9ff; font-size: 13px; font-weight: 700; }

    /* ── Status pill ── */
    .status-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 14px; border-radius: 99px; font-size: 12px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .06em;
      border: 1.5px solid ${sc.border}; background: ${sc.bg}; color: ${sc.text};
    }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: ${sc.dot}; }

    /* ── Body ── */
    .body { padding: 24px 36px 20px; }

    /* ── Flow card ── */
    .flow-card {
      display: flex; align-items: stretch; gap: 0;
      border: 1.5px solid #e2e8f0; border-radius: 12px; overflow: hidden;
      margin-bottom: 24px; box-shadow: 0 1px 4px rgba(0,0,0,.06);
    }
    .flow-party { flex: 1; padding: 16px 18px; background: #f8fafc; }
    .flow-party.receiver { background: #f0fdf4; }
    .flow-party-lbl { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #64748b; margin-bottom: 6px; }
    .flow-party-name { font-size: 15px; font-weight: 700; color: #0f172a; }
    .flow-party-acct { font-family: monospace; font-size: 11px; color: #64748b; margin-top: 3px; }
    .flow-party-bank { font-size: 11px; color: #94a3b8; margin-top: 2px; }
    .flow-center {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 16px 20px; background: #fff; border-left: 1.5px solid #e2e8f0; border-right: 1.5px solid #e2e8f0;
      min-width: 130px;
    }
    .flow-arrow-icon { font-size: 20px; color: #22c55e; margin-bottom: 6px; }
    .flow-amount { font-size: 17px; font-weight: 800; color: #0f172a; text-align: center; line-height: 1.2; }
    .flow-aud   { font-size: 10.5px; color: #64748b; margin-top: 3px; text-align: center; }

    /* ── Section heading ── */
    .section-head {
      display: flex; align-items: center; gap: 8px;
      font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
      color: #1d4ed8; margin: 22px 0 10px;
    }
    .section-head::before {
      content: ""; display: block; width: 4px; height: 16px;
      background: linear-gradient(180deg, #1d4ed8, #60a5fa);
      border-radius: 2px; flex-shrink: 0;
    }
    .section-head::after {
      content: ""; flex: 1; height: 1px; background: #e2e8f0;
    }

    /* ── Detail table ── */
    .detail-table { width: 100%; border-collapse: collapse; }
    .detail-table tr:nth-child(odd) td { background: #f8fafc; }
    .detail-table tr td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .tl { width: 36%; font-size: 11.5px; font-weight: 600; color: #475569; }
    .tv { font-size: 12px; color: #0f172a; }
    code { font-family: monospace; font-size: 11px; background: #eff6ff; color: #1d4ed8; padding: 1px 5px; border-radius: 3px; border: 1px solid #dbeafe; }

    /* ── Risk card ── */
    .risk-card {
      border: 1.5px solid ${riskBorder}; border-radius: 10px;
      background: ${riskBg}; padding: 16px 18px; margin-bottom: 4px;
    }
    .risk-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .risk-score { font-size: 36px; font-weight: 900; color: ${riskColor}; line-height: 1; }
    .risk-score span { font-size: 14px; font-weight: 400; color: #64748b; }
    .risk-badge {
      padding: 4px 12px; border-radius: 99px; font-size: 11px; font-weight: 800;
      letter-spacing: .06em; background: ${riskColor}; color: #fff;
    }
    .risk-bar-track { background: #e2e8f0; border-radius: 99px; height: 10px; overflow: hidden; }
    .risk-bar-fill  { height: 10px; border-radius: 99px; background: linear-gradient(90deg, ${riskColor}aa, ${riskColor}); width: ${score}%; }
    .risk-label-row { display: flex; justify-content: space-between; font-size: 10px; color: #64748b; margin-top: 4px; }

    /* ── Party cards ── */
    .party-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .party-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 13px 14px; background: #fff; }
    .party-label { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 5px; }
    .party-name  { font-size: 13.5px; font-weight: 700; color: #0f172a; }
    .party-meta  { display: flex; align-items: baseline; gap: 6px; margin-top: 4px; font-size: 11px; color: #475569; }
    .party-tag   { font-size: 9.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .04em; width: 60px; flex-shrink: 0; }

    /* ── Flag badges ── */
    .flag-red  { display:inline-block; padding:2px 9px; border-radius:4px; font-size:11px; font-weight:700; background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; }
    .flag-warn { display:inline-block; padding:2px 9px; border-radius:4px; font-size:11px; font-weight:700; background:#fffbeb; color:#92400e; border:1px solid #fde68a; }

    /* ── Footer ── */
    .footer-bar {
      background: linear-gradient(135deg, #0f172a, #1e3a5f);
      padding: 14px 36px;
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 28px;
    }
    .footer-left  { color: #93c5fd; font-size: 10px; }
    .footer-right { color: #7dd3fc; font-size: 10px; font-family: monospace; }
    .footer-conf  { color: rgba(255,255,255,.35); font-size: 9px; letter-spacing: .06em; text-transform: uppercase; margin-top: 2px; }
  </style>
</head>
<body>

  <!-- ── Banner ── -->
  <div class="banner">
    <div class="banner-top">
      <div>
        <div class="banner-title">Transaction Report</div>
        <div class="banner-sub">${fmt(tx.uid)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        <span class="banner-type">${fmt(tx.type)}</span>
        <span class="status-pill"><span class="status-dot"></span>${fmt(tx.status)}</span>
      </div>
    </div>
    <div class="banner-meta">
      <div class="banner-kv">
        <span class="k">Amount</span>
        <span class="v">${fmtAmt(tx.amount, tx.currency)}</span>
      </div>
      ${tx.convertedAmountAUD ? `
      <div class="banner-kv">
        <span class="k">AUD Equivalent</span>
        <span class="v">AUD&nbsp;${Number(tx.convertedAmountAUD).toLocaleString("en-AU", { minimumFractionDigits: 2 })}</span>
      </div>` : ""}
      <div class="banner-kv">
        <span class="k">Date</span>
        <span class="v">${fmtDate(tx.timestamp)}</span>
      </div>
      ${tx.channel ? `
      <div class="banner-kv">
        <span class="k">Channel</span>
        <span class="v" style="text-transform:capitalize">${fmt(tx.channel)}</span>
      </div>` : ""}
    </div>
  </div>

  <div class="body">

    <!-- ── Flow ── -->
    <div class="flow-card">
      <div class="flow-party">
        <div class="flow-party-lbl">Sender</div>
        <div class="flow-party-name">${fmt(tx.sender?.name)}</div>
        ${tx.sender?.account ? `<div class="flow-party-acct">${fmt(tx.sender.account)}</div>` : ""}
        ${tx.sender?.institution ? `<div class="flow-party-bank">${fmt(tx.sender.institution)}</div>` : ""}
      </div>
      <div class="flow-center">
        <div class="flow-arrow-icon">&#x2192;</div>
        <div class="flow-amount">${fmtAmt(tx.amount, tx.currency)}</div>
        ${tx.convertedAmountAUD ? `<div class="flow-aud">≈ AUD ${Number(tx.convertedAmountAUD).toLocaleString("en-AU", { minimumFractionDigits: 2 })}</div>` : ""}
      </div>
      <div class="flow-party receiver">
        <div class="flow-party-lbl">Receiver</div>
        <div class="flow-party-name">${fmt(tx.receiver?.name)}</div>
        ${tx.receiver?.account ? `<div class="flow-party-acct">${fmt(tx.receiver.account)}</div>` : ""}
        ${tx.receiver?.institution ? `<div class="flow-party-bank">${fmt(tx.receiver.institution)}</div>` : ""}
      </div>
    </div>

    <!-- ── Risk Assessment ── -->
    <div class="section-head">Risk Assessment</div>
    <div class="risk-card">
      <div class="risk-top">
        <div>
          <div class="risk-score">${score}<span> / 100</span></div>
        </div>
        <span class="risk-badge">${riskLabel}</span>
      </div>
      <div class="risk-bar-track"><div class="risk-bar-fill"></div></div>
      <div class="risk-label-row"><span>Low (0)</span><span>Medium (40)</span><span>High (70–100)</span></div>
    </div>
    ${(tx.riskFlags || []).length ? `
    <table class="detail-table" style="margin-top:8px">
      ${row("Risk Flags", tx.riskFlags.join(", "))}
    </table>` : ""}
    ${tx.investigation?.flagged || tx.investigation?.caseId ? `
    <table class="detail-table" style="margin-top:8px">
      ${tx.investigation.flagged ? `<tr><td class="tl">Investigation</td><td class="tv"><span class="flag-red">&#9873; Flagged for Investigation</span></td></tr>` : ""}
      ${row("Case ID", tx.investigation.caseId)}
      ${row("Notes", tx.investigation.investigatorNotes)}
    </table>` : ""}

    <!-- ── Transaction Details ── -->
    <div class="section-head">Transaction Details</div>
    <table class="detail-table">
      ${row("Reference", fmt(tx.reference), true)}
      ${row("Narrative", fmt(tx.narrative))}
      ${row("Purpose", fmt(tx.purpose))}
      ${row("Sub-type", fmt(tx.subtype))}
      ${tx.relatedPartyFlag ? `<tr><td class="tl">Related Party</td><td class="tv"><span class="flag-warn">&#9873; Related Party Flagged</span></td></tr>` : ""}
      ${row("Related Txn ID", fmt(tx.relatedPartyTxnId), true)}
      ${row("Created At", fmtDate(tx.createdAt))}
    </table>

    <!-- ── Parties ── -->
    <div class="section-head">Transaction Parties</div>
    <div class="party-grid">
      ${partyCard("Sender", tx.sender, "#1d4ed8")}
      ${partyCard("Receiver", tx.receiver, "#16a34a")}
      ${partyCard("Beneficiary", tx.beneficiary, "#7c3aed")}
      ${partyCard("Intermediary", tx.intermediary, "#0891b2")}
    </div>

  </div>

  <!-- ── Footer ── -->
  <div class="footer-bar">
    <div>
      <div class="footer-left">Generated on ${genDate}</div>
      <div class="footer-conf">Confidential &mdash; For authorised use only</div>
    </div>
    <div class="footer-right">${fmt(tx.uid)}</div>
  </div>

</body>
</html>`;
}

exports.downloadTransactionPdf = asyncHandler(async (req, res, next) => {
  if (!isValidId(req.params.id))
    return next(new ErrorResponse("Invalid transaction id", 400));

  const tx = await Transaction.findById(req.params.id).lean();
  if (!tx) return next(new ErrorResponse("Transaction not found", 404));

  const html = buildTxHtml(tx);

  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="transaction-${tx.uid || tx._id}.pdf"`);
    res.end(pdfBuffer);
  } catch (err) {
    return next(new ErrorResponse("Error generating PDF", 500));
  } finally {
    if (browser) await browser.close();
  }
});

// bulk change statuses (accepts array of ids)
exports.bulkChangeTransactionStatus = asyncHandler(async (req, res, next) => {
  /*
    PUT /api/v1/transactions/status
    body: { ids: ["id1","id2"], status: "completed", notes: "Batch processed" }
  */
  const { ids = [], status: newStatus, notes } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return next(new ErrorResponse("ids array required", 400));
  if (!newStatus) return next(new ErrorResponse("status required", 400));

  // validate ids
  const invalid = ids.find((i) => !isValidId(i));
  if (invalid) return next(new ErrorResponse(`Invalid id: ${invalid}`, 400));

  const results = {
    success: [],
    failed: [],
  };

  // process sequentially to keep workflow history per document — could batch for performance
  for (const id of ids) {
    try {
      const doc = await Transaction.findById(id).lean();
      if (!doc) {
        results.failed.push({ id, reason: "not_found" });
        continue;
      }
      const fromStatus = doc.status || "pending";
      const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];

      if (newStatus !== fromStatus && !allowed.includes(newStatus)) {
        results.failed.push({
          id,
          reason: `invalid_transition: ${fromStatus}->${newStatus}`,
        });
        continue;
      }

      const updated = await Transaction.findByIdAndUpdate(
        id,
        {
          status: newStatus,
          "metadata.updatedBy": req.user?.id,
          ...(newStatus === "completed"
            ? { "metadata.submissionDate": new Date() }
            : {}),
        },
        { new: true, runValidators: true }
      );

      updated.metadata = updated.metadata || {};
      updated.metadata.workflowHistory = updated.metadata.workflowHistory || [];
      updated.metadata.workflowHistory.push({
        timestamp: new Date(),
        user: req.user?.id,
        action: "status_change_bulk",
        fromStatus,
        toStatus: newStatus,
        notes: notes || "",
      });
      await updated.save();

      results.success.push({ id, status: newStatus });
    } catch (err) {
      results.failed.push({ id, reason: err.message });
    }
  }

  res.status(200).json({ success: true, result: results });
});
