// routes/transactions.js
const express = require("express");
const multer  = require("multer");

const {
  createTransaction,
  getTransaction,
  getTransactions,
  updateTransaction,
  getTransactionStats,
  createDummyTransaction,
  changeTransactionStatus,
  bulkChangeTransactionStatus,
  exportTransactionsCsv,
  importTransactionsCsv,
  downloadTransactionPdf,
} = require("../controllers/transactionController");

const { protect } = require("../middleware/auth");
const Transaction = require("../models/Transaction");
const transactionFilter = require("../middleware/transactionFilter");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

// multer — memory storage, CSV only, 5 MB max
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === "text/csv" || file.originalname.toLowerCase().endsWith(".csv");
    cb(ok ? null : new Error("Only .csv files are accepted"), ok);
  },
});

// Protect all transaction routes
router.use(protect);

// ── Collection endpoints ──────────────────────────────────────────────────────
router
  .route("/")
  .get(transactionFilter(Transaction), getTransactions)
  .post(createTransaction);

router.route("/new").post(createTransaction);
router.route("/dummy").post(createDummyTransaction);

// ── Stats ─────────────────────────────────────────────────────────────────────
router.route("/stats").get(getTransactionStats);

// ── Export / Import CSV (must be before /:id to avoid "export"/"import" as id)
router.route("/export/csv").get(exportTransactionsCsv);
router.route("/import/csv").post(upload.single("file"), importTransactionsCsv);

// ── Bulk status (before /:id for same reason) ────────────────────────────────
router.route("/status").put(bulkChangeTransactionStatus);

// ── Single transaction ────────────────────────────────────────────────────────
router.route("/:id").get(getTransaction).put(updateTransaction);
router.route("/:id/status").put(changeTransactionStatus);
router.route("/:id/pdf").get(downloadTransactionPdf);

module.exports = router;
