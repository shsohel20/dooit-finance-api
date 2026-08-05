const express = require("express");
const router = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");
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
// Router-level floor: any GRC grant gets in; each route below narrows by verb.
router.use(authorizePermission("GRC.GET", "GRC.ADD", "GRC.EDIT", "GRC.DELETE"));

// Stats (before /:id to avoid param collision)
router.get("/stats", authorizePermission("GRC.GET"), getStats);

// CRUD
router
  .route("/")
  .get(authorizePermission("GRC.GET"), getGuides)
  .post(authorizePermission("GRC.ADD"), createGuide);

router
  .route("/:id")
  .get(authorizePermission("GRC.GET"), getGuide)
  .put(authorizePermission("GRC.EDIT"), updateGuide)
  .delete(authorizePermission("GRC.DELETE"), deleteGuide);

// Gap analysis for a guide + entity
router.get("/:id/gap-analysis", authorizePermission("GRC.GET"), getGapAnalysis);

// Bulk map / unmap
router.post("/:id/map", authorizePermission("GRC.EDIT"), mapToEntity);
router.delete("/:id/unmap", authorizePermission("GRC.EDIT"), unmapFromEntity);

// Add / remove obligations from a guide
router.put("/:id/obligations", authorizePermission("GRC.EDIT"), updateGuideObligations);

module.exports = router;
