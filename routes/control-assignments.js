"use strict";

const express = require("express");
const router  = express.Router();
const { protect } = require("../middleware/auth");
const ctrl = require("../controllers/controlAssignmentController");

router.use(express.json({ limit: "10kb" }));

router.get( "/",                             protect, ctrl.list);
router.get( "/matrix",                       protect, ctrl.matrix);
router.post("/seed",                         protect, ctrl.seed);
router.put( "/:controlId/:entityType",       protect, ctrl.toggle);

module.exports = router;
