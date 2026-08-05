// routes/onboardingStep.js
const express = require("express");
const {
  getOnboarding,
  initOnboarding,
  upsertStep,
  updateStepStatus,
  removeStep,
  deleteOnboarding,
} = require("../controllers/onboardingStepController");

const { protect, authorizePermission } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));
router.use(protect);

// GET  /api/v1/onboarding-step?client=:id  |  ?branch=:id
router.route("/").get(authorizePermission("ONBOARDING.GET"), getOnboarding);

// POST /api/v1/onboarding-step/init
router.route("/init").post(authorizePermission("ONBOARDING.ADD"), initOnboarding);

// PUT  /api/v1/onboarding-step/step  — add or update step by order
router.route("/step").put(authorizePermission("ONBOARDING.EDIT"), upsertStep);

// PATCH /api/v1/onboarding-step/step-status  — status-only update
router.route("/step-status").patch(authorizePermission("ONBOARDING.EDIT"), updateStepStatus);

// DELETE /api/v1/onboarding-step/step?client=:id&order=:n  |  ?branch=:id&order=:n
router.route("/step").delete(authorizePermission("ONBOARDING.DELETE"), removeStep);

// DELETE /api/v1/onboarding-step/:id  — delete whole record
router.route("/:id").delete(authorizePermission("ONBOARDING.DELETE"), deleteOnboarding);

module.exports = router;
