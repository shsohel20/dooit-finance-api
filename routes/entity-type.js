const express = require("express");
const {
  getEntityTypes,
  getEntityType,
  createEntityType,
  updateEntityType,
  deleteEntityType,
} = require("../controllers/entityTypeController");
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "50kb" }));
router.use(protect);

router.route("/").get(getEntityTypes).post(createEntityType);
router.route("/:id").get(getEntityType).put(updateEntityType).delete(deleteEntityType);

module.exports = router;
