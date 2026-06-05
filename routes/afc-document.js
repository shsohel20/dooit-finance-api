const express = require("express");
const multer = require("multer");
const path = require("path");
const {
  getAfcDocuments,
  getAfcDocumentsPost,
  createAfcDocument,
  getAfcDocument,
  updateAfcDocument,
  deleteAfcDocument,
  filterAfcDocumentSection,
  upsertAfcDocument,
  downloadAfcDocumentPDF,
  exportAfcDocumentDocx,
  importAfcDocumentDocx,
  afcDocumentToPolicyHub,
} = require("../controllers/afcDocumentController");

const AfcDocument = require("../models/AfcDocument");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

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

const router = express.Router();
router.use(express.json({ limit: "15mb" }));

// Public webhook — upsert by filePath from AI service
router.route("/upsert").post(upsertAfcDocument);

// Protect all routes below
router.use(protect);
router.use(authorize("admin"));

router
  .route("/")
  .get(advancedResults(AfcDocument, ["client", "branch", "createdBy"]), getAfcDocuments)
  .post(
    advancedResults(AfcDocument, ["client", "branch", "createdBy"], filterAfcDocumentSection),
    getAfcDocumentsPost
  );

router.route("/new").post(createAfcDocument);
router.route("/import-docx").post(docxUpload.single("file"), importAfcDocumentDocx);

router
  .route("/:id")
  .get(getAfcDocument)
  .put(updateAfcDocument)
  .delete(deleteAfcDocument);

router.route("/:id/download").get(downloadAfcDocumentPDF);
router.route("/:id/export-docx").get(exportAfcDocumentDocx);
router.route("/:id/to-policy-hub").post(afcDocumentToPolicyHub);

module.exports = router;
