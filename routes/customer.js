// routes/customers.js
const express = require("express");
const {
  createInvite,
  validateInvite,

  acceptInvite,
  filterCustomerSection,
  getCustomers,
  getCustomer,
  createCustomerDummy,
  getCompanyKycs,
} = require("../controllers/customerController");

const Customer = require("../models/Customer");
const advancedResults = require("../middleware/advancedResults");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const { protect, authorize } = require("../middleware/auth");
const advancedCustomerResultsQueryOnly = require("../middleware/advancedCustomerResultsQueryOnly");
// Protect all routes and allow only authorized roles (adjust as needed)

router.route("/").get(
  protect,
  authorize("admin", "client", "branch"),
  advancedCustomerResultsQueryOnly({
    populate: [
      { path: "user", select: "name email userName photoUrl" },
      { path: "relations.client", select: "name" },
      { path: "relations.branch", select: "name" },
    ],
    searchFields: [
      "user.name",
      "user.email",
      "personalKyc.personal_form.customer_details.given_name",
      "personalKyc.personal_form.customer_details.surname",
    ],
  }),
  getCustomers,
);

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
router.post(
  "/dummy-create",

  createCustomerDummy,
);


///Company:
router.get(
  "/company",
  protect,
  authorize("admin", "client", "branch"),
  advancedCustomerResultsQueryOnly({
    populate: [
      { path: "user", select: "name email userName photoUrl" },
      { path: "relations.client", select: "name" },
      { path: "relations.branch", select: "name" },
    ],
    searchFields: [
      "companyName",
      "email",
      "registrationNumber",
      "contactPerson.name",
    ],
  }),
  getCompanyKycs
);

module.exports = router;
