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

// const json2mb = [
//     express.json({ limit: "25mb" }),
//     express.urlencoded({ extended: true, limit: "25mb" }),
// ];
const json50mb = express.json({ limit: "50mb" });

router
    .route("/:id")
    .all(json50mb) // applies 50MB limit to all methods
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
