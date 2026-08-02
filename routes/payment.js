const express = require("express");

const {
  getPayments,
  getPayment,
  recordPayment,
  retryPayment,
  refundPayment,
  getInvoicePayments,
} = require("../controllers/paymentController");

const { protect, authorizeUserType } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use(protect);
// Express 5 leaves req.body UNDEFINED when a request carries no body.
router.use((req, _res, next) => {
  if (req.body == null) req.body = {};
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Payments and refunds.
//
// READS are open to clients, scoped to their own payment history.
//
// WRITES are dooit-only. Without a payment gateway, a client-initiated "Pay now"
// would record money movement that never happened — when a gateway lands, its
// webhook becomes the writer and this stays the manual/reconciliation path.
// ─────────────────────────────────────────────────────────────────────────────

const dooitOnly = authorizeUserType("dooit");
const clientOrDooit = authorizeUserType("client", "branch");

// Static route before /:id.
router.route("/for-invoice/:invoiceId").get(clientOrDooit, getInvoicePayments);

router.route("/").get(clientOrDooit, getPayments).post(dooitOnly, recordPayment);

router.route("/:id/retry").post(dooitOnly, retryPayment);
router.route("/:id/refund").post(dooitOnly, refundPayment);

router.route("/:id").get(clientOrDooit, getPayment);

module.exports = router;
