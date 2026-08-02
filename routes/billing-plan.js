const express = require("express");

const {
  getPlans,
  getPlanMeta,
  getPlan,
  createPlan,
  updatePlan,
  publishPlan,
  createNewVersion,
  archivePlan,
  deletePlan,
  getGrantableClients,
  getEligibility,
  grantEligibility,
  revokeEligibility,
} = require("../controllers/billingPlanController");

const { protect, authorizeUserType } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(protect);
// Express 5 leaves req.body UNDEFINED when a request carries no body (Express 4
// gave {}). Several handlers read req.body.<field> directly — e.g. a POST with no
// payload — so normalise once here rather than guarding at every call site.
router.use((req, _res, next) => {
  if (req.body == null) req.body = {};
  next();
});


// ─────────────────────────────────────────────────────────────────────────────
// Billing plans.
//
// READS are open to any authenticated user, but the controller scopes what a
// client can see: published plans that are either public or granted to them via
// planEligibility. A client who guesses a planId still gets 404.
//
// WRITES are dooit-only. `authorizeUserType("dooit")` is the dooit-ONLY form —
// note that adding more types would only WIDEN access, since the middleware
// lets dooit through unconditionally (middleware/auth.js:199).
//
// The controller re-asserts the acting userType, so a mis-wired route here
// cannot by itself open a write path.
// ─────────────────────────────────────────────────────────────────────────────

const dooitOnly = authorizeUserType("dooit");

router.route("/").get(getPlans).post(dooitOnly, createPlan);

// Static route before /:id, or "meta" is parsed as a plan id.
router.route("/meta").get(getPlanMeta);
router.route("/clients").get(dooitOnly, getGrantableClients);

// Lifecycle transitions are POSTs to named sub-routes rather than a PATCH on
// `status`: each has its own validation and side effects (publish archives the
// previous version; archive does not), so they are not interchangeable writes.
router.route("/:id/publish").post(dooitOnly, publishPlan);
router.route("/:id/new-version").post(dooitOnly, createNewVersion);
router.route("/:id/archive").post(dooitOnly, archivePlan);

router
  .route("/:id/eligibility")
  .get(dooitOnly, getEligibility)
  .post(dooitOnly, grantEligibility);
router.route("/:id/eligibility/:userId").delete(dooitOnly, revokeEligibility);

router
  .route("/:id")
  .get(getPlan)
  .put(dooitOnly, updatePlan)
  .delete(dooitOnly, deletePlan);

module.exports = router;
