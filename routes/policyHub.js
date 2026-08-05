const express = require("express");
const multer = require("multer");
const path = require("path");
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
  generatePolicyHubWebHook,
  listPolicyHubVersions,
  getPolicyHubVersion,
  restorePolicyHubVersion,
  diffPolicyHubVersions,
  exportPolicyHubDocx,
  importPolicyHubDocx,
} = require("../controllers/policyHubController");

const docxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    const allowed =
      ext === ".docx" ||
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (allowed) cb(null, true);
    else cb(new Error("Only .docx files are allowed"), false);
  },
});

const { saveAsTemplate } = require("../controllers/policyHubTemplateController");

const PolicyHub = require("../models/PolicyHub");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
// const json50mb = express.json({ limit: "50mb" });
router.use(express.json({ limit: "15mb" }));

// Public webhook — must be registered before the auth middleware
router.route("/:id/webhook").post(generatePolicyHubWebHook);

// Protect all routes below
router.use(protect);
// Router-level floor: any POLICY_HUB grant gets in; each route below narrows it.
router.use(
  authorizePermission(
    "POLICY_HUB.GET",
    "POLICY_HUB.ADD",
    "POLICY_HUB.EDIT",
    "POLICY_HUB.DELETE",
  ),
);

// List PolicyHubs
router
  .route("/")
  .post(
    advancedResults(
      PolicyHub,
      ["client", "branch", "generatedBy"],
      filterPolicyHubSection,
    ),
    getPolicyHubsPost,
  )
  .get(
    advancedResults(PolicyHub, ["client", "branch", "generatedBy"]),
    getPolicyHubs,
  );

// Create PolicyHub
router.route("/new").post(authorizePermission("POLICY_HUB.ADD"), createPolicyHub);
router.route("/generate").post(authorizePermission("POLICY_HUB.ADD"), generatePolicyHub);
router
  .route("/import-docx")
  .post(
    authorizePermission("POLICY_HUB.ADD"),
    docxUpload.single("file"),
    importPolicyHubDocx,
  );

// const json2mb = [
//     express.json({ limit: "25mb" }),
//     express.urlencoded({ extended: true, limit: "25mb" }),
// ];

router
  .route("/:id")
  //   .all(json50mb) // applies 50MB limit to all methods
  .get(authorizePermission("POLICY_HUB.GET"), getPolicyHub)
  .put(authorizePermission("POLICY_HUB.EDIT"), updatePolicyHub)
  .delete(authorizePermission("POLICY_HUB.DELETE"), deletePolicyHub);

router.route("/:id/download").get(authorizePermission("POLICY_HUB.GET"), downloadPolicyHubPDF);
router.route("/:id/export-docx").get(authorizePermission("POLICY_HUB.GET"), exportPolicyHubDocx);

///Version control

router.route("/:id/versions").get(authorizePermission("POLICY_HUB.GET"), listPolicyHubVersions);
router
  .route("/:id/versions/:versionNumber")
  .get(authorizePermission("POLICY_HUB.GET"), getPolicyHubVersion);
router
  .route("/:id/restore/:versionNumber")
  .post(authorizePermission("POLICY_HUB.EDIT"), restorePolicyHubVersion);

router.route("/:id/diff").get(authorizePermission("POLICY_HUB.GET"), diffPolicyHubVersions);

router
  .route("/:id/save-as-template")
  .post(authorizePermission("POLICY_HUB.ADD"), saveAsTemplate);

module.exports = router;
