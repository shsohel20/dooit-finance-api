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
// Never call puppeteer.launch() directly — the container needs the hardened
// launch options in this helper (writable HOME for crashpad, /dev/shm off).
// See docs/56-PUPPETEER-DOCKER-CRASHPAD-FIX.md.
const { launchPdfBrowser } = require("../utils/puppeteerLaunch");

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
//
// Compliance-grade single-transaction report. Every value reaching the template
// is HTML-escaped: narrative, party names and investigator notes are all
// operator-supplied free text, and a stray "<" silently truncates the render.
// ─────────────────────────────────────────────────────────────────────────────

const _HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => _HTML_ESCAPES[c]);

// Fields encrypted at rest are stored as "<iv>:<authTag>:<ciphertext>" hex. A
// lean() read can hand one back undecrypted; printing that blob onto a report
// is worse than printing nothing, so fall back instead.
const _CIPHERTEXT_RE = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/i;
const plainOr = (value, fallback = "") =>
  value && !_CIPHERTEXT_RE.test(String(value)) ? String(value) : fallback;

const RISK_BANDS = [
  { min: 70, label: "High Risk", color: "#b91c1c", bg: "#fef2f2", border: "#fecaca" },
  { min: 40, label: "Medium Risk", color: "#b45309", bg: "#fffbeb", border: "#fde68a" },
  { min: 0, label: "Low Risk", color: "#15803d", bg: "#f0fdf4", border: "#bbf7d0" },
];

const STATUS_STYLES = {
  pending: { bg: "#fffbeb", text: "#92400e", border: "#fde68a", dot: "#f59e0b" },
  completed: { bg: "#f0fdf4", text: "#166534", border: "#bbf7d0", dot: "#22c55e" },
  failed: { bg: "#fef2f2", text: "#991b1b", border: "#fecaca", dot: "#ef4444" },
  cancelled: { bg: "#f8fafc", text: "#334155", border: "#e2e8f0", dot: "#94a3b8" },
};

function buildTxHtml(tx, meta = {}) {
  const DASH = "&mdash;";
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const text = (v) => (has(v) ? escHtml(v) : DASH);
  const date = (v) => {
    if (!v) return DASH;
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? DASH
      : escHtml(d.toLocaleString("en-AU", { dateStyle: "long", timeStyle: "short" }));
  };
  const num = (v) =>
    Number(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amount = (v, currency) =>
    has(v) && Number.isFinite(Number(v))
      ? `${escHtml(String(currency || "").toUpperCase())}&nbsp;${num(v)}`
      : DASH;
  const titled = (v) =>
    has(v)
      ? escHtml(String(v).replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()))
      : DASH;

  // A row renders only when it holds a value, and a section only when it has
  // rows — so the report never prints a heading over blank space.
  const row = (label, value, opts = {}) => {
    if (!has(value)) return "";
    const v = opts.html ? value : escHtml(value);
    return `<tr><td class="tl">${escHtml(label)}</td><td class="tv">${
      opts.mono ? `<code>${v}</code>` : v
    }</td></tr>`;
  };
  const table = (rows) => (rows.trim() ? `<table class="detail-table">${rows}</table>` : "");
  const section = (title, inner) =>
    inner && inner.trim()
      ? `<section class="block"><h2 class="section-head">${escHtml(title)}</h2>${inner}</section>`
      : "";

  const score = Math.max(0, Math.min(Number(tx.riskScore) || 0, 100));
  const band = RISK_BANDS.find((b) => score >= b.min) || RISK_BANDS[RISK_BANDS.length - 1];
  const status = String(tx.status || "pending").toLowerCase();
  const sc = STATUS_STYLES[status] || STATUS_STYLES.pending;

  const partyCard = (label, party, accent) => {
    if (!party || (!has(party.name) && !has(party.account) && !has(party.institution))) return "";
    const line = (k, v, mono) =>
      has(v)
        ? `<div class="party-line"><span class="party-key">${escHtml(k)}</span>` +
          `<span class="party-val${mono ? " mono" : ""}">${escHtml(v)}</span></div>`
        : "";
    return `
      <div class="party-card" style="border-top:3px solid ${accent}">
        <div class="party-role" style="color:${accent}">${escHtml(label)}</div>
        <div class="party-name">${text(party.name)}</div>
        ${line("Account", party.account, true)}
        ${line("Institution", party.institution)}
        ${line("BIC / SWIFT", party.bic, true)}
        ${line("Country", party.institutionCountry)}
        ${line("Address", party.address)}
      </div>`;
  };

  // Two cards per row via a table — print pagination handles table rows far
  // more predictably than a wrapped flex/grid container.
  const cards = [
    partyCard("Sender / Originator", tx.sender, "#1d4ed8"),
    partyCard("Receiver", tx.receiver, "#15803d"),
    partyCard("Beneficiary", tx.beneficiary, "#7c3aed"),
    partyCard("Intermediary", tx.intermediary, "#0e7490"),
  ].filter(Boolean);

  const partyPairs = cards.reduce((acc, card, i) => {
    if (i % 2 === 0) acc.push([card]);
    else acc[acc.length - 1].push(card);
    return acc;
  }, []);

  const partyGrid = cards.length
    ? `<table class="party-table"><tbody>${partyPairs
        .map(
          (pair) =>
            `<tr>${pair.map((c) => `<td>${c}</td>`).join("")}${
              pair.length === 1 ? "<td></td>" : ""
            }</tr>`
        )
        .join("")}</tbody></table>`
    : "";

  const flags = (tx.riskFlags || []).filter(has);
  const flagChips = flags.length
    ? `<div class="chip-row">${flags
        .map((f) => `<span class="chip chip-risk">${titled(f)}</span>`)
        .join("")}</div>`
    : `<p class="muted">No risk indicators were raised against this transaction.</p>`;

  const generatedAt = date(meta.generatedAt || Date.now());

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Transaction Report ${text(tx.uid)}</title>
<style>
  /* Liberation/DejaVu are the fonts installed in the API image; naming them
     first keeps container output metrically identical to Windows dev. */
  :root {
    --ink: #0f172a; --body: #334155; --muted: #64748b; --line: #e2e8f0;
    --brand: #1d4ed8; --brand-deep: #0f172a;
  }
  @page { size: A4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Liberation Sans", Arial, Helvetica, sans-serif;
    font-size: 10.5px; line-height: 1.45; color: var(--body);
    background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .mono, code { font-family: "DejaVu Sans Mono", "Liberation Mono", Consolas, monospace; }
  code {
    font-size: 9.5px; background: #eff6ff; color: #1e40af;
    padding: 1px 5px; border-radius: 3px; border: 1px solid #dbeafe;
  }
  .muted { color: var(--muted); font-size: 10px; font-style: italic; }

  /* ── Masthead ── */
  .masthead {
    background: linear-gradient(120deg, #0f172a 0%, #17325c 55%, #1d4ed8 100%);
    color: #fff; border-radius: 8px; padding: 18px 22px 16px; margin-bottom: 14px;
  }
  .mast-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .mast-title { font-size: 18px; font-weight: 700; letter-spacing: -.2px; }
  .mast-sub { color: #bfdbfe; font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; margin-top: 3px; }
  .mast-uid { color: #e0f2fe; font-size: 11px; margin-top: 7px; }
  .mast-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
  .badge-type {
    background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.28); color: #f0f9ff;
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em;
    padding: 3px 11px; border-radius: 99px;
  }
  .status-pill {
    display: inline-flex; align-items: center; gap: 5px; padding: 3px 11px; border-radius: 99px;
    font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
    border: 1px solid ${sc.border}; background: ${sc.bg}; color: ${sc.text};
  }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; background: ${sc.dot}; }
  .mast-figures { display: flex; gap: 26px; margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.16); }
  .fig .k { display: block; color: #93c5fd; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; }
  .fig .v { display: block; color: #fff; font-size: 12.5px; font-weight: 700; margin-top: 2px; }

  /* ── Document control ── */
  .control-table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  .control-table td {
    border: 1px solid var(--line); padding: 7px 10px; width: 33.33%;
    background: #f8fafc; vertical-align: top;
  }
  .ck { display: block; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); }
  .cv { display: block; font-size: 10.5px; font-weight: 600; color: var(--ink); margin-top: 2px; }

  /* ── Sections ── */
  .block { margin-bottom: 16px; }
  .section-head {
    display: flex; align-items: center; gap: 8px;
    font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em;
    color: var(--brand); margin-bottom: 8px; page-break-after: avoid;
  }
  .section-head::before { content: ""; width: 3px; height: 13px; background: var(--brand); border-radius: 2px; flex-shrink: 0; }
  .section-head::after { content: ""; flex: 1; height: 1px; background: var(--line); }

  /* ── Value flow ── */
  .flow { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 6px; page-break-inside: avoid; }
  .flow td { padding: 13px 15px; vertical-align: middle; }
  .flow .leg { width: 37%; background: #f8fafc; }
  .flow .leg.to { background: #f0fdf4; }
  .flow .mid { width: 26%; text-align: center; border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
  .leg-lbl { font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); }
  .leg-name { font-size: 12px; font-weight: 700; color: var(--ink); margin-top: 4px; }
  .leg-meta { font-size: 9.5px; color: var(--muted); margin-top: 2px; }
  .flow-amt { font-size: 14px; font-weight: 800; color: var(--ink); margin-top: 4px; }
  .flow-aud { font-size: 9px; color: var(--muted); margin-top: 2px; }

  /* ── Detail tables ── */
  .detail-table { width: 100%; border-collapse: collapse; }
  .detail-table td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .detail-table tr:nth-child(odd) td { background: #f8fafc; }
  .tl { width: 32%; font-weight: 600; color: #475569; }
  .tv { color: var(--ink); }

  /* ── Risk ── */
  .risk-card {
    border: 1px solid ${band.border}; background: ${band.bg};
    border-radius: 6px; padding: 14px 16px; page-break-inside: avoid;
  }
  .risk-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px; }
  .risk-score { font-size: 30px; font-weight: 800; color: ${band.color}; line-height: 1; }
  .risk-score small { font-size: 12px; font-weight: 400; color: var(--muted); }
  .risk-badge {
    padding: 4px 12px; border-radius: 99px; font-size: 9.5px; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase; background: ${band.color}; color: #fff;
  }
  .risk-track { height: 8px; background: rgba(15,23,42,.09); border-radius: 99px; overflow: hidden; }
  .risk-fill { height: 8px; width: ${score}%; background: ${band.color}; border-radius: 99px; }
  .risk-scale { display: flex; justify-content: space-between; font-size: 8.5px; color: var(--muted); margin-top: 4px; }

  /* ── Chips ── */
  .chip-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
  .chip { font-size: 9px; font-weight: 600; padding: 2px 9px; border-radius: 4px; }
  .chip-risk { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
  .flag-note {
    display: inline-block; font-size: 9.5px; font-weight: 700; padding: 2px 9px;
    border-radius: 4px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
  }
  .flag-warn { background: #fffbeb; color: #92400e; border-color: #fde68a; }

  /* ── Parties ── */
  .party-table { width: 100%; border-collapse: separate; border-spacing: 8px 8px; margin: -8px; }
  .party-table td { width: 50%; vertical-align: top; }
  .party-card { border: 1px solid var(--line); border-radius: 6px; padding: 11px 13px; page-break-inside: avoid; }
  .party-role { font-size: 8.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .09em; }
  .party-name { font-size: 12px; font-weight: 700; color: var(--ink); margin: 3px 0 5px; }
  .party-line { display: flex; gap: 8px; font-size: 9.5px; margin-top: 2px; }
  .party-key { width: 74px; flex-shrink: 0; color: var(--muted); font-weight: 600; }
  .party-val { color: #334155; }

  /* ── Attestation ── */
  .attest {
    margin-top: 20px; border-top: 2px solid var(--brand-deep); padding-top: 10px;
    display: flex; justify-content: space-between; gap: 20px; page-break-inside: avoid;
  }
  .attest p { font-size: 8.5px; color: var(--muted); max-width: 70%; }
  .attest .stamp { font-size: 8.5px; color: var(--muted); text-align: right; }
</style>
</head>
<body>

  <header class="masthead">
    <div class="mast-top">
      <div>
        <div class="mast-sub">Anti-Money Laundering &middot; Transaction Record</div>
        <div class="mast-title">Transaction Report</div>
        <div class="mast-uid mono">${text(tx.uid)}</div>
      </div>
      <div class="mast-badges">
        <span class="badge-type">${titled(tx.type)}</span>
        <span class="status-pill"><span class="status-dot"></span>${titled(tx.status)}</span>
      </div>
    </div>
    <div class="mast-figures">
      <div class="fig"><span class="k">Amount</span><span class="v">${amount(tx.amount, tx.currency)}</span></div>
      ${
        has(tx.convertedAmountAUD)
          ? `<div class="fig"><span class="k">AUD Equivalent</span><span class="v">${amount(
              tx.convertedAmountAUD,
              "AUD"
            )}</span></div>`
          : ""
      }
      <div class="fig"><span class="k">Value Date</span><span class="v">${date(tx.timestamp)}</span></div>
      ${
        has(tx.channel)
          ? `<div class="fig"><span class="k">Channel</span><span class="v">${titled(tx.channel)}</span></div>`
          : ""
      }
    </div>
  </header>

  <table class="control-table">
    <tr>
      <td><span class="ck">Reporting Entity</span><span class="cv">${text(meta.clientName)}</span></td>
      <td><span class="ck">Branch</span><span class="cv">${text(meta.branchName)}</span></td>
      <td><span class="ck">Record Status</span><span class="cv">${titled(tx.status)}</span></td>
    </tr>
    <tr>
      <td><span class="ck">Report Generated</span><span class="cv">${generatedAt}</span></td>
      <td><span class="ck">Generated By</span><span class="cv">${text(meta.generatedBy)}</span></td>
      <td><span class="ck">Classification</span><span class="cv">Confidential</span></td>
    </tr>
  </table>

  ${section(
    "Value Flow",
    `<table class="flow"><tr>
      <td class="leg">
        <div class="leg-lbl">From &middot; Sender</div>
        <div class="leg-name">${text(tx.sender?.name)}</div>
        ${has(tx.sender?.account) ? `<div class="leg-meta mono">${text(tx.sender.account)}</div>` : ""}
        ${has(tx.sender?.institution) ? `<div class="leg-meta">${text(tx.sender.institution)}</div>` : ""}
      </td>
      <td class="mid">
        <svg width="58" height="10" viewBox="0 0 58 10" aria-hidden="true">
          <path d="M0 5H48" stroke="#1d4ed8" stroke-width="1.6"/>
          <path d="M46 0.5L57 5L46 9.5Z" fill="#1d4ed8"/>
        </svg>
        <div class="flow-amt">${amount(tx.amount, tx.currency)}</div>
        ${
          has(tx.convertedAmountAUD)
            ? `<div class="flow-aud">${amount(tx.convertedAmountAUD, "AUD")} equivalent</div>`
            : ""
        }
      </td>
      <td class="leg to">
        <div class="leg-lbl">To &middot; Receiver</div>
        <div class="leg-name">${text(tx.receiver?.name)}</div>
        ${has(tx.receiver?.account) ? `<div class="leg-meta mono">${text(tx.receiver.account)}</div>` : ""}
        ${has(tx.receiver?.institution) ? `<div class="leg-meta">${text(tx.receiver.institution)}</div>` : ""}
      </td>
    </tr></table>`
  )}

  ${section(
    "Risk Assessment",
    `<div class="risk-card">
      <div class="risk-top">
        <div class="risk-score">${score}<small> / 100</small></div>
        <span class="risk-badge">${escHtml(band.label)}</span>
      </div>
      <div class="risk-track"><div class="risk-fill"></div></div>
      <div class="risk-scale"><span>Low 0&ndash;39</span><span>Medium 40&ndash;69</span><span>High 70&ndash;100</span></div>
      ${flagChips}
    </div>`
  )}

  ${section(
    "Transaction Details",
    table(
      row("Reference", tx.reference, { mono: true }) +
        row("Transaction Type", has(tx.type) ? titled(tx.type) : "", { html: true }) +
        row("Sub-type", has(tx.subtype) ? titled(tx.subtype) : "", { html: true }) +
        row("Channel", has(tx.channel) ? titled(tx.channel) : "", { html: true }) +
        row("Purpose", tx.purpose) +
        row("Remittance Purpose Code", tx.remittancePurposeCode, { mono: true }) +
        row("Narrative", tx.narrative) +
        (tx.relatedPartyFlag
          ? row("Related Party", `<span class="flag-note flag-warn">Related party transaction</span>`, {
              html: true,
            })
          : "") +
        row("Related Transaction ID", tx.relatedPartyTxnId, { mono: true }) +
        row("Value Date", has(tx.timestamp) ? date(tx.timestamp) : "", { html: true })
    )
  )}

  ${section("Transaction Parties", partyGrid)}

  ${section(
    "Virtual Asset Details",
    table(
      row("Network", tx.crypto?.network) +
        row("Wallet Address", tx.crypto?.walletAddress, { mono: true }) +
        row("Transaction Hash", tx.crypto?.txHash, { mono: true }) +
        row("Cluster", tx.crypto?.cluster) +
        row("Hops From Source", tx.crypto?.hops)
    )
  )}

  ${section(
    "Travel Rule",
    table(
      row("Originator VASP", tx.travelRule?.originatorVaspName) +
        row("Originator VASP ID", tx.travelRule?.originatorVaspId, { mono: true }) +
        row("Originator Licence", tx.travelRule?.originatorVaspLicense) +
        row("Beneficiary VASP", tx.travelRule?.beneficiaryVaspName) +
        row("Beneficiary VASP ID", tx.travelRule?.beneficiaryVaspId, { mono: true }) +
        row("Travel Message ID", tx.travelRule?.travelMessageId, { mono: true }) +
        row("Protocol", tx.travelRule?.protocol)
    )
  )}

  ${section(
    "Bullion Details",
    table(
      row("Metal", tx.bullion?.type) +
        row("Purity", tx.bullion?.purity) +
        row("Weight", has(tx.bullion?.weight) ? `${tx.bullion.weight} g` : "")
    )
  )}

  ${section(
    "Forensic Analysis",
    table(
      row("Wallet Cluster", tx.forensic?.walletCluster) +
        row("Chain Analytics Score", tx.forensic?.chainalysisScore) +
        row("Analyst Notes", tx.forensic?.notes)
    )
  )}

  ${section(
    "Investigation",
    table(
      (tx.investigation?.flagged
        ? row("Status", `<span class="flag-note">Flagged for investigation</span>`, { html: true })
        : "") +
        row("Case Reference", tx.investigation?.caseId, { mono: true }) +
        row("Investigator Notes", tx.investigation?.investigatorNotes)
    )
  )}

  ${section(
    "Record Audit",
    table(
      row("Record ID", tx._id, { mono: true }) +
        row("Sequence", tx.sequence) +
        row("Created", has(tx.createdAt) ? date(tx.createdAt) : "", { html: true }) +
        row("Created By", meta.createdByName) +
        row("Last Updated", has(tx.updatedAt) ? date(tx.updatedAt) : "", { html: true })
    )
  )}

  <div class="attest">
    <p>
      This report was generated from the transaction record held in the case management
      system at the time and date shown above. It is confidential and intended solely for
      authorised compliance, audit and regulatory use.
    </p>
    <div class="stamp">
      <div class="mono">${text(tx.uid)}</div>
      <div>${generatedAt}</div>
    </div>
  </div>

</body>
</html>`;
}

// Exported so the template can be rendered (and snapshot-tested) without a browser.
exports.buildTxHtml = buildTxHtml;

exports.downloadTransactionPdf = asyncHandler(async (req, res, next) => {
  if (!isValidId(req.params.id))
    return next(new ErrorResponse("Invalid transaction id", 400));

  const tx = await Transaction.findById(req.params.id)
    .populate("client branch createdBy")
    .lean();
  if (!tx) return next(new ErrorResponse("Transaction not found", 404));

  const html = buildTxHtml(tx, {
    generatedAt: new Date(),
    generatedBy:
      plainOr(req.user?.name) || plainOr(req.user?.email) || plainOr(req.user?.uid) || "",
    createdByName: plainOr(tx.createdBy?.name) || plainOr(tx.createdBy?.uid) || "",
    clientName: plainOr(tx.client?.name) || plainOr(req.user?.client?.name) || "",
    branchName: plainOr(tx.branch?.name) || plainOr(req.user?.branch?.name) || "",
  });

  const safeName = String(tx.uid || tx._id).replace(/[^A-Za-z0-9._-]/g, "_");

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    // The document is fully self-contained (no remote images or fonts), so
    // waiting on the network only risks a 30s stall in the container.
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      // Without this every background — masthead, status pill, risk card,
      // zebra rows — prints white and the report loses its whole design.
      printBackground: true,
      // A page separated from the pack must still identify itself.
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%;font-size:7px;color:#8a8a8a;padding:0 12mm;' +
        'font-family:Helvetica,Arial,sans-serif;display:flex;justify-content:space-between;">' +
        `<span>Transaction ${escHtml(tx.uid || "")} &mdash; Confidential</span>` +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
        "</div>",
      margin: { top: "12mm", bottom: "16mm", left: "12mm", right: "12mm" },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Transaction_${safeName}.pdf"`);
    // Puppeteer 23+ returns a Uint8Array; Express JSON-serialises anything that
    // is not a Buffer, so an un-normalised body downloads as {"0":37,...}.
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    // The old handler swallowed this, which is why a container-only failure was
    // invisible in the logs. Keep the cause on the server, not in the response.
    console.error("[transaction:pdf] generation failed:", err);
    return next(new ErrorResponse("Error generating PDF", 500));
  } finally {
    if (browser) await browser.close().catch(() => {});
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
