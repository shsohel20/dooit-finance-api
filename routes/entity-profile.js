const express = require("express");
const {
  getEntityProfiles,
  getEntityProfile,
  createEntityProfile,
  updateEntityProfile,
  deleteEntityProfile,
  instantiateObligations,
  getEntityProfileFilterOptions,
} = require("../controllers/entityProfileController");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));
router.use(protect);
// Router-level floor: any GRC grant gets in; each route below narrows by verb.
router.use(authorizePermission("GRC.GET", "GRC.ADD", "GRC.EDIT", "GRC.DELETE"));

router
  .route("/")
  .get(authorizePermission("GRC.GET"), getEntityProfiles)
  .post(authorizePermission("GRC.ADD"), createEntityProfile);
router
  .route("/filter-options")
  .get(authorizePermission("GRC.GET"), getEntityProfileFilterOptions);
router
  .route("/:id")
  .get(authorizePermission("GRC.GET"), getEntityProfile)
  .put(authorizePermission("GRC.EDIT"), updateEntityProfile)
  .delete(authorizePermission("GRC.DELETE"), deleteEntityProfile);
router
  .route("/:id/instantiate-obligations")
  .post(authorizePermission("GRC.EDIT"), instantiateObligations);

module.exports = router;
