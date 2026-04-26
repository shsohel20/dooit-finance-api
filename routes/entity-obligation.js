const express = require("express");
const {
  getEntityObligations,
  getEntityObligation,
  updateEntityObligation,
  bulkUpdateEntityObligations,
  getObligationSummary,
  getObligationFilterOptions,
} = require("../controllers/entityObligationController");
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "500kb" }));
router.use(protect);

// Summary stats (must come before /:entityProfileId to avoid param collision)
router.route("/summary/:entityProfileId").get(getObligationSummary);

// Distinct filter option values
router.route("/filter-options/:entityProfileId").get(getObligationFilterOptions);

// Bulk update
router.route("/bulk/:entityProfileId").put(bulkUpdateEntityObligations);

// Single obligation item (must come before /:entityProfileId)
router.route("/item/:id").get(getEntityObligation).put(updateEntityObligation);

// All obligations for an entity
router.route("/:entityProfileId").get(getEntityObligations);

module.exports = router;
