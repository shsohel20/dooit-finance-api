// controllers/transactionController.js
const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Transaction = require("../models/Transaction");
const Customer = require("../models/Customer");
const Client = require("../models/Client");

// Helper: validate ObjectId
function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// @desc Create a transaction
// @route POST /api/v1/transactions
// @access Protected (client/branch user)
exports.createTransaction = asyncHandler(async (req, res, next) => {
  const {
    transactionId,
    customer,
    client,
    branch,
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
    bullion,
    metadata,
  } = req.body;

  // required fields
  if (!amount || !currency) {
    return next(new ErrorResponse("amount and currency are required", 400));
  }

  // If provided, validate ids
  if (customer && !isValidId(customer))
    return next(new ErrorResponse("Invalid customer id", 400));
  if (client && !isValidId(client))
    return next(new ErrorResponse("Invalid client id", 400));
  if (branch && !isValidId(branch))
    return next(new ErrorResponse("Invalid branch id", 400));

  // Optionally, check existence of related docs (cheap check)
  if (customer) {
    const c = await Customer.findById(customer).select("_id");
    if (!c) return next(new ErrorResponse("Customer not found", 404));
  }
  if (client) {
    const cl = await Client.findById(client).select("_id");
    if (!cl) return next(new ErrorResponse("Client not found", 404));
  }

  // Build payload
  const payload = {
    transactionId,
    customer,
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

// @desc Get single transaction
// @route GET /api/v1/transactions/:id
// @access Protected
exports.getTransaction = asyncHandler(async (req, res, next) => {
  const loggedInUser = req.user;
  const tx = await Transaction.findById(req.params.id).populate(
    "customer client branch createdBy"
  );
  if (!tx)
    return next(
      new ErrorResponse(`Transaction not found ${req.params.id}`, 404)
    );
  res.status(200).json({ success: true, data: tx });
});

// @desc List transactions (filter + pagination + simple text search)
// @route GET /api/v1/transactions
// @access Protected
exports.getTransactions = asyncHandler(async (req, res, next) => {
  const {
    page = 1,
    limit = 25,
    customer,
    client,
    branch,
    status,
    type,
    currency,
    date_from,
    date_to,
    min_amount,
    max_amount,
    search,
    sort = "-timestamp",
  } = req.query;

  const q = {};

  if (customer && isValidId(customer)) q.customer = customer;
  if (client && isValidId(client)) q.client = client;
  if (branch && isValidId(branch)) q.branch = branch;
  if (status) q.status = status;
  if (type) q.type = type;
  if (currency) q.currency = currency.toUpperCase();
  if (min_amount || max_amount) q.amount = {};
  if (min_amount) q.amount.$gte = Number(min_amount);
  if (max_amount) q.amount.$lte = Number(max_amount);
  if (date_from || date_to) q.timestamp = {};
  if (date_from) q.timestamp.$gte = new Date(date_from);
  if (date_to) q.timestamp.$lte = new Date(date_to);

  let mongoQuery = Transaction.find(q);

  // Text search (reference or narrative)
  if (search && String(search).trim().length) {
    mongoQuery = Transaction.find({ $text: { $search: search }, ...q });
  }

  // Pagination
  const pageNum = parseInt(page, 10);
  const pageSize = Math.min(parseInt(limit, 10) || 25, 200);

  const total = await Transaction.countDocuments(
    search ? { $text: { $search: search }, ...q } : q
  );
  const skip = (pageNum - 1) * pageSize;

  const results = await mongoQuery
    .sort(sort)
    .skip(skip)
    .limit(pageSize)
    .lean()
    .exec();

  res.status(200).json({
    success: true,
    count: results.length,
    total,
    page: pageNum,
    pageSize,
    data: results,
  });
});

// @desc Update transaction status or partial update
// @route PUT /api/v1/transactions/:id
// @access Protected (admin/operator)
exports.updateTransaction = asyncHandler(async (req, res, next) => {
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

// @desc Simple stats: sum, count grouped by status or currency (basic)
// @route GET /api/v1/transactions/stats
// @access Protected
exports.getTransactionStats = asyncHandler(async (req, res, next) => {
  const { client, branch, date_from, date_to } = req.query;
  const match = {};
  if (client && isValidId(client))
    match.client = mongoose.Types.ObjectId(client);
  if (branch && isValidId(branch))
    match.branch = mongoose.Types.ObjectId(branch);
  if (date_from || date_to) match.timestamp = {};
  if (date_from) match.timestamp.$gte = new Date(date_from);
  if (date_to) match.timestamp.$lte = new Date(date_to);

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: { status: "$status", currency: "$currency" },
        totalAmount: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
    { $limit: 1000 },
  ];

  const stats = await Transaction.aggregate(pipeline);
  res.status(200).json({ success: true, data: stats });
});
