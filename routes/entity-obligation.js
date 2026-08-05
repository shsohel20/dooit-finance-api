const express = require("express");
const {
  getEntityObligations,
  getEntityObligation,
  updateEntityObligation,
  bulkUpdateEntityObligations,
  getObligationSummary,
  getObligationFilterOptions,
} = require("../controllers/entityObligationController");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "500kb" }));
router.use(protect);
// Router-level floor: any GRC grant gets in; each route below narrows by verb.
router.use(authorizePermission("GRC.GET", "GRC.ADD", "GRC.EDIT", "GRC.DELETE"));

// Summary stats (must come before /:entityProfileId to avoid param collision)
router
  .route("/summary/:entityProfileId")
  .get(authorizePermission("GRC.GET"), getObligationSummary);

// Distinct filter option values
router
  .route("/filter-options/:entityProfileId")
  .get(authorizePermission("GRC.GET"), getObligationFilterOptions);

// Bulk update
router
  .route("/bulk/:entityProfileId")
  .put(authorizePermission("GRC.EDIT"), bulkUpdateEntityObligations);

// Single obligation item (must come before /:entityProfileId)
router
  .route("/item/:id")
  .get(authorizePermission("GRC.GET"), getEntityObligation)
  .put(authorizePermission("GRC.EDIT"), updateEntityObligation);

// All obligations for an entity
router
  .route("/:entityProfileId")
  .get(authorizePermission("GRC.GET"), getEntityObligations);

module.exports = router;
