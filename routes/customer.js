// routes/customers.js
const express = require("express");
const {
  createInvite,
  validateInvite,

  acceptInvite,
  filterCustomerSection,
  getCustomers,
  getCustomerStats,
  getCustomer,
  createCustomerDummy,
  getCompanyKycs,
  getCompanyKyc,
  getTrustKycs,
  getTrustKyc,
  getNonIndividualKycs,
  createInviteFromQr,
  downloadQR,
  getCustomerOnBoardData,
  submitCustomerOnboardRequest,
} = require("../controllers/customerController");

const { exportCustomers } = require("../controllers/customerExportController");
const { exportCustomerKycPdf } = require("../controllers/customerKycExportController");

const Customer = require("../models/Customer");
const advancedResults = require("../middleware/advancedResults");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const { protect, authorize } = require("../middleware/auth");
const advancedCustomerResultsQueryOnly = require("../middleware/advancedCustomerResultsQueryOnly");
const CompanyKyc = require("../models/CompanyKyc");
const TrustKyc = require("../models/TrustKyc");
const NonIndividualKyc = require("../models/NonIndividualKyc");
// Protect all routes and allow only authorized roles (adjust as needed)

router.route("/").get(
  protect,
  authorize("admin", "client", "branch", "manager", "officer"),
  advancedCustomerResultsQueryOnly({
    model: Customer,
    populate: [
      { path: "user", select: "name email userName photoUrl" },
      { path: "relations.client", select: "name" },
      { path: "relations.branch", select: "name" },
    ],
    searchFields: [
      "uid",
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
router.post(
  "/invite-from-qr",
  createInviteFromQr,
);
router.get(
  "/download-qr",
  protect,
  authorize("admin", "client", "branch", "user"),
  downloadQR,
);

// Analytics for the customer queue dashboard.
// Must be declared before the "/:id" route so "stats" isn't matched as an id.
router.get(
  "/stats",
  protect,
  authorize("admin", "client", "branch", "manager", "officer"),
  getCustomerStats,
);

// Professional Excel export of the customer queue (before "/:id").
router.get(
  "/export",
  protect,
  authorize("admin", "client", "branch", "manager", "officer"),
  exportCustomers,
);

// Sumsub-style per-customer KYC applicant report (PDF).
router.get(
  "/:id/kyc-export",
  protect,
  authorize("admin", "client", "branch", "manager", "officer"),
  exportCustomerKycPdf,
);




router
  .route("/:id")
  .get(protect, authorize("admin", "client", "branch"), getCustomer);
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
  "/company/all",
  protect,
  authorize("admin", "client", "branch"),
  advancedResults(CompanyKyc),
  getCompanyKycs
);
router.get(
  "/company/:id",
  protect,
  authorize("admin", "client", "branch"),

  getCompanyKyc
);

//Trust
router.get(
  "/trust/all",
  protect,
  authorize("admin", "client", "branch"),
  advancedResults(TrustKyc),
  getTrustKycs
);
router.get(
  "/trust/:id",
  protect,
  authorize("admin", "client", "branch"),

  getTrustKyc
);

router.get(
  "/non-individual/all",
  protect,
  authorize("admin", "client", "branch"),
  advancedResults(NonIndividualKyc),
  getNonIndividualKycs
);
// router.get(
//   "/non-individual/all",
//   protect,
//   authorize("admin", "client", "branch"),

//   getTrustKyc
// );

router.get(
  "/onboarding/:id",
  protect,
  authorize("customer"),

  getCustomerOnBoardData
);
router.put(
  "/onboarding/:id/request",
  protect,
  authorize("customer"),

  submitCustomerOnboardRequest
);
module.exports = router;
