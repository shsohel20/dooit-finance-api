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
  backtestRule,
} = require("../controllers/ruleEngineController");
const upload = require("../middleware/upload");

const ruleEngineResults = require("../middleware/ruleEngineResults");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

// Protect all routes
router.use(protect);

// authorizePermission passes when the user holds ANY of the listed perms, so
// each verb gets its own guard — holding CLIENT_RULE.GET alone must not
// authorize create/update/delete.
const canRead = authorizePermission(
  "CLIENT_RULE.GET",
  "CLIENT_RULE.ADD",
  "CLIENT_RULE.EDIT",
  "CLIENT_RULE.DELETE",
);
const canCreate = authorizePermission("CLIENT_RULE.ADD");
const canEdit   = authorizePermission("CLIENT_RULE.EDIT");
const canDelete = authorizePermission("CLIENT_RULE.DELETE");

// List rules — GET and POST both go through the same results middleware.
// POST body is ignored for filtering (all params are in the query string);
// the POST variant is kept for backward-compat with any clients that POST.
router
  .route("/")
  .get(canRead, ruleEngineResults, getRules)
  .post(canRead, ruleEngineResults, getRulesPost);

// Create rule
router.route("/new").post(canCreate, createRule);

// Distinct domain/subdomain/category values (for filter + creatable dropdowns)
router.get("/domains", canRead, getRuleDomains);

// Import / Export — import upserts rules, so it needs create rights
router.get("/export", canRead, exportRulesCsv);
router.post("/import", canCreate, upload.single("file"), importRulesCsv);

// Backtest — read-only replay of a rule against historical transactions
router.post("/backtest", canRead, backtestRule);

// CRUD by id
router
  .route("/:id")
  .get(canRead, getRule)
  .put(canEdit, updateRule)
  .delete(canDelete, deleteRule);

// Toggle visibleToClients — dooit only, system rules only
router.patch("/:id/visibility", canEdit, toggleRuleVisibility);

module.exports = router;
