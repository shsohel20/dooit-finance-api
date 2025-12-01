// controllers/customerAccountController.js
const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const CustomerAccount = require("../models/CustomerAccount");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const Customer = require("../models/Customer");

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * GET list (assumes advancedResults middleware supplies res.advancedResults)
 * GET /api/v1/customer-accounts
 */
exports.getCustomerAccounts = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

/**
 * GET single by id
 * GET /api/v1/customer-accounts/:id
 */
exports.getCustomerAccount = asyncHandler(async (req, res, next) => {
  const account = await CustomerAccount.findById(req.params.id)
    .populate("client branch customer createdBy")
    .lean();

  if (!account) {
    return next(
      new ErrorResponse(`CustomerAccount not found: ${req.params.id}`, 404)
    );
  }

  res.status(200).json({ success: true, data: account });
});

/**
 * GET by uid
 * GET /api/v1/customer-accounts/uid/:uid
 */
exports.getCustomerAccountByUid = asyncHandler(async (req, res, next) => {
  const account = await CustomerAccount.findOne({ uid: req.params.uid })
    .populate("client branch customer createdBy")
    .lean();

  if (!account) {
    return next(
      new ErrorResponse(
        `CustomerAccount not found with uid ${req.params.uid}`,
        404
      )
    );
  }

  res.status(200).json({ success: true, data: account });
});

/**
 * Create new CustomerAccount
 * POST /api/v1/customer-accounts
 */
exports.createCustomerAccount = asyncHandler(async (req, res, next) => {
  const {
    client,
    branch,
    customer,
    accountType,
    accountNumber,
    accountName,
    currency,
    accountHolderName,
    metadata,
    linkedCards,
  } = req.body;

  // required
  if (!client || !accountType || !accountNumber) {
    return next(
      new ErrorResponse(
        "client, accountType and accountNumber are required",
        400
      )
    );
  }

  // validate ids
  if (!isValidId(client))
    return next(new ErrorResponse("Invalid client id", 400));
  if (branch && !isValidId(branch))
    return next(new ErrorResponse("Invalid branch id", 400));
  if (customer && !isValidId(customer))
    return next(new ErrorResponse("Invalid customer id", 400));

  // ensure client exists
  const clientDoc = await Client.findById(client).select("_id").lean();
  if (!clientDoc) return next(new ErrorResponse("Client not found", 404));

  // optional branch and customer existence checks
  if (branch) {
    const branchDoc = await Branch.findById(branch).select("_id").lean();
    if (!branchDoc) return next(new ErrorResponse("Branch not found", 404));
  }
  if (customer) {
    const customerDoc = await Customer.findById(customer).select("_id").lean();
    if (!customerDoc) return next(new ErrorResponse("Customer not found", 404));
  }

  // build payload
  const payload = {
    client,
    branch,
    customer,
    accountType,
    accountNumber,
    accountName,
    currency,
    accountHolderName,
    linkedCards,
    metadata,
    createdBy: req.user ? req.user._id : undefined,
  };

  const account = await CustomerAccount.create(payload);

  // append initial workflow history
  account.metadata = account.metadata || {};
  account.metadata.workflowHistory = account.metadata.workflowHistory || [];
  account.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created",
    notes: req.body.metadata?.notes || "Created via API",
  });
  await account.save();

  res.status(201).json({ success: true, data: account });
});

/**
 * Create dummy account
 * POST /api/v1/customer-accounts/dummy
 */
exports.createDummyCustomerAccount = asyncHandler(async (req, res, next) => {
  const {
    clientName,
    branchName,
    customerName,
    accountType = "savings",
    accountNumber,
    accountName = "Dummy Account",
    currency = "AUD",
  } = req.body;

  // minimal payload
  if (!accountNumber || !clientName) {
    return next(
      new ErrorResponse("clientName and accountNumber required for dummy", 400)
    );
  }

  // try to find client/branch/customer by name (falls back to null)
  const clientDoc = await Client.findOne({ name: clientName })
    .select("_id")
    .lean();
  const branchDoc = branchName
    ? await Branch.findOne({ name: branchName }).select("_id").lean()
    : null;
  const customerDoc = customerName
    ? await Customer.findOne({ name: customerName }).select("_id").lean()
    : null;

  if (!clientDoc)
    return next(new ErrorResponse("Client not found by name", 404));

  const payload = {
    client: clientDoc._id,
    branch: branchDoc ? branchDoc._id : undefined,
    customer: customerDoc ? customerDoc._id : undefined,
    accountType,
    accountNumber,
    accountName,
    currency,
    accountHolderName: customerName || undefined,
    metadata: { createdBy: req.user?.id, isDummy: true },
    createdBy: req.user ? req.user._id : undefined,
  };

  const account = await CustomerAccount.create(payload);

  account.metadata = account.metadata || {};
  account.metadata.workflowHistory = account.metadata.workflowHistory || [];
  account.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created_dummy",
    notes: `Dummy created for ${accountNumber}`,
  });
  await account.save();

  res.status(201).json({ success: true, data: account });
});

/**
 * Update account (partial)
 * PUT /api/v1/customer-accounts/:id
 */
exports.updateCustomerAccount = asyncHandler(async (req, res, next) => {
  // allowed updates (you can modify list)
  const allowed = [
    "accountType",
    "accountName",
    "accountNumber",
    "currency",
    "accountHolderName",
    "accountHolderContact",
    "balance",
    "availableBalance",
    "overdraftLimit",
    "dailyLimit",
    "monthlyLimit",
    "accountStatus",
    "isActive",
    "tags",
    "flags",
    "metadata",
  ];

  const updates = {};
  allowed.forEach((k) => {
    if (typeof req.body[k] !== "undefined") updates[k] = req.body[k];
  });

  if (Object.keys(updates).length === 0) {
    return next(new ErrorResponse("No updatable fields provided", 400));
  }

  const account = await CustomerAccount.findByIdAndUpdate(
    req.params.id,
    updates,
    {
      new: true,
      runValidators: true,
    }
  );

  if (!account)
    return next(new ErrorResponse("CustomerAccount not found", 404));

  // workflow
  account.metadata = account.metadata || {};
  account.metadata.workflowHistory = account.metadata.workflowHistory || [];
  account.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "updated",
    notes: req.body.metadata?.notes || "Updated via API",
  });
  await account.save();

  res.status(200).json({ success: true, data: account });
});

/**
 * Delete account
 * DELETE /api/v1/customer-accounts/:id
 */
exports.deleteCustomerAccount = asyncHandler(async (req, res, next) => {
  const account = await CustomerAccount.findById(req.params.id);
  if (!account)
    return next(new ErrorResponse("CustomerAccount not found", 404));

  await account.deleteOne();
  res.status(200).json({ success: true, data: req.params.id });
});

/**
 * Add a card to account
 * POST /api/v1/customer-accounts/:id/cards
 * body: { last4, brand, expiryMonth, expiryYear, issuedAt, status, tokenMasked }
 */
exports.addCardToAccount = asyncHandler(async (req, res, next) => {
  const account = await CustomerAccount.findById(req.params.id);
  if (!account)
    return next(new ErrorResponse("CustomerAccount not found", 404));

  const {
    last4,
    brand,
    expiryMonth,
    expiryYear,
    issuedAt,
    status = "active",
    tokenMasked,
    metadata,
  } = req.body;

  if (!last4) return next(new ErrorResponse("last4 is required for card", 400));

  // generate simple cardId
  const cardId = `CARD_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const card = {
    cardId,
    last4,
    brand,
    expiryMonth,
    expiryYear,
    issuedAt,
    status,
    tokenMasked,
    metadata,
  };

  account.linkedCards = account.linkedCards || [];
  account.linkedCards.push(card);

  // add workflow entry
  account.metadata = account.metadata || {};
  account.metadata.workflowHistory = account.metadata.workflowHistory || [];
  account.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "card_added",
    notes: `Card ${cardId} added`,
  });

  await account.save();

  res.status(201).json({ success: true, data: account, card });
});

/**
 * Remove card by cardId
 * DELETE /api/v1/customer-accounts/:id/cards/:cardId
 */
exports.removeCardFromAccount = asyncHandler(async (req, res, next) => {
  const { id, cardId } = req.params;
  const account = await CustomerAccount.findById(id);
  if (!account)
    return next(new ErrorResponse("CustomerAccount not found", 404));

  const before = (account.linkedCards || []).length;
  account.linkedCards = (account.linkedCards || []).filter(
    (c) => c.cardId !== cardId
  );

  if (account.linkedCards.length === before) {
    return next(new ErrorResponse("Card not found on account", 404));
  }

  account.metadata = account.metadata || {};
  account.metadata.workflowHistory = account.metadata.workflowHistory || [];
  account.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "card_removed",
    notes: `Card ${cardId} removed`,
  });

  await account.save();

  res.status(200).json({ success: true, data: account });
});

/**
 * Change account status (with simple allowed transitions)
 * PUT /api/v1/customer-accounts/:id/status
 * body: { status: "suspended", notes: "fraud detected" }
 */
const ALLOWED_ACCOUNT_TRANSITIONS = {
  active: ["suspended", "closed", "pending"],
  suspended: ["active", "closed"],
  pending: ["active", "closed"],
  closed: [], // final
};

exports.changeAccountStatus = asyncHandler(async (req, res, next) => {
  const account = await CustomerAccount.findById(req.params.id);
  if (!account)
    return next(new ErrorResponse("CustomerAccount not found", 404));

  const { status: newStatus, notes } = req.body;
  if (!newStatus) return next(new ErrorResponse("Missing status in body", 400));

  const from = account.accountStatus || "active";
  const allowed = ALLOWED_ACCOUNT_TRANSITIONS[from] || [];

  if (newStatus !== from && !allowed.includes(newStatus)) {
    return next(
      new ErrorResponse(`Invalid transition ${from} -> ${newStatus}`, 400)
    );
  }

  account.accountStatus = newStatus;
  if (newStatus === "closed") {
    account.closedAt = new Date();
    account.isActive = false;
  } else if (newStatus === "active") {
    account.isActive = true;
  }

  account.metadata = account.metadata || {};
  account.metadata.workflowHistory = account.metadata.workflowHistory || [];
  account.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "status_change",
    fromStatus: from,
    toStatus: newStatus,
    notes: notes || "",
  });

  await account.save();

  res.status(200).json({ success: true, data: account });
});
