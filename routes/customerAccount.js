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
const { protect, authorizePermission } = require("../middleware/auth");

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
    authorizePermission("CUSTOMER_ACCOUNT.GET"),
    getCustomerAccounts,
  )
  .post(authorizePermission("CUSTOMER_ACCOUNT.ADD"), createCustomerAccount);

// create dummy
router
  .route("/dummy")
  .post(authorizePermission("CUSTOMER_ACCOUNT.ADD"), createDummyCustomerAccount);

// status change
router
  .route("/:id/status")
  .put(authorizePermission("CUSTOMER_ACCOUNT.EDIT"), changeAccountStatus);

// card operations
router
  .route("/:id/cards")
  .post(authorizePermission("CUSTOMER_ACCOUNT.EDIT"), addCardToAccount);
router
  .route("/:id/cards/:cardId")
  .delete(authorizePermission("CUSTOMER_ACCOUNT.EDIT"), removeCardFromAccount);

// CRUD
router
  .route("/uid/:uid")
  .get(authorizePermission("CUSTOMER_ACCOUNT.GET"), getCustomerAccountByUid);
router
  .route("/:id")
  .get(authorizePermission("CUSTOMER_ACCOUNT.GET"), getCustomerAccount)
  .put(authorizePermission("CUSTOMER_ACCOUNT.EDIT"), updateCustomerAccount)
  .delete(authorizePermission("CUSTOMER_ACCOUNT.DELETE"), deleteCustomerAccount);

module.exports = router;
