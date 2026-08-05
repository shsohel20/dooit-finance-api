"use strict";

const express = require("express");
const router  = express.Router();
const { protect, authorizePermission } = require("../middleware/auth");
const ctrl = require("../controllers/controlAssignmentController");

router.use(express.json({ limit: "10kb" }));

router.get( "/",                       protect, authorizePermission("GRC.GET"),  ctrl.list);
router.get( "/matrix",                 protect, authorizePermission("GRC.GET"),  ctrl.matrix);
router.post("/seed",                   protect, authorizePermission("GRC.ADD"),  ctrl.seed);
router.put( "/:controlId/:entityType", protect, authorizePermission("GRC.EDIT"), ctrl.toggle);

module.exports = router;
