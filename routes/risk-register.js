"use strict";

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const ctrl = require("../controllers/riskRegisterController");

router.use(express.json({ limit: "100kb" }));
// ── Collection routes ─────────────────────────────────────────────────────────
router.route("/")
  .get(protect,  ctrl.listRegisters)
  .post(protect, ctrl.createRegister);

// ── Document routes ───────────────────────────────────────────────────────────
router.route("/:id")
  .get(protect,    ctrl.getRegister)
  .put(protect,    ctrl.updateRegister)
  .delete(protect, ctrl.deleteRegister);

// ── Actions ───────────────────────────────────────────────────────────────────
router.post("/:id/recalculate",       protect, ctrl.recalculate);
router.put( "/:id/scenarios/:ref",    protect, ctrl.patchScenario);
router.post("/:id/submit",            protect, ctrl.submitRegister);
router.post("/:id/approve",           protect, ctrl.approveRegister);
router.get( "/:id/export",            protect, ctrl.exportExcel);

module.exports = router;
