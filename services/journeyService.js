/**
 * services/journeyService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable OnboardingJourney business logic.
 * Import this anywhere in the project instead of duplicating journey patterns.
 *
 * Exports:
 *   resolveInvite(token)                — Customer + relation from invite token
 *   findOrCreateJourney(params)         — find or create a journey document
 *   syncJourneyStatus(journey, opts)    — propagate step results → journey.status
 *   writeJourneyStep(journey, params)   — setStep + recordEvent + sync + save
 *   sanitizeDocuments(docs)             — normalise raw doc array before persist
 *   deriveFromUrl(url)                  — extract filename + mimeType from URL
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const path = require("path");
const mime = require("mime-types");
const OnboardingJourney = require("../models/OnboardingJourney");
const Customer = require("../models/Customer");
const { hashToken } = require("../utils");
const ErrorResponse = require("../utils/errorResponse");

// ─────────────────────────────────────────────────────────────────────────────
// Invite token resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * resolveInvite — resolve a Customer document and its matching relation from
 * a plain (un-hashed) invite token.
 *
 * Validations:
 *   - token present
 *   - customer found by hashed token
 *   - relation found by hashed token
 *   - token not expired
 *   - relation has a client attached
 *
 * Returns { customer, relation, relationIndex } on success.
 * Returns { error: ErrorResponse } on failure — caller must call next(error).
 *
 * @param {string} token — plain invite token from the client request
 * @returns {Promise<{ customer, relation, relationIndex } | { error: ErrorResponse }>}
 */
const resolveInvite = async (token) => {
  if (!token) return { error: new ErrorResponse("token is required", 400) };

  const hashed   = hashToken(token);
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

// ─────────────────────────────────────────────────────────────────────────────
// Document helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * deriveFromUrl — extract filename and MIME type from any URL string.
 * @param {string} url
 * @returns {{ name: string, mimeType: string }}
 */
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

/**
 * sanitizeDocuments — normalise and validate a raw documents array before
 * persisting into a journey step.
 * Filters out entries without a URL and fills in derived name/mimeType.
 *
 * @param {Array<Object>} docs
 * @returns {Array<Object>}
 */
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
        size: d.size ?? undefined,
        uploadedAt: d.uploadedAt || new Date(),
      };
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// Journey lifecycle helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * findOrCreateJourney — resolve the active OnboardingJourney for a
 * customer + client + branch combination. Creates a new journey if none exists.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.customerId
 * @param {string|ObjectId} params.clientId
 * @param {string|ObjectId|null} [params.branchId]
 * @param {number} [params.relationIndex=0]
 * @param {string} [params.channel='Mobile App']
 * @param {string} [params.provider='internal']   — 'sumsub' | 'internal' | etc.
 * @returns {Promise<OnboardingJourney>}
 */
const findOrCreateJourney = async ({
  customerId,
  clientId,
  branchId = null,
  relationIndex = 0,
  channel = "Mobile App",
  provider = "internal",
}) => {
  let journey = await OnboardingJourney.findOne({
    customer: customerId,
    client: clientId,
    branch: branchId,
  });

  if (!journey) {
    journey = new OnboardingJourney({
      customer: customerId,
      client: clientId,
      branch: branchId,
      relationIndex,
      onboardingChannel: channel,
      provider,
      status: "in_progress",
      startedAt: new Date(),
    });
  }

  return journey;
};

/**
 * syncJourneyStatus — compute and assign journey.status from the current
 * state of its steps. Call this after any step mutation, before saving.
 *
 * Rules (in priority order):
 *   1. Any step rejected                  → journey = "rejected"
 *   2. All required steps approved        → journey = "approved"
 *   3. All required steps submitted|approved → journey = "submitted"
 *   4. fallbackStatus (optional)          → journey = fallbackStatus
 *
 * @param {OnboardingJourney} journey       — mutated in place, not saved
 * @param {Object}            [opts]
 * @param {string|null}       [opts.fallbackStatus] — status to set when none
 *   of the rules above match (e.g. "in_progress" after a staff review resets
 *   a step back to pending). Defaults to null = leave status unchanged.
 */
const syncJourneyStatus = (journey, { fallbackStatus = null } = {}) => {
  const required = journey.steps.filter((s) => s.required);
  const anyRejected = journey.steps.some((s) => s.status === "rejected");
  const allApproved =
    required.length > 0 && required.every((s) => s.status === "approved");
  const allSubmittedOrApproved =
    required.length > 0 &&
    required.every(
      (s) => s.status === "submitted" || s.status === "approved",
    );

  if (anyRejected) {
    journey.status = "rejected";
  } else if (allApproved) {
    journey.status = "approved";
    journey.completedAt = journey.completedAt || new Date();
  } else if (allSubmittedOrApproved) {
    journey.status = "submitted";
    journey.submittedAt = journey.submittedAt || new Date();
  } else if (fallbackStatus) {
    journey.status = fallbackStatus;
  }
};

/**
 * writeJourneyStep — the all-in-one helper for the most common pattern:
 *   setStepStatus → recordEvent → syncJourneyStatus → save
 *
 * Replaces the repeated 4-operation block scattered across controllers.
 *
 * @param {OnboardingJourney} journey
 * @param {Object} params
 * @param {string}  params.step            — step type from STEP_TYPES
 * @param {string}  params.status          — step status from STEP_STATUSES
 * @param {Object}  [params.data]          — mixed data to merge into step.data
 * @param {Array}   [params.documents]     — raw docs (auto-sanitized)
 * @param {string}  [params.rejectionReason]
 * @param {boolean} [params.bumpAttempt=true]
 * @param {Object}  [params.event]         — event payload for recordEvent
 * @returns {Promise<OnboardingJourney>}   — saved journey
 */
const writeJourneyStep = async (
  journey,
  {
    step,
    status,
    data,
    documents,
    rejectionReason,
    bumpAttempt = true,
    event,
  },
) => {
  journey.setStepStatus(step, status, {
    data,
    documents: sanitizeDocuments(documents || []),
    rejectionReason,
    bumpAttempt,
  });

  if (event) {
    journey.recordEvent({ step, status, ...event });
  }

  syncJourneyStatus(journey);
  await journey.save();
  return journey;
};

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  resolveInvite,
  deriveFromUrl,
  sanitizeDocuments,
  findOrCreateJourney,
  syncJourneyStatus,
  writeJourneyStep,
};
