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
  // merged in from the former per-concern customer controllers
  exportCustomers,
  exportCustomerKycPdf,
  updateCustomerKycStatus,
  reviewJourneyStep,
  addCustomerDocuments,
  removeCustomerDocument,
  manualImportCustomer,
} = require("../controllers/customerController");

const Customer = require("../models/Customer");
const advancedResults = require("../middleware/advancedResults");

const router = express.Router();

const { protect, authorize } = require("../middleware/auth");

// Staff-side manual import of an individual customer (in-branch onboarding).
// Registered BEFORE the router-level 100kb json parser — signature images
// (base64 data-URIs) in the declaration need a larger body limit.
router.post(
  "/manual-import",
  express.json({ limit: "5mb" }),
  protect,
  authorize("admin", "client", "branch", "manager", "officer"),
  manualImportCustomer,
);

router.use(express.json({ limit: "100kb" }));
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

// Manual KYC decision (approve / reject / status change) with audit note.
router.patch(
  "/:id/kyc-status",
  protect,
  authorize("admin", "client", "branch", "manager", "officer"),
  updateCustomerKycStatus,
);

// Manual approve/reject of a single verification journey step (e.g. ID Document).
router.patch(
  "/:id/journeys/:journeyId/steps/:stepType/review",
  protect,
  authorize("admin", "client", "branch", "manager", "officer"),
  reviewJourneyStep,
);

// Reviewer-side customer documents (Documents tab): add / remove by URL.
router
  .route("/:id/documents")
  .post(
    protect,
    authorize("admin", "client", "branch", "manager", "officer"),
    addCustomerDocuments,
  )
  .delete(
    protect,
    authorize("admin", "client", "branch", "manager", "officer"),
    removeCustomerDocument,
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
