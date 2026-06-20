// routes/clients.js
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
} = require("../controllers/clientController");

const Client = require("../models/Client");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

router.route("/public/:id").get(getClient);

// protect all client routes; authorization is applied per-route below
router.use(protect);

// schema endpoint — protected; hydrates field values from req.user.client automatically
router.route("/risk-questions/schema").get(getRiskQuestionsSchema);

// list (supports GET with query params and POST with body-filter via advancedResults)
router
  .route("/")
  .post(
    authorize("admin"),
    advancedResults(Client, null, filterClientSection),
    getClients
  )
  .get(
    authorize("admin"),
    advancedResults(Client, "branches"),
    getClients
  );

// create new client
router.route("/new").post(authorize("admin"), createClient);

// update client status (active/pending/blocked etc.)
router
  .route("/update-status/:id")
  .put(authorize("admin"), updateClientStatus);

// merge questionnaire answers into riskQuestions
router
  .route("/:id/risk-questions")
  .put(authorize("admin", "client"), updateRiskQuestions);

// CRUD by id
router
  .route("/:id")
  .get(authorize("admin", "client"), getClient)
  .put(authorize("admin", "client"), updateClient)
  .delete(authorize("admin"), deleteClient);

// get by slug
router.route("/slug/:slug").get(authorize("admin", "client"), getClientBySlug);

router.route("/dummy/create").post(authorize("admin"), createDummyClient);

module.exports = router;
