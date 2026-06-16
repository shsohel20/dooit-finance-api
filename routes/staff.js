const express = require("express");
const {
  createStaff,
  updateStaff,
  getStaff,
  getStaffs,
  reviewStaff,
  initStaffApplicant,
  syncStaffStatus,
  runAmlApplicant,
} = require("../controllers/staffController");
const { protect, authorize } = require("../middleware/auth");
const Staff = require("../models/Staff");
const advancedStaffResults = require("../middleware/advancedStaffResults");

const router = express.Router();
router.use(express.json({ limit: "15mb" }));

// List staff with filters, search, sort & pagination
router.get(
  "/",
  protect,
  authorize("admin", "client", "branch", "manager"),
  advancedStaffResults(Staff),
  getStaffs,
);

// Get single staff member
router.get(
  "/:staffId",
  protect,
  authorize("admin", "client", "branch", "manager"),
  getStaff,
);

// Create staff member — creates User account + sends credentials email
router.post(
  "/",
  protect,
  authorize("admin", "client", "branch", "manager"),
  createStaff,
);

// Review staff onboarding — approve / reject / under_review / pending_docs
router.patch(
  "/:staffId/review",
  protect,
  authorize("admin", "client", "branch", "manager"),
  reviewStaff,
);

// Update staff member profile (partial — only sent fields are overwritten)
router.put(
  "/:staffId",
  protect,
  authorize("admin", "client", "branch", "manager"),
  updateStaff,
);

// Create or fetch Sumsub applicant for a staff member
router.post(
  "/:staffId/sumsub/applicant",
  protect,
  authorize("admin", "client", "branch", "manager"),
  initStaffApplicant,
);

// Fetch Sumsub applicant status and sync KYC/AML fields into Staff model
router.get(
  "/:staffId/sumsub/status",
  protect,
  authorize("admin", "client", "branch", "manager"),
  syncStaffStatus,
);

// Ensure applicant exists (create if missing) then sync KYC/AML — one shot
router.post(
  "/:staffId/sumsub/run-aml",
  protect,
  authorize("admin", "client", "branch", "manager"),
  runAmlApplicant,
);

module.exports = router;
