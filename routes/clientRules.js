// routes/clientRules.js
const express = require("express");
const {
    getClientRules,
    getClientRulesPost,
    createClientRule,
    getClientRule,
    updateClientRule,
    deleteClientRule,
    filterClientRuleSection,
} = require("../controllers/clientRuleController");

const ClientRule = require("../models/ClientRule");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Protect all routes
router.use(protect);
router.use(authorize("admin"));

// List rules
router
    .route("/")
    .post(
        advancedResults(
            ClientRule,
            ["client", "branch"],
            filterClientRuleSection
        ),
        getClientRulesPost
    )
    .get(advancedResults(ClientRule, ["client", "branch"]), getClientRules);

// Create rule
router.route("/new").post(createClientRule);

// CRUD by id
router
    .route("/:id")
    .get(getClientRule)
    .put(updateClientRule)
    .delete(deleteClientRule);

module.exports = router;
