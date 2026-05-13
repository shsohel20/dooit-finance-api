const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const {
  getRiskSummary,
  getComplianceHealth,
  getControlEffectiveness,
  getRegulatoryDeadlines,
  getTopRisks,
  getIssues,
  getTestingStatus,
  getAuditReadiness,
  getHeatmap,
  getKriMetrics,
} = require("../controllers/ewraDashboardController");

router.use(express.json({ limit: "100kb" }));
router.use(protect);

// All scoped to :entityId
router.get("/:entityId/risk-summary",          getRiskSummary);
router.get("/:entityId/compliance-health",     getComplianceHealth);
router.get("/:entityId/control-effectiveness", getControlEffectiveness);
router.get("/:entityId/regulatory-deadlines",  getRegulatoryDeadlines);
router.get("/:entityId/top-risks",             getTopRisks);
router.get("/:entityId/issues",                getIssues);
router.get("/:entityId/testing-status",        getTestingStatus);
router.get("/:entityId/audit-readiness",       getAuditReadiness);
router.get("/:entityId/heatmap",               getHeatmap);
router.get("/:entityId/kri-metrics",           getKriMetrics);

module.exports = router;
