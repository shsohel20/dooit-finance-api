"use strict";

const express = require("express");
const router  = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");
const ctrl = require("../controllers/riskPoolController");

router.use(express.json({ limit: "10kb" }));
// ── Entity configs (must come before /:ref to avoid matching "entity-configs" as a ref) ──
router.get( "/entity-configs",             protect, authorizePermission("EWRA.GET"),  ctrl.listEntityConfigs);
router.put( "/entity-configs/:entityType", protect, authorizePermission("EWRA.EDIT"), ctrl.updateEntityConfig);

// ── Seed ─────────────────────────────────────────────────────────────────────
router.post("/seed", protect, authorizePermission("EWRA.ADD"), ctrl.seedItems);

// ── Meta (must come before /:ref) ────────────────────────────────────────────
router.get("/meta", protect, authorizePermission("EWRA.GET"), ctrl.getMeta);

// ── Risk pool CRUD ────────────────────────────────────────────────────────────
router.route("/")
  .get(protect,  authorizePermission("EWRA.GET"), ctrl.listItems)
  .post(protect, authorizePermission("EWRA.ADD"), ctrl.createItem);

router.route("/:ref")
  .get(protect,    authorizePermission("EWRA.GET"),    ctrl.getItem)
  .put(protect,    authorizePermission("EWRA.EDIT"),   ctrl.updateItem)
  .delete(protect, authorizePermission("EWRA.DELETE"), ctrl.deleteItem);

module.exports = router;
