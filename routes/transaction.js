// routes/transactions.js
const express = require("express");
const {
  createTransaction,
  getTransaction,
  getTransactions,
  updateTransaction,
  getTransactionStats,
  createDummyTransaction,
} = require("../controllers/transactionController");

const { protect, authorize } = require("../middleware/auth"); // reuse your auth
const Transaction = require("../models/Transaction");
const advancedResults = require("../middleware/advancedResults");

const router = express.Router();

// Protect all transaction routes (adjust authorize roles as needed)
router.use(protect);

// List + create
router
  .route("/")
  .post(advancedResults(Transaction), getTransactions)
  .get(advancedResults(Transaction, "customer"), getTransactions);

router.route("/new").post(createTransaction);
router.route("/dummy").post(createDummyTransaction);

// stats
router.route("/stats").get(getTransactionStats);

// single tx
router.route("/:id").get(getTransaction).put(updateTransaction);

module.exports = router;
