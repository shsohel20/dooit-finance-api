const mongoose = require("mongoose");

const { Schema } = mongoose;

const STEP_TYPES = [
  "personal_form",
  "id_document",
  "selfie",
  "liveness",
  "proof_of_address",
  "questionnaire",
  "funds_wealth",
  "declaration",
  "authorization",
  "consent",
  "review",
];

const STEP_STATUSES = [
  "pending",
  "in_progress",
  "submitted",
  "approved",
  "rejected",
  "skipped",
  "expired",
];

const JOURNEY_STATUSES = [
  "not_started",
  "in_progress",
  "submitted",
  "approved",
  "rejected",
  "expired",
  "abandoned",
];

const StepDocumentSchema = new Schema(
  {
    name: String,
    url: String,
    mimeType: String,
    docType: String,
    size: Number,
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const StepSchema = new Schema(
  {
    type: { type: String, enum: STEP_TYPES, required: true },
    status: { type: String, enum: STEP_STATUSES, default: "pending" },
    required: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    data: { type: Schema.Types.Mixed, default: {} },
    documents: { type: [StepDocumentSchema], default: [] },
    startedAt: Date,
    submittedAt: Date,
    completedAt: Date,
    rejectionReason: String,
  },
  { _id: false }
);

const EventSchema = new Schema(
  {
    step: { type: String, enum: STEP_TYPES },
    action: { type: String, required: true },
    status: { type: String, enum: STEP_STATUSES },
    note: { type: String, default: "" },
    actor: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    actorRole: { type: String, default: "customer" },
    payload: { type: Schema.Types.Mixed, default: {} },
    ip: String,
    userAgent: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const OnboardingJourneySchema = new Schema(
  {
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    relationIndex: { type: Number, default: 0 },

    provider: { type: String, default: "internal" },
    providerRef: { type: String, default: null, index: true },
    providerData: { type: Schema.Types.Mixed, default: {} },

    onboardingChannel: { type: String, default: "Mobile App" },

    status: {
      type: String,
      enum: JOURNEY_STATUSES,
      default: "not_started",
      index: true,
    },

    steps: { type: [StepSchema], default: [] },
    events: { type: [EventSchema], default: [] },

    startedAt: Date,
    submittedAt: Date,
    completedAt: Date,
    expiresAt: Date,

    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

OnboardingJourneySchema.index(
  { customer: 1, client: 1, branch: 1 },
  { unique: true, sparse: true, name: "journey_relation_unique" }
);

OnboardingJourneySchema.methods.recordEvent = function (event = {}) {
  this.events.push({ at: new Date(), ...event });
  return this;
};

OnboardingJourneySchema.methods.setStepStatus = function (
  stepType,
  status,
  extra = {}
) {
  let step = this.steps.find((s) => s.type === stepType);
  const now = new Date();

  if (!step) {
    step = {
      type: stepType,
      status,
      required: extra.required !== undefined ? extra.required : true,
      order: extra.order || 0,
      attempts: extra.bumpAttempt ? 1 : 0,
      data: extra.data || {},
      documents: extra.documents || [],
      startedAt: status === "in_progress" ? now : undefined,
      submittedAt: status === "submitted" ? now : undefined,
      completedAt:
        status === "approved" || status === "rejected" ? now : undefined,
      rejectionReason: extra.rejectionReason,
    };
    this.steps.push(step);
  } else {
    step.status = status;
    if (extra.data) step.data = { ...step.data, ...extra.data };
    if (extra.documents && extra.documents.length) {
      step.documents.push(...extra.documents);
    }
    if (status === "in_progress" && !step.startedAt) step.startedAt = now;
    if (status === "submitted") step.submittedAt = now;
    if (status === "approved" || status === "rejected") step.completedAt = now;
    if (extra.rejectionReason) step.rejectionReason = extra.rejectionReason;
    if (extra.bumpAttempt) step.attempts = (step.attempts || 0) + 1;
  }

  if (!this.startedAt) this.startedAt = now;
  if (this.status === "not_started") this.status = "in_progress";

  return step;
};

OnboardingJourneySchema.statics.STEP_TYPES = STEP_TYPES;
OnboardingJourneySchema.statics.STEP_STATUSES = STEP_STATUSES;
OnboardingJourneySchema.statics.JOURNEY_STATUSES = JOURNEY_STATUSES;

module.exports = mongoose.model(
  "OnboardingJourney",
  OnboardingJourneySchema
);
