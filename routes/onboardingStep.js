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

const { protect, authorize } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));
router.use(protect);

// GET  /api/v1/onboarding-step?client=:id  |  ?branch=:id
router.route("/").get(authorize("admin", "client"), getOnboarding);

// POST /api/v1/onboarding-step/init
router.route("/init").post(authorize("admin"), initOnboarding);

// PUT  /api/v1/onboarding-step/step  — add or update step by order
router.route("/step").put(authorize("admin", "client"), upsertStep);

// PATCH /api/v1/onboarding-step/step-status  — status-only update
router.route("/step-status").patch(authorize("admin", "client"), updateStepStatus);

// DELETE /api/v1/onboarding-step/step?client=:id&order=:n  |  ?branch=:id&order=:n
router.route("/step").delete(authorize("admin"), removeStep);

// DELETE /api/v1/onboarding-step/:id  — delete whole record
router.route("/:id").delete(authorize("admin"), deleteOnboarding);

module.exports = router;
