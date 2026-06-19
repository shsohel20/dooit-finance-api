"use strict";

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const {
  listRules,
  getRule,
  toggleActive,
  updateRule,
} = require("../controllers/monitoringRuleController");

router.use(express.json({ limit: "10kb" }));
router.use(protect);

router.route("/").get(listRules);
router.route("/:id").get(getRule).put(updateRule);
router.route("/:id/toggle").patch(toggleActive);

module.exports = router;
