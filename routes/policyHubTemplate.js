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
} = require("../controllers/policyHubTemplateController");

const PolicyHubTemplate = require("../models/PolicyHubTemplate");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

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
router.use(authorize("admin"));

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
router.route("/new").post(createTemplate);

// Import from .docx — multipart/form-data with field name "file"
router.route("/import-docx").post(docxUpload.single("file"), importFromDocx);

// Single template CRUD
router
  .route("/:id")
  .get(getTemplate)
  .put(updateTemplate)
  .delete(deleteTemplate);

// Export template docs as .docx download
router.route("/:id/export-docx").get(exportToDocx);

// Create a new PolicyHub from a template
router.route("/:id/use").post(useTemplate);

module.exports = router;
