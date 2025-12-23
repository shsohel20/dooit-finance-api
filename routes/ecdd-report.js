// routes/ecdd.js
const express = require("express");
const router = express.Router();

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
} = require("../controllers/ecddReportController");
// protect all SMR routes and allow only admin by default
router.use(protect);
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
  // optional: use advancedResults to handle query / pagination. Remove if you don't have it.
  advancedResults(EcddReport, "customer analyst generatedBy transaction"),
  getEcddReports
);

/**
 * Create a new report
 * POST /api/v1/ecdd
 * Protected: only appropriate roles should create reports
 */
router.post("/", createEcddReport);

/**
 * Import JSON (single object or array)
 * POST /api/v1/ecdd/import
 * Protected
 */
router.post(
  "/import",

  importFromJsonEcddReports
);

/**
 * Import CSV (multipart form upload field name: 'file')
 * POST /api/v1/ecdd/import-csv
 * Protected
 */
router.post("/import-csv", upload.single("file"), importEcddReportCsv);

/**
 * Export CSV
 * GET /api/v1/ecdd/export-csv
 * Protected
 */
router.get(
  "/export-csv",

  exportEcddReportCsv
);

/**
 * Get single report by ID
 * GET /api/v1/ecdd/:id
 * Public or Protected depending on your needs (here protected)
 */
router.get(
  "/:id",

  getEcddReport
);

/**
 * Update report by ID
 * PUT /api/v1/ecdd/:id
 * Protected
 */
router.put("/:id", updateEcddReport);

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
router.get("/case/:caseNumber", getEcddReportByCaseNumber);

module.exports = router;
