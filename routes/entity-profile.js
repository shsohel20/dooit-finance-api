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
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));
router.use(protect);

router.route("/").get(getEntityProfiles).post(createEntityProfile);
router.route("/filter-options").get(getEntityProfileFilterOptions);
router.route("/:id").get(getEntityProfile).put(updateEntityProfile).delete(deleteEntityProfile);
router.route("/:id/instantiate-obligations").post(instantiateObligations);

module.exports = router;
