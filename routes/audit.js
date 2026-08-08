"use strict";

const express = require("express");
const {
  getAuditActivity,
  getAuditSummary,
} = require("../controllers/auditActivityController");
const { protect, authorizePermission } = require("../middleware/auth");
const advancedResults = require("../middleware/advancedResults");
const AuditLog = require("../models/AuditLog");

const router = express.Router();

router.use(express.json({ limit: "100kb" }));
router.use(protect);
router.use(authorizePermission("AUDIT.GET"));

router.route("/").get(
  advancedResults(AuditLog, [
    { path: "user", select: "name email" },
    { path: "actor", select: "name email" },
    { path: "case", select: "uid title" },
    { path: "customer", select: "uid" },
    { path: "device", select: "uid deviceType os browser" },
  ]),
  getAuditActivity
);

router.route("/summary").get(getAuditSummary);

module.exports = router;
