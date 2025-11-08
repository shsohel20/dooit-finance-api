const express = require("express");
const {
  getRoles,
  getRole,
  updateRole,
  deleteRole,
  filterRoleSection,
  createRole,
} = require("../controllers/roleController");

const Role = require("../models/Role");

const advancedResults = require("../middleware/advancedResults");

const router = express.Router();

router
  .route("/")
  .post(advancedResults(Role, [], filterRoleSection), getRoles)
  .get(advancedResults(Role), getRoles);

router.route("/new").post(createRole);

router.route("/:id").get(getRole).put(updateRole).delete(deleteRole);

module.exports = router;
