const express = require("express");

const {
  getSubscriptions,
  getCurrentSubscription,
  getSubscription,
  createSubscription,
  changePlan,
  cancelSubscription,
  resumeSubscription,
  pauseSubscription,
  updateDiscount,
} = require("../controllers/subscriptionController");

const { protect, authorizeUserType } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use(protect);
// Express 5 leaves req.body UNDEFINED when a request carries no body (Express 4
// gave {}). Several handlers read req.body.<field> directly — e.g. a POST with no
// payload — so normalise once here rather than guarding at every call site.
router.use((req, _res, next) => {
  if (req.body == null) req.body = {};
  next();
});


// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions — the one billing collection a CLIENT writes to.
//
// A client may subscribe, change plan, cancel and resume, but only for itself:
// the controller pins `user` from the JWT and never from the request body, so
// there is no route-level way to act on someone else's subscription.
//
// dooit passes every authorizeUserType check unconditionally
// (middleware/auth.js:199), so it can provision and manage any account.
// `pause` is the exception — explicitly dooit-only, because suspending a
// customer's AML cover is a platform decision, not a self-service one.
// ─────────────────────────────────────────────────────────────────────────────

const clientOrDooit = authorizeUserType("client", "branch");
const dooitOnly = authorizeUserType("dooit");

// Static route before /:id, or "current" is parsed as a subscription id.
router.route("/current").get(clientOrDooit, getCurrentSubscription);

router
  .route("/")
  .get(clientOrDooit, getSubscriptions)
  .post(clientOrDooit, createSubscription);

router.route("/:id/change-plan").post(clientOrDooit, changePlan);
router.route("/:id/cancel").post(clientOrDooit, cancelSubscription);
router.route("/:id/resume").post(clientOrDooit, resumeSubscription);
router.route("/:id/pause").post(dooitOnly, pauseSubscription);
// A concession on price is a commercial decision, like pause — never self-service.
router.route("/:id/discount").patch(dooitOnly, updateDiscount);

router.route("/:id").get(clientOrDooit, getSubscription);

module.exports = router;
