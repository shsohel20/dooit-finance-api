"use strict";

const express = require("express");
const router  = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");
const {
  listRules,
  getRule,
  toggleActive,
  updateRule,
} = require("../controllers/monitoringRuleController");

router.use(express.json({ limit: "10kb" }));
router.use(protect);
router.use(
  authorizePermission(
    "CLIENT_RULE.GET",
    "CLIENT_RULE.ADD",
    "CLIENT_RULE.EDIT",
    "CLIENT_RULE.DELETE",
  ),
);

router.route("/").get(listRules);
router.route("/:id").get(getRule).put(updateRule);
router.route("/:id/toggle").patch(toggleActive);

module.exports = router;
