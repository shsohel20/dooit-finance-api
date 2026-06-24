const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
  getGuides,
  getGuide,
  createGuide,
  updateGuide,
  deleteGuide,
  getGapAnalysis,
  mapToEntity,
  unmapFromEntity,
  updateGuideObligations,
  getStats,
} = require("../controllers/rgMapperController");

router.use(express.json({ limit: "500kb" }));
router.use(protect);

// Stats (before /:id to avoid param collision)
router.get("/stats", getStats);

// CRUD
router.route("/").get(getGuides).post(createGuide);

router.route("/:id").get(getGuide).put(updateGuide).delete(deleteGuide);

// Gap analysis for a guide + entity
router.get("/:id/gap-analysis", getGapAnalysis);

// Bulk map / unmap
router.post("/:id/map", mapToEntity);
router.delete("/:id/unmap", unmapFromEntity);

// Add / remove obligations from a guide
router.put("/:id/obligations", updateGuideObligations);

module.exports = router;
