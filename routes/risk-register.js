"use strict";

const express = require("express");
const router  = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");
const ctrl = require("../controllers/riskRegisterController");

router.use(express.json({ limit: "100kb" }));
// ── Collection routes ─────────────────────────────────────────────────────────
router.route("/")
  .get(protect,  authorizePermission("EWRA.GET"), ctrl.listRegisters)
  .post(protect, authorizePermission("EWRA.ADD"), ctrl.createRegister);

// ── Auto-generate from client record ─────────────────────────────────────────
router.post(
  "/from-client/:clientId",
  protect,
  authorizePermission("EWRA.ADD"),
  ctrl.createFromClient,
);

// ── Lookup by entity name ─────────────────────────────────────────────────────
router.get(
  "/by-entity/:entityName",
  protect,
  authorizePermission("EWRA.GET"),
  ctrl.getRegisterByEntityName,
);

// ── Document routes ───────────────────────────────────────────────────────────
router.route("/:id")
  .get(protect,    authorizePermission("EWRA.GET"),    ctrl.getRegister)
  .put(protect,    authorizePermission("EWRA.EDIT"),   ctrl.updateRegister)
  .delete(protect, authorizePermission("EWRA.DELETE"), ctrl.deleteRegister);

// ── Actions ───────────────────────────────────────────────────────────────────
router.post("/:id/recalculate",    protect, authorizePermission("EWRA.EDIT"),    ctrl.recalculate);
router.post("/:id/amend",          protect, authorizePermission("EWRA.EDIT"),    ctrl.amendRegister);
router.put( "/:id/scenarios/:ref", protect, authorizePermission("EWRA.EDIT"),    ctrl.patchScenario);
router.post("/:id/submit",         protect, authorizePermission("EWRA.EDIT"),    ctrl.submitRegister);
// Sign-off is a separate grant from editing.
router.post("/:id/approve",        protect, authorizePermission("EWRA.APPROVE"), ctrl.approveRegister);
router.get( "/:id/export",         protect, authorizePermission("EWRA.GET"),     ctrl.exportExcel);

module.exports = router;
