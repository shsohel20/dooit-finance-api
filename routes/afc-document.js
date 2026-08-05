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
const { protect, authorizePermission } = require("../middleware/auth");

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
// Router-level floor: any AFC_DOC grant gets in; each route below narrows it.
router.use(
  authorizePermission("AFC_DOC.GET", "AFC_DOC.ADD", "AFC_DOC.EDIT", "AFC_DOC.DELETE"),
);

router
  .route("/")
  .get(advancedResults(AfcDocument, ["createdBy"], null, { skipClientFilter: true }), getAfcDocuments)
  .post(
    advancedResults(AfcDocument, ["createdBy"], filterAfcDocumentSection, { skipClientFilter: true }),
    getAfcDocumentsPost
  );

router.route("/new").post(authorizePermission("AFC_DOC.ADD"), createAfcDocument);
router
  .route("/import-docx")
  .post(
    authorizePermission("AFC_DOC.ADD"),
    docxUpload.single("file"),
    importAfcDocumentDocx,
  );

router
  .route("/:id")
  .get(authorizePermission("AFC_DOC.GET"), getAfcDocument)
  .put(authorizePermission("AFC_DOC.EDIT"), updateAfcDocument)
  .delete(authorizePermission("AFC_DOC.DELETE"), deleteAfcDocument);

router.route("/:id/download").get(downloadAfcDocumentPDF);
router.route("/:id/export-docx").get(exportAfcDocumentDocx);
router
  .route("/:id/to-policy-hub")
  .post(authorizePermission("POLICY_HUB.ADD"), afcDocumentToPolicyHub);

module.exports = router;
