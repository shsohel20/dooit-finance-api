"use strict";

const express = require("express");
const {
  getDevices,
  getMyDevices,
  getDeviceById,
  updateDeviceTrust,
} = require("../controllers/deviceController");
const { protect, authorizePermission } = require("../middleware/auth");
const advancedResults = require("../middleware/advancedResults");
const Device = require("../models/Device");

const router = express.Router();

router.use(express.json({ limit: "100kb" }));
router.use(protect);

// Own devices — any authenticated user, before the module-permission floor.
router.route("/me").get(getMyDevices);

// Module floor: everything below needs at least one DEVICE grant.
router.use(authorizePermission("DEVICE.GET", "DEVICE.EDIT"));

router.route("/").get(
  authorizePermission("DEVICE.GET"),
  advancedResults(Device, [
    { path: "user", select: "name email photoUrl" },
    { path: "customer", select: "uid kycStatus" },
  ]),
  getDevices
);

router.route("/:id").get(authorizePermission("DEVICE.GET"), getDeviceById);
router.route("/:id/trust").patch(authorizePermission("DEVICE.EDIT"), updateDeviceTrust);

module.exports = router;
