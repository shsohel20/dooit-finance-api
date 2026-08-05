const express = require("express");
const multer = require("multer");
const path = require("path");
const {
  getTemplates,
  getTemplatesPost,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  useTemplate,
  filterPolicyHubTemplateSection,
  importFromDocx,
  exportToDocx,
  exportToPdf,
} = require("../controllers/policyHubTemplateController");

const PolicyHubTemplate = require("../models/PolicyHubTemplate");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "105mb" }));

// Multer: accept only .docx files, stored in memory
const docxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    const allowed =
      ext === ".docx" ||
      mime ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (allowed) cb(null, true);
    else cb(new Error("Only .docx files are allowed"), false);
  },
});

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

// List templates
router
  .route("/")
  .get(
    advancedResults(PolicyHubTemplate, ["client", "branch", "createdBy"]),
    getTemplates,
  )
  .post(
    advancedResults(
      PolicyHubTemplate,
      ["client", "branch", "createdBy"],
      filterPolicyHubTemplateSection,
    ),
    getTemplatesPost,
  );

// Create template directly
router.route("/new").post(authorizePermission("POLICY_HUB.ADD"), createTemplate);

// Import from .docx — multipart/form-data with field name "file"
router
  .route("/import-docx")
  .post(authorizePermission("POLICY_HUB.ADD"), docxUpload.single("file"), importFromDocx);

// Single template CRUD
router
  .route("/:id")
  .get(authorizePermission("POLICY_HUB.GET"), getTemplate)
  .put(authorizePermission("POLICY_HUB.EDIT"), updateTemplate)
  .delete(authorizePermission("POLICY_HUB.DELETE"), deleteTemplate);

// Export template docs as .docx download
router.route("/:id/export-docx").get(authorizePermission("POLICY_HUB.GET"), exportToDocx);

// Export template docs as PDF download
router.route("/:id/export-pdf").get(authorizePermission("POLICY_HUB.GET"), exportToPdf);

// Create a new PolicyHub from a template
router.route("/:id/use").post(authorizePermission("POLICY_HUB.ADD"), useTemplate);

module.exports = router;
