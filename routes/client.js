// routes/client.js
const express = require("express");
const {
  getClients,
  createClient,
  getClient,
  updateClient,
  deleteClient,
  filterClientSection,
  updateClientStatus,
  getRiskQuestionsSchema,
  updateRiskQuestions,
  getClientBySlug,
  createDummyClient,
  downloadQR,
  sendClientWelcomeEmail,
  sendClientPasswordReset,
} = require("../controllers/clientController");

const Client = require("../models/Client");
const advancedResults = require("../middleware/advancedResults");
const {
  protect,
  authorizeUserType,
  authorizePermission,
} = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

// ── Public ────────────────────────────────────────────────────────────────────
router.route("/public/:id").get(getClient);

// ── All routes below require a valid JWT ─────────────────────────────────────
router.use(protect);

// ── Risk-questions schema (client reads their own; dooit reads any) ───────────
router
  .route("/risk-questions/schema")
  .get(
    authorizeUserType("client", "branch"),
    authorizePermission("CLIENT.GET"),
    getRiskQuestionsSchema
  );

// ── List clients ──────────────────────────────────────────────────────────────
// dooit  → sees all clients (advancedResults has no client-scope on Client model)
// client → sees only their own (advancedResults scopes by req.user.client)
router
  .route("/")
  .get(
    authorizeUserType("dooit"),          // dooit implicit bypass
    authorizePermission("CLIENT.GET"),
    advancedResults(Client, "branches"),
    getClients
  )
  .post(
    authorizeUserType("dooit"),
    authorizePermission("CLIENT.GET"),
    advancedResults(Client, null, filterClientSection),
    getClients
  );

// ── Create client (platform-level: dooit only) ────────────────────────────────
router
  .route("/new")
  .post(
    authorizeUserType("dooit"),           // only platform admins create clients
    authorizePermission("CLIENT.ADD"),
    createClient
  );

// ── Update client status ──────────────────────────────────────────────────────
router
  .route("/update-status/:id")
  .put(
    authorizeUserType("dooit"),
    authorizePermission("CLIENT.EDIT"),
    updateClientStatus
  );

// ── Resend onboarding emails (platform-level: dooit only) ─────────────────────
router
  .route("/:id/send-welcome")
  .post(
    authorizeUserType("dooit"),
    authorizePermission("CLIENT.EDIT"),
    sendClientWelcomeEmail
  );

router
  .route("/:id/send-password-reset")
  .post(
    authorizeUserType("dooit"),
    authorizePermission("CLIENT.EDIT"),
    sendClientPasswordReset
  );

// ── Risk questions (client updates their own; dooit updates any) ──────────────
router
  .route("/:id/risk-questions")
  .put(
    authorizeUserType("client"),
    authorizePermission("CLIENT.EDIT"),
    updateRiskQuestions
  );

// ── CRUD by id ────────────────────────────────────────────────────────────────
router
  .route("/:id")
  .get(
    authorizeUserType("dooit", "client"),
    authorizePermission("CLIENT.GET"),
    getClient
  )
  .put(
    authorizeUserType("dooit", "client"),
    authorizePermission("CLIENT.EDIT"),
    updateClient
  )
  .delete(
    authorizeUserType("dooit"),           // only platform admins delete clients
    authorizePermission("CLIENT.DELETE"),
    deleteClient
  );

// ── By slug ───────────────────────────────────────────────────────────────────
router
  .route("/slug/:slug")
  .get(
    authorizeUserType("dooit", "client"),
    authorizePermission("CLIENT.GET"),
    getClientBySlug
  );

// ── Dummy data (platform-level seeding: dooit only) ───────────────────────────
router
  .route("/dummy/create")
  .post(
    // authorizeUserType("dooit"),
    // authorizePermission("CLIENT.ADD"),
    createDummyClient
  );

module.exports = router;
