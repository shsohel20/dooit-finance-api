// routes/ecdd.js
const express = require("express");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const EcddReport = require("../models/EcddReport"); // used by advancedResults middleware if needed
const upload = require("../middleware/upload"); // multer instance for CSV import
const advancedResults = require("../middleware/advancedResults"); // if you use this pattern
const { protect, authorize } = require("../middleware/auth"); // auth middlewares
const {
  getEcddReports,
  createEcddReport,
  importFromJsonEcddReports,
  importEcddReportCsv,
  exportEcddReportCsv,
  getEcddReport,
  updateEcddReport,
  deleteEcddReport,
  getEcddReportByCaseNumber,
  createPublicEcddReport,
  exportEcddReportPdf,
} = require("../controllers/ecddReportController");
// protect all SMR routes and allow only admin by default
// router.use(protect);
// router.use(authorize("admin"));
/**
 * Public listing (supports advancedResults for filtering/pagination)
 * GET /api/v1/ecdd
 */
// router.get(
//   "/",
//   // optional: use advancedResults to handle query / pagination. Remove if you don't have it.
//   advancedResults(EcddReport, {
//     path: "customer analyst generatedBy transaction",
//     select: "fullName customerName caseNumber status analystName date",
//   }),
//   ecddController.getEcddReports
// );
router.get(
  "/",
  protect,
  // optional: use advancedResults to handle query / pagination. Remove if you don't have it.
  advancedResults(EcddReport, "customer analyst generatedBy transaction"),
  getEcddReports,
);

/**
 * Create a new report
 * POST /api/v1/ecdd
 * Protected: only appropriate roles should create reports
 */
router.post("/", protect, createEcddReport);

router.post("/ai/create", createPublicEcddReport);

/**
 * Import JSON (single object or array)
 * POST /api/v1/ecdd/import
 * Protected
 */
router.post("/import", protect, importFromJsonEcddReports);

/**
 * Import CSV (multipart form upload field name: 'file')
 * POST /api/v1/ecdd/import-csv
 * Protected
 */
router.post("/import-csv", protect, upload.single("file"), importEcddReportCsv);

/**
 * Export CSV
 * GET /api/v1/ecdd/export-csv
 * Protected
 */
router.get("/export-csv", protect, exportEcddReportCsv);

/**
 * Get single report by ID
 * GET /api/v1/ecdd/:id
 * Public or Protected depending on your needs (here protected)
 */
router.get("/:id", protect, getEcddReport);

/**
 * Update report by ID
 * PUT /api/v1/ecdd/:id
 * Protected
 */
router.put("/:id", protect, updateEcddReport);

/**
 * Delete report by ID
 * DELETE /api/v1/ecdd/:id
 * Protected
 */
router.delete("/:id", deleteEcddReport);

/**
 * Get report by caseNumber
 * GET /api/v1/ecdd/case/:caseNumber
 * Note: this should be placed before the '/:id' route to avoid conflict
 */
router.get("/case/:caseNumber", protect, getEcddReportByCaseNumber);

/**
 * Filing-grade PDF of a single report
 * GET /api/v1/ecdd-report/:id/export-pdf
 * Placed before any bare '/:id' handler so the suffix is not swallowed.
 */
router.get("/:id/export-pdf", protect, exportEcddReportPdf);

module.exports = router;
