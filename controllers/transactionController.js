// controllers/transactionController.js
const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Transaction = require("../models/Transaction");
const Customer = require("../models/Customer");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const User = require("../models/User");

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
    "customer client branch createdBy"
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
    receiver,
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

// @desc Simple stats: sum, count grouped by status or currency (basic)
// @route GET /api/v1/transactions/stats
// @access Protected
exports.getTransactionStats = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Transactions']
  #swagger.summary = 'Get Stats'
  #swagger.security = [{ "BearerAuth": [] }]
 
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
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
