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
  getClientBySlug,
} = require("../controllers/clientController");

const Client = require("../models/Client");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// protect all client routes and allow only admin by default
router.use(protect);
router.use(authorize("admin", "client"));

// list (supports GET with query params and POST with body-filter via advancedResults)
router
  .route("/")
  .post(advancedResults(Client, null, filterClientSection), getClients)
  .get(advancedResults(Client), getClients);

// create new client
router.route("/new").post(createClient);

// update client status (active/pending/blocked etc.)
router.route("/update-status/:id").put(updateClientStatus);

// CRUD by id
router.route("/:id").get(getClient).put(updateClient).delete(deleteClient);

// get by slug
router.route("/slug/:slug").get(getClientBySlug);

module.exports = router;
