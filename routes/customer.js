// routes/customers.js
const express = require("express");
const {
  createInvite,
  validateInvite,

  acceptInvite,
  filterCustomerSection,
  getCustomers,
  getCustomer,
} = require("../controllers/customerController");

const { protect, authorize } = require("../middleware/auth");
const Customer = require("../models/Customer");
const advancedResults = require("../middleware/advancedResults");

const router = express.Router();

// Protect all routes and allow only authorized roles (adjust as needed)

router
  .route("/", protect, authorize("admin", "client", "branch"))
  .post(advancedResults(Customer, "user"), getCustomers)
  .get(advancedResults(Customer, "user"), getCustomers);

// protect: only client/admin can create invites
router.post(
  "/invite",
  protect,
  authorize("admin", "client", "branch", "user"),
  createInvite,
);

router
  .route("/:id", protect, authorize("admin", "client", "branch"))
  .get(getCustomer);
// .put(updateClient)
// .delete(deleteClient);

// public endpoints (token validation, registration from invite)
router.get("/invite/validate", validateInvite);

router.post(
  "/register/onboarding",
  protect,
  authorize("customer"),
  acceptInvite,
);

module.exports = router;
