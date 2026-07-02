// controllers/customerKycStatusController.js
// Manual KYC decision (approve / reject / status change) for a customer.
// Until now customer kycStatus only moved via Sumsub webhooks and onboarding
// flows; this gives compliance users an explicit decision endpoint with a
// kycHistory audit entry (mirrors staffController.reviewStaff).

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Customer = require("../models/Customer");
const OnboardingJourney = require("../models/OnboardingJourney");
const { writeJourneyStep } = require("../services/journeyService");
const { customerRelatedToTenant } = require("../utils/customerTenantGuard");

const ALLOWED = ["pending", "in_review", "verified", "rejected"];

// @desc   Manually set a customer's KYC status (with audit note)
// @route  PATCH /api/v1/customer/:id/kyc-status
// @access Private (admin, client, branch, manager, officer)
exports.updateCustomerKycStatus = asyncHandler(async (req, res, next) => {
  const { status, note } = req.body || {};

  if (!status || !ALLOWED.includes(status)) {
    return next(new ErrorResponse(`status must be one of: ${ALLOWED.join(", ")}`, 400));
  }
  if (status === "rejected" && !note) {
    return next(new ErrorResponse("note is required when rejecting", 400));
  }

  const customer = await Customer.findById(req.params.id).select(
    "kycStatus kycVerifiedAt kycRejectReason relations",
  );
  if (!customer) {
    return next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
  }

  // Tenant guard — a client/branch user may only act on customers related to them.
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (!customerRelatedToTenant(customer, client, branch)) {
    return next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
  }

  const prev = customer.kycStatus;
  if (prev === status) {
    return next(new ErrorResponse(`Customer KYC status is already "${status}"`, 400));
  }

  const defaultNotes = {
    verified: "Approved by reviewer",
    rejected: "Rejected by reviewer",
    in_review: "Moved to review",
    pending: "Reset to pending",
  };
  const historyEntry = {
    status,
    note: note || defaultNotes[status],
    changedBy: req.user._id,
    changedAt: new Date(),
  };

  const set = { kycStatus: status };
  if (status === "verified") {
    set.kycVerifiedAt = new Date();
    set.kycRejectReason = null;
  }
  if (status === "rejected") set.kycRejectReason = note;

  // updateOne (not doc.save) so the Customer pre-save encryption hooks don't
  // re-process untouched PII fields.
  await Customer.updateOne(
    { _id: customer._id },
    { $set: set, $push: { kycHistory: historyEntry } },
  );

  res.status(200).json({
    success: true,
    message: `Customer KYC ${status}`,
    data: {
      customerId: customer._id,
      prevStatus: prev,
      kycStatus: status,
      kycVerifiedAt: set.kycVerifiedAt ?? customer.kycVerifiedAt,
      kycRejectReason:
        status === "rejected" ? note : status === "verified" ? null : customer.kycRejectReason,
      historyEntry,
    },
  });
});

const STEP_DECISIONS = ["approved", "rejected"];

// @desc   Manually approve/reject a verification journey step (e.g. ID Document)
// @route  PATCH /api/v1/customer/:id/journeys/:journeyId/steps/:stepType/review
// @access Private (admin, client, branch, manager, officer)
exports.reviewJourneyStep = asyncHandler(async (req, res, next) => {
  const { status, note } = req.body || {};
  const { id, journeyId, stepType } = req.params;

  if (!status || !STEP_DECISIONS.includes(status)) {
    return next(new ErrorResponse(`status must be one of: ${STEP_DECISIONS.join(", ")}`, 400));
  }
  if (status === "rejected" && !note) {
    return next(new ErrorResponse("note is required when rejecting", 400));
  }
  if (!OnboardingJourney.STEP_TYPES.includes(stepType)) {
    return next(new ErrorResponse(`Unknown step type "${stepType}"`, 400));
  }

  // Tenant scope — same journey filter as getCustomer.
  const filter = { _id: journeyId, customer: id };
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (client) filter.client = client;
  if (branch) filter.branch = branch;

  const journey = await OnboardingJourney.findOne(filter);
  if (!journey) {
    return next(new ErrorResponse(`Journey not found with id of ${journeyId}`, 404));
  }

  const step = journey.steps.find((s) => s.type === stepType);
  if (!step) {
    return next(new ErrorResponse(`Step "${stepType}" not found on this journey`, 404));
  }
  if (step.status === status) {
    return next(new ErrorResponse(`Step is already "${status}"`, 400));
  }

  // setStepStatus → recordEvent → syncJourneyStatus → save. A manual decision
  // is not a customer attempt, so don't bump the attempt counter.
  await writeJourneyStep(journey, {
    step: stepType,
    status,
    rejectionReason: status === "rejected" ? note : undefined,
    bumpAttempt: false,
    event: {
      action: "manual_review",
      note: note || (status === "approved" ? "Approved by reviewer" : ""),
      actor: req.user._id,
      actorRole: req.user.role || "reviewer",
    },
  });

  res.status(200).json({
    success: true,
    message: `Step ${stepType} ${status}`,
    data: {
      journeyId: journey._id,
      stepType,
      stepStatus: status,
      journeyStatus: journey.status,
    },
  });
});
