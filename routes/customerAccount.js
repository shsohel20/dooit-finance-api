// routes/customerAccounts.js
const express = require("express");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const {
  getCustomerAccounts,
  getCustomerAccount,
  getCustomerAccountByUid,
  createCustomerAccount,
  createDummyCustomerAccount,
  updateCustomerAccount,
  deleteCustomerAccount,
  addCardToAccount,
  removeCardFromAccount,
  changeAccountStatus,
} = require("../controllers/customerAccountController");

const CustomerAccount = require("../models/CustomerAccount");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

// Protect all routes
router.use(protect);

// list - limit fields or populate as required
router
  .route("/")
  .get(
    advancedResults(
      CustomerAccount,
      ["client", "branch", "customer", "createdBy"],
      null,
    ),
    authorize("admin", "operator"),
    getCustomerAccounts,
  )
  .post(authorize("admin", "operator"), createCustomerAccount);

// create dummy
router
  .route("/dummy")
  .post(authorize("admin", "operator"), createDummyCustomerAccount);

// status change
router
  .route("/:id/status")
  .put(authorize("admin", "operator"), changeAccountStatus);

// card operations
router
  .route("/:id/cards")
  .post(authorize("admin", "operator"), addCardToAccount);
router
  .route("/:id/cards/:cardId")
  .delete(authorize("admin", "operator"), removeCardFromAccount);

// CRUD
router
  .route("/uid/:uid")
  .get(authorize("admin", "operator"), getCustomerAccountByUid);
router
  .route("/:id")
  .get(authorize("admin", "operator"), getCustomerAccount)
  .put(authorize("admin", "operator"), updateCustomerAccount)
  .delete(authorize("admin"), deleteCustomerAccount); // only admin may delete

module.exports = router;
