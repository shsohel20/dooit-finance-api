// routes/ruleEngine.js
//
// Renamed from `clientRules.js` — see models/RuleEngine.js for context.
const express = require("express");
const {
  getRules,
  getRulesPost,
  createRule,
  getRule,
  updateRule,
  deleteRule,
  exportRulesCsv,
  importRulesCsv,
  getRuleDomains,
  toggleRuleVisibility,
} = require("../controllers/ruleEngineController");
const upload = require("../middleware/upload");

const ruleEngineResults = require("../middleware/ruleEngineResults");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

// Protect all routes
router.use(protect);
router.use(
  authorizePermission(
    "CLIENT_RULE.GET",
    "CLIENT_RULE.ADD",
    "CLIENT_RULE.EDIT",
    "CLIENT_RULE.DELETE",
  ),
);

// List rules — GET and POST both go through the same results middleware.
// POST body is ignored for filtering (all params are in the query string);
// the POST variant is kept for backward-compat with any clients that POST.
router
  .route("/")
  .get(ruleEngineResults, getRules)
  .post(ruleEngineResults, getRulesPost);

// Create rule
router.route("/new").post(createRule);

// Distinct domain/subdomain values (for filter dropdowns)
router.get("/domains", getRuleDomains);

// Import / Export
router.get("/export", exportRulesCsv);
router.post("/import", upload.single("file"), importRulesCsv);

// CRUD by id
router
  .route("/:id")
  .get(getRule)
  .put(updateRule)
  .delete(deleteRule);

// Toggle visibleToClients — dooit only, system rules only
router.patch("/:id/visibility", toggleRuleVisibility);

module.exports = router;
