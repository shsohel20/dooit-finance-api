const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const { hashToken } = require("../utils");

const path = require("path");
const mime = require("mime-types");

const Customer = require("../models/Customer");
const OnboardingJourney = require("../models/OnboardingJourney");

const { STEP_TYPES, STEP_STATUSES } = OnboardingJourney;

const deriveFromUrl = (url) => {
  if (!url || typeof url !== "string") return { name: "", mimeType: "" };

  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch (_) {
    const q = url.indexOf("?");
    if (q !== -1) pathname = url.slice(0, q);
  }

  let name = "";
  try {
    name = decodeURIComponent(path.posix.basename(pathname));
  } catch (_) {
    name = path.posix.basename(pathname);
  }

  const mimeType = mime.lookup(name) || "";
  return { name, mimeType };
};

const sanitizeDocuments = (docs) => {
  if (!Array.isArray(docs)) return [];
  return docs
    .filter((d) => d && typeof d === "object" && d.url)
    .map((d) => {
      const derived = deriveFromUrl(d.url);
      return {
        name: d.name || derived.name || "",
        url: d.url,
        mimeType: d.mimeType || derived.mimeType || "",
        docType: d.docType || "",
        size: d.size,
        uploadedAt: d.uploadedAt || new Date(),
      };
    });
};

const resolveInvite = async (token) => {
  if (!token) return { error: new ErrorResponse("token is required", 400) };

  const hashed = hashToken(token);
  const customer = await Customer.findOne({ "relations.inviteToken": hashed });
  if (!customer) return { error: new ErrorResponse("Invite not found", 404) };

  const match = customer.findRelationByHashedToken(hashed);
  if (!match) return { error: new ErrorResponse("Invalid invite token", 400) };

  const { relation, index: relationIndex } = match;

  if (
    !relation.inviteTokenExpire ||
    Date.now() > new Date(relation.inviteTokenExpire).getTime()
  ) {
    return { error: new ErrorResponse("Invite expired", 410) };
  }

  if (!relation.client) {
    return { error: new ErrorResponse("Invite missing client info", 400) };
  }

  return { customer, relation, relationIndex };
};

// @desc    Post any onboarding step (selfie, liveness, docs, personal_form, etc.)
// @route   POST /api/v1/onboarding-journey
// @access  Public (relation invite token)
exports.postJourneyStep = asyncHandler(async (req, res, next) => {
  const {
    token,
    step,
    status = "submitted",
    data,
    documents,
    note,
    rejectionReason,
    bumpAttempt = true,
  } = req.body || {};

  if (!step) return next(new ErrorResponse("step is required", 400));
  if (!STEP_TYPES.includes(step)) {
    return next(
      new ErrorResponse(
        `Invalid step. Allowed: ${STEP_TYPES.join(", ")}`,
        400
      )
    );
  }
  if (!STEP_STATUSES.includes(status)) {
    return next(
      new ErrorResponse(
        `Invalid status. Allowed: ${STEP_STATUSES.join(", ")}`,
        400
      )
    );
  }

  const resolved = await resolveInvite(token);
  if (resolved.error) return next(resolved.error);
  const { customer, relation, relationIndex } = resolved;

  const clientId = relation.client;
  const branchId = relation.branch || null;

  let journey = await OnboardingJourney.findOne({
    customer: customer._id,
    client: clientId,
    branch: branchId,
  });

  if (!journey) {
    journey = new OnboardingJourney({
      customer: customer._id,
      client: clientId,
      branch: branchId,
      relationIndex,
      onboardingChannel: relation.onboardingChannel || "Mobile App",
      provider: req.body.provider || "internal",
      providerRef: req.body.providerRef || null,
      status: "in_progress",
      startedAt: new Date(),
    });
  }

  const updatedStep = journey.setStepStatus(step, status, {
    data,
    documents: sanitizeDocuments(documents),
    rejectionReason,
    bumpAttempt,
  });

  journey.recordEvent({
    step,
    action: req.body.action || "step_submitted",
    status,
    note: note || "",
    actorRole: "customer",
    payload: {
      hasData: !!data,
      docCount: Array.isArray(documents) ? documents.length : 0,
    },
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  const requiredSteps = journey.steps.filter((s) => s.required);
  const allApproved =
    requiredSteps.length > 0 &&
    requiredSteps.every((s) => s.status === "approved");
  const anyRejected = journey.steps.some((s) => s.status === "rejected");

  if (anyRejected) {
    journey.status = "rejected";
  } else if (allApproved) {
    journey.status = "approved";
    journey.completedAt = journey.completedAt || new Date();
  } else if (
    requiredSteps.length > 0 &&
    requiredSteps.every(
      (s) => s.status === "submitted" || s.status === "approved"
    )
  ) {
    journey.status = "submitted";
    journey.submittedAt = journey.submittedAt || new Date();
  }

  await journey.save();

  return res.status(200).json({
    success: true,
    message: `Step "${step}" recorded`,
    data: {
      journeyId: journey._id,
      journeyStatus: journey.status,
      relationIndex,
      step: updatedStep,
    },
  });
});

// @desc    Get onboarding journey(s) for a customer (admin view)
// @route   GET /api/v1/onboarding-journey/customer/:customerId
// @access  Private (admin/client/branch/manager)
exports.getJourneyByCustomer = asyncHandler(async (req, res, next) => {
  const { customerId } = req.params;
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  // const { client, branch } = req.query;

  const customer = await Customer.findById(customerId).select("_id uid");
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  const filter = { customer: customer._id };
  if (client) filter.client = client;
  if (branch) filter.branch = branch;

  const journeys = await OnboardingJourney.find(filter)
    .populate({ path: "client", select: "name" })
    .populate({ path: "branch", select: "name" })
    .sort({ createdAt: -1 })
    .lean({ virtuals: true });

  return res.status(200).json({
    success: true,
    count: journeys.length,
    data: journeys,
  });
});
