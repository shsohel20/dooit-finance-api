const express = require("express");
const {
    getPolicyHubs,
    getPolicyHubsPost,
    createPolicyHub,
    getPolicyHub,
    updatePolicyHub,
    deletePolicyHub,
    filterPolicyHubSection,
    downloadPolicyHubPDF,
    generatePolicyHub,
    listPolicyHubVersions,
    getPolicyHubVersion,
    restorePolicyHubVersion,
    diffPolicyHubVersions,
} = require("../controllers/policyHubController");

const PolicyHub = require("../models/PolicyHub");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Protect all routes
router.use(protect);
router.use(authorize("admin"));

// List PolicyHubs
router
    .route("/")
    .post(
        advancedResults(PolicyHub, ["client", "branch", "generatedBy"], filterPolicyHubSection),
        getPolicyHubsPost
    )
    .get(advancedResults(PolicyHub, ["client", "branch", "generatedBy"]), getPolicyHubs);

// Create PolicyHub
router.route("/new").post(createPolicyHub);
router.route("/generate").post(generatePolicyHub);

// CRUD by ID
router
    .route("/:id")
    .get(getPolicyHub)
    .put(updatePolicyHub)
    .delete(deletePolicyHub);

router.route("/:id/download").get(downloadPolicyHubPDF);

///Version control 

router.route("/:id/versions").get(listPolicyHubVersions);
router.route("/:id/versions/:versionNumber").get(getPolicyHubVersion);
router.route("/:id/restore/:versionNumber").post(restorePolicyHubVersion);

router.route("/:id/diff").get(diffPolicyHubVersions);



module.exports = router;
