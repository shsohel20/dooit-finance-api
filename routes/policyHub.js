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
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
// const json50mb = express.json({ limit: "50mb" });
router.use(express.json({ limit: "15mb" }));

// Public webhook — must be registered before the auth middleware
router.route("/:id/webhook").post(generatePolicyHubWebHook);

// Protect all routes below
router.use(protect);
router.use(authorize("admin"));

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
router.route("/new").post(createPolicyHub);
router.route("/generate").post(generatePolicyHub);
router.route("/import-docx").post(docxUpload.single("file"), importPolicyHubDocx);

// const json2mb = [
//     express.json({ limit: "25mb" }),
//     express.urlencoded({ extended: true, limit: "25mb" }),
// ];

router
  .route("/:id")
  //   .all(json50mb) // applies 50MB limit to all methods
  .get(getPolicyHub)
  .put(updatePolicyHub)
  .delete(deletePolicyHub);

router.route("/:id/download").get(downloadPolicyHubPDF);
router.route("/:id/export-docx").get(exportPolicyHubDocx);

///Version control

router.route("/:id/versions").get(listPolicyHubVersions);
router.route("/:id/versions/:versionNumber").get(getPolicyHubVersion);
router.route("/:id/restore/:versionNumber").post(restorePolicyHubVersion);

router.route("/:id/diff").get(diffPolicyHubVersions);

router.route("/:id/save-as-template").post(saveAsTemplate);

module.exports = router;
