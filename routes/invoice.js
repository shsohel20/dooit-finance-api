const express = require("express");

const {
  getInvoices,
  getInvoice,
  previewInvoice,
  closePeriod,
  issueInvoice,
  voidInvoice,
  markPaid,
  sweepOverdue,
  sendInvoice,
  downloadInvoicePdf,
} = require("../controllers/invoiceController");

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
// Invoices.
//
// READS are open to clients, scoped by the controller to their own invoices —
// a customer must be able to see what they are being billed.
//
// WRITES are dooit-only: closing a period, issuing, voiding and settling are
// platform operations. A client never produces its own invoice.
// ─────────────────────────────────────────────────────────────────────────────

const dooitOnly = authorizeUserType("dooit");
const clientOrDooit = authorizeUserType("client", "branch");

// Static routes before /:id.
router.route("/preview").get(clientOrDooit, previewInvoice);
router.route("/close").post(dooitOnly, closePeriod);
router.route("/sweep-overdue").post(dooitOnly, sweepOverdue);

router.route("/").get(clientOrDooit, getInvoices);

router.route("/:id/issue").post(dooitOnly, issueInvoice);
router.route("/:id/void").post(dooitOnly, voidInvoice);
router.route("/:id/mark-paid").post(dooitOnly, markPaid);
// Sending is dooit-only — it is the platform that invoices the customer.
router.route("/:id/send").post(dooitOnly, sendInvoice);
// The PDF is the same document either party reads, so a client may fetch its
// own; the controller scopes it.
router.route("/:id/pdf").get(clientOrDooit, downloadInvoicePdf);

router.route("/:id").get(clientOrDooit, getInvoice);

module.exports = router;
