"use strict";

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const ctrl = require("../controllers/riskPoolController");

router.use(express.json({ limit: "10kb" }));
// ── Entity configs (must come before /:ref to avoid matching "entity-configs" as a ref) ──
router.get( "/entity-configs",            protect, ctrl.listEntityConfigs);
router.put( "/entity-configs/:entityType", protect, ctrl.updateEntityConfig);

// ── Seed ─────────────────────────────────────────────────────────────────────
router.post("/seed", protect, ctrl.seedItems);

// ── Risk pool CRUD ────────────────────────────────────────────────────────────
router.route("/")
  .get(protect,  ctrl.listItems)
  .post(protect, ctrl.createItem);

router.route("/:ref")
  .get(protect,    ctrl.getItem)
  .put(protect,    ctrl.updateItem)
  .delete(protect, ctrl.deleteItem);

module.exports = router;
