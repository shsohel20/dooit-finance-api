const express = require("express");
const {
  getEntityTypes,
  getEntityType,
  createEntityType,
  updateEntityType,
  deleteEntityType,
} = require("../controllers/entityTypeController");
const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "50kb" }));
router.use(protect);
// Reference data: readable with REFERENCE.GET, writable with REFERENCE.EDIT.
router.use(authorizePermission("REFERENCE.GET", "REFERENCE.EDIT"));

router
  .route("/")
  .get(authorizePermission("REFERENCE.GET"), getEntityTypes)
  .post(authorizePermission("REFERENCE.EDIT"), createEntityType);
router
  .route("/:id")
  .get(authorizePermission("REFERENCE.GET"), getEntityType)
  .put(authorizePermission("REFERENCE.EDIT"), updateEntityType)
  .delete(authorizePermission("REFERENCE.EDIT"), deleteEntityType);

module.exports = router;
