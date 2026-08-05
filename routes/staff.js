const express = require("express");
const {
  createStaff,
  updateStaff,
  getStaff,
  getStaffs,
  getStaffByRoleId,
  reviewStaff,
  initStaffApplicant,
  syncStaffStatus,
  runAmlApplicant,
} = require("../controllers/staffController");
const { protect, authorizePermission } = require("../middleware/auth");
const Staff = require("../models/Staff");
const advancedStaffResults = require("../middleware/advancedStaffResults");

const router = express.Router();
router.use(express.json({ limit: "15mb" }));

// List staff with filters, search, sort & pagination
router.get(
  "/",
  protect,
  authorizePermission("STAFF.GET"),
  advancedStaffResults(Staff),
  getStaffs,
);

// Get staff members by Role document ID
router.get(
  "/role/:roleId",
  protect,
  authorizePermission("STAFF.GET"),
  getStaffByRoleId,
);

// Get single staff member
router.get(
  "/:staffId",
  protect,
  authorizePermission("STAFF.GET"),
  getStaff,
);

// Create staff member — creates User account + sends credentials email
router.post(
  "/",
  protect,
  authorizePermission("STAFF.ADD"),
  createStaff,
);

// Review staff onboarding — approve / reject / under_review / pending_docs
router.patch(
  "/:staffId/review",
  protect,
  authorizePermission("STAFF.EDIT"),
  reviewStaff,
);

// Update staff member profile (partial — only sent fields are overwritten)
router.put(
  "/:staffId",
  protect,
  authorizePermission("STAFF.EDIT"),
  updateStaff,
);

// Create or fetch Sumsub applicant for a staff member
router.post(
  "/:staffId/sumsub/applicant",
  protect,
  authorizePermission("SUMSUB.EDIT", "STAFF.EDIT"),
  initStaffApplicant,
);

// Fetch Sumsub applicant status and sync KYC/AML fields into Staff model
router.get(
  "/:staffId/sumsub/status",
  protect,
  authorizePermission("SUMSUB.GET", "STAFF.GET"),
  syncStaffStatus,
);

// Ensure applicant exists (create if missing) then sync KYC/AML — one shot
router.post(
  "/:staffId/sumsub/run-aml",
  protect,
  authorizePermission("SUMSUB.EDIT", "STAFF.EDIT"),
  runAmlApplicant,
);

module.exports = router;
