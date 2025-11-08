// routes/transactions.js
const express = require("express");
const {
  createTransaction,
  getTransaction,
  getTransactions,
  updateTransaction,
  getTransactionStats,
} = require("../controllers/transactionController");

const { protect, authorize } = require("../middleware/auth"); // reuse your auth

const router = express.Router();

// Protect all transaction routes (adjust authorize roles as needed)
router.use(protect);

// List + create
router.route("/").get(getTransactions).post(createTransaction);

// stats
router.route("/stats").get(getTransactionStats);

// single tx
router.route("/:id").get(getTransaction).put(updateTransaction);

module.exports = router;
