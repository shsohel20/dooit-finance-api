const express = require("express");

const {
  recordUsage,
  recordUsageBulk,
  getUsage,
  getUsageSummary,
  getUsageReferences,
  reverseUsage,
} = require("../controllers/usageController");

const { protect, authorizeUserType } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "4mb" }));
router.use(protect);
// Express 5 leaves req.body UNDEFINED when a request carries no body (Express 4
// gave {}). Several handlers read req.body.<field> directly, so normalise once
// here rather than guarding at every call site.
router.use((req, _res, next) => {
  if (req.body == null) req.body = {};
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Metered usage.
//
// WRITES are dooit-only: the platform meters what a customer consumes; a client
// never self-reports its own usage. Internal producers (Sumsub webhooks, DVS
// calls, screening jobs) call these server-side.
//
// READS are open to clients, scoped by the controller to their own records —
// a customer must be able to see what they are being charged for.
// ─────────────────────────────────────────────────────────────────────────────

const dooitOnly = authorizeUserType("dooit");
const clientOrDooit = authorizeUserType("client", "branch");

// Static routes before /:id.
router.route("/summary").get(clientOrDooit, getUsageSummary);
// Pickers for the manual-entry form; dooit-only because only dooit records
// usage by hand, and it lists another company's records by design.
router.route("/references").get(dooitOnly, getUsageReferences);
router.route("/bulk").post(dooitOnly, recordUsageBulk);

router.route("/").get(clientOrDooit, getUsage).post(dooitOnly, recordUsage);

router.route("/:id/reverse").post(dooitOnly, reverseUsage);

module.exports = router;
