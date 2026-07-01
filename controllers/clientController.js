// controllers/client.controller.js
const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const Client = require("../models/Client");
const User = require("../models/User");
const UserType = require("../models/UserType");
const EntityType = require("../models/EntityType");
const { validateClientCreation, markOnboardingStep, initialPassword, generateRandomPassword } = require("../utils");
const ErrorResponse = require("../utils/errorResponse");
const { generateQR } = require("../utils/qrService");
const { createRiskRegisterFromClient } = require("./riskRegisterController");
const { runInBackground } = require("../utils/backgroundJob");
const { generateAMLDocsForClient } = require("../utils/amlDocGenService");
const { hashForSearch } = require("../utils/encryption");
const sendEmail = require("../utils/sendEmail");
const { clientWelcomeHtml, clientCredentialsHtml } = require("../utils/email-template/clientEmailTemplate");

/**
 * Simple filter helper similar to filterUserSection
 * Checks if client name includes the requestBody.name (case-insensitive)
 */
exports.filterClientSection = (c, requestBody) => {
  if (!requestBody || !requestBody.name) return true;
  return c.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all clients
// @route GET  /api/v1/clients
// @access Protected (or restrict as needed)
exports.getClients = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Client']
  #swagger.summary = 'Get All Clients'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: {  } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/

  res.status(200).json(res.advancedResults);
});

// @desc   Create a single client
// @route  /api/v1/clients
// @access Public (or restrict as needed)
exports.createClient = asyncHandler(async (req, res, next) => {
  // Validate request
  const isValid = await validateClientCreation(req.body, next);
  if (!isValid) return;

  const {
    name,
    clientType,
    clientTypeId,
    registrationNumber,
    taxId,
    email,
    phone,
    website,
    contacts,
    address,
    legalRepresentative,
    documents,
    status,
    settings,
    metadata
  } = req.body;

  console.log(req.body)

  let user = null;
  let isNewUser = false;
  let tempPassword = null;

  const userName = email;
  // Use emailHash for dedupe — plaintext email may be AES-encrypted at rest.
  user = await User.findOne({ emailHash: hashForSearch(email) });
  if (!user) {
    isNewUser = true;
    // Random one-time temporary password, emailed to the client. They are
    // guided to replace it via the secure set-password link (see emails below).
    // tempPassword = generateRandomPassword(12);
    tempPassword = initialPassword;
    user = await User.create({
      name,
      email,
      password: tempPassword,
      isActive: true,
      userName,
    });
  }

  if (!user) return next(new ErrorResponse("Please try again!", 400));

  // Create client record
  const client = await Client.create({
    user: user._id,
    name,
    clientType,
    clientTypeId,
    registrationNumber,
    taxId,
    email,
    phone,
    website,
    contacts,
    address,
    legalRepresentative,
    documents,
    status,
    settings,
    metadata,
  });

  // Seed UserType AFTER Client exists so clientBelongs can be set correctly.
  // Remove any stale null-clientBelongs row first (from before the client was created).
  await UserType.deleteOne({ user: user._id, userType: "client", role: "admin", clientBelongs: null, branchBelongs: null });
  await UserType.findOneAndUpdate(
    { user: user._id, userType: "client", role: "admin", clientBelongs: client._id, branchBelongs: null },
    { $setOnInsert: { isActive: true, assignedBy: req.user?._id ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.status(201).json({
    succeed: true,
    data: client,
    id: client._id,
  });

  // ── Onboarding emails ──────────────────────────────────────────────────────
  //  1) Welcome / onboarding email
  //  2) Login credentials + secure password-setup / reset instructions
  // Sent after the response is returned; any failure is logged, never surfaced
  // to the client-creation request.
  runInBackground(`clientOnboardingEmails:${client._id}`, async () => {
    const base = String(req.body.clientUrl || process.env.FRONTEND_URL || "")
      .replace(/\/+$/, "");
    const loginUrl = `${base}/auth/login`;

    // Generate a set-password token and persist it with a 24h onboarding window.
    // Uses User.updateOne (not user.save) to avoid the password pre-save hook.
    let setPasswordUrl = `${base}/auth/forgot-password`; // safe fallback link
    try {
      const resetToken = user.getResetPasswordToken();
      await User.updateOne(
        { _id: user._id },
        {
          resetPasswordToken: user.resetPasswordToken,
          resetPasswordExpire: Date.now() + 24 * 60 * 60 * 1000,
        }
      );
      setPasswordUrl = `${base}/auth/reset-password?${resetToken}`;
    } catch (err) {
      console.error("[createClient] reset-token generation failed:", err.message);
    }

    // 1) Welcome / onboarding
    try {
      await sendEmail({
        email,
        subject: "Welcome to Dooit",
        message: clientWelcomeHtml({ name, loginUrl }),
      });
    } catch (err) {
      console.error("[createClient] welcome email failed:", err.message);
    }

    // 2) Credentials + password setup / reset
    try {
      await sendEmail({
        email,
        subject: "Your Dooit Login Details & Password Setup",
        message: clientCredentialsHtml({
          name,
          email,
          tempPassword, // null for pre-existing accounts → password row omitted
          setPasswordUrl,
          loginUrl,
        }),
      });
    } catch (err) {
      console.error("[createClient] credentials email failed:", err.message);
    }
  });
});

// @desc   Fetch single client by id
// @route  /api/v1/clients/:id
// @access Public
exports.getClient = asyncHandler(async (req, res, next) => {
  const client = await Client.findById(req.params.id).populate(
    "user",
    "userName -_id"
  );

  if (!client) {
    return next(
      new ErrorResponse(`Client not found with id of ${req.params.id}`, 404)
    );
  }
  res.status(200).json({
    success: true,
    data: client,
  });
});

// @desc   Fetch single client by slug
// @route  /api/v1/clients/slug/:slug
// @access Public/Private depending on your auth
exports.getClientBySlug = asyncHandler(async (req, res, next) => {
  const client = await Client.findOne({ slug: req.params.slug });
  if (!client) {
    return next(
      new ErrorResponse(`Client not found with slug of ${req.params.slug}`, 404)
    );
  }
  res.status(200).json({
    success: true,
    data: client,
  });
});

/**
 * Update single client (with multi-field duplicate checks and linked user update)
 * @route  PUT /api/v1/clients/:id
 */
exports.updateClient = asyncHandler(async (req, res, next) => {
  const clientId = req.params.id;
  const {
    name,
    email,
    registrationNumber,
    taxId,
    phone,
    website,
    userName, // optional: update linked user's userName
    // ... other client fields
  } = req.body;

  // 1. Fetch existing client
  const client = await Client.findById(clientId);
  if (!client) {
    return next(
      new ErrorResponse(`Client not found with id of ${clientId}`, 404)
    );
  }

  // 2. Build list of candidate unique checks for Client
  const clientUniqueChecks = [
    { name },
    { email },
    { registrationNumber },
    { taxId },
    { phone },
    { website },
  ].filter((obj) => {
    const val = Object.values(obj)[0];
    return val !== undefined && val !== null && String(val).trim() !== "";
  });

  if (clientUniqueChecks.length > 0) {
    const orQuery = clientUniqueChecks;
    // exclude current client by _id
    const existing = await Client.findOne({
      $or: orQuery,
      _id: { $ne: clientId },
    }).lean();

    if (existing) {
      // determine which field(s) collided to give a clearer error
      const collidedFields = [];
      clientUniqueChecks.forEach((check) => {
        const key = Object.keys(check)[0];
        const val = String(check[key]).trim().toLowerCase();
        const existingVal = existing[key];
        if (
          existingVal !== undefined &&
          existingVal !== null &&
          String(existingVal).trim().toLowerCase() === val
        ) {
          collidedFields.push(key);
        }
      });

      const fieldsMsg = collidedFields.length
        ? collidedFields.join(", ")
        : "one of the unique fields";
      return next(
        new ErrorResponse(
          `Another client already uses the same ${fieldsMsg}.`,
          409
        )
      );
    }
  }

  // 3. If updating linked user info (email/userName), ensure uniqueness across Users excluding current linked user (if any)
  if (
    (email && String(email).trim() !== "") ||
    (userName && String(userName).trim() !== "")
  ) {
    // find linked user id from client.user (if present)
    const linkedUserId = client.user ? client.user.toString() : null;

    const userUniqueChecks = [
      userName ? { userName } : null,
      email ? { email } : null,
    ].filter(Boolean);

    if (userUniqueChecks.length > 0) {
      const userExisting = await User.findOne({
        $or: userUniqueChecks,
        ...(linkedUserId ? { _id: { $ne: linkedUserId } } : {}),
      }).lean();

      if (userExisting) {
        // detect which user field collided
        const collidedUserFields = [];
        userUniqueChecks.forEach((check) => {
          const key = Object.keys(check)[0];
          const val = String(check[key]).trim().toLowerCase();
          const existingVal = userExisting[key];
          if (
            existingVal !== undefined &&
            existingVal !== null &&
            String(existingVal).trim().toLowerCase() === val
          ) {
            collidedUserFields.push(key);
          }
        });

        const fieldsMsg = collidedUserFields.length
          ? collidedUserFields.join(", ")
          : "email/userName";
        return next(
          new ErrorResponse(
            `Another user already uses the same ${fieldsMsg}.`,
            409
          )
        );
      }
    }
  }

  // 4. Perform client update
  const updatedClient = await Client.findByIdAndUpdate(clientId, req.body, {
    new: true,
    runValidators: true,
  });

  if (!updatedClient) {
    return next(
      new ErrorResponse(`Failed to update client with id ${clientId}`, 500)
    );
  }

  // 5. If linked user exists and email/userName changed, update linked user
  try {
    if (client.user) {
      const linkedUser = await User.findById(client.user).select("+password");
      if (linkedUser) {
        let shouldSaveUser = false;

        if (
          email &&
          String(email).trim() !== "" &&
          String(linkedUser.email).trim().toLowerCase() !==
          String(email).trim().toLowerCase()
        ) {
          linkedUser.email = email;
          shouldSaveUser = true;
        }

        if (
          userName &&
          String(userName).trim() !== "" &&
          String(linkedUser.userName).trim().toLowerCase() !==
          String(userName).trim().toLowerCase()
        ) {
          linkedUser.userName = userName;
          shouldSaveUser = true;
        }

        // You may also want to sync name or other user fields from client body:
        if (
          req.body.name &&
          String(linkedUser.name).trim() !== String(req.body.name).trim()
        ) {
          linkedUser.name = req.body.name;
          shouldSaveUser = true;
        }

        if (shouldSaveUser) {
          await linkedUser.save();
        }
      }
    }
  } catch (err) {
    // If user update fails for some reason, log it but don't necessarily fail the entire request.
    // However, depending on your needs, you could revert the client update or return an error.
    console.error(
      "Warning: failed to update linked user after client update:",
      err
    );
  }

  res.status(200).json({
    success: true,
    data: updatedClient,
  });
});

/**
 * Delete single client
 * - Default: soft-delete (marks client as Inactive and sets metadata.deleted)
 * - Hard delete: pass query ?hard=true
 * - If hard delete and you want to also delete linked user: pass ?deleteUser=true
 *
 * Route: DELETE /api/v1/clients/:id
 */
exports.deleteClient = asyncHandler(async (req, res, next) => {
  const clientId = req.params.id;
  const hardDelete = String(req.query.hard || "").toLowerCase() === "true";
  const deleteLinkedUser =
    String(req.query.deleteUser || "").toLowerCase() === "true";

  const client = await Client.findById(clientId).exec();
  if (!client) {
    return next(
      new ErrorResponse(`Client not found with id of ${clientId}`, 404)
    );
  }

  // Get linked user id if exists
  const linkedUserId = client.user ? client.user.toString() : null;

  // If hard delete requested, try to run inside a transaction (if DB supports it)
  if (hardDelete) {
    // Best-effort: use a session if available
    let session = null;
    let usedSession = false;
    try {
      if (mongoose.connection && mongoose.connection.startSession) {
        session = await mongoose.connection.startSession();
        session.startTransaction();
        usedSession = true;
      }

      // Delete client
      if (usedSession) {
        await Client.deleteOne({ _id: clientId }).session(session);
      } else {
        await Client.deleteOne({ _id: clientId });
      }

      // Optionally delete linked user
      if (deleteLinkedUser && linkedUserId) {
        if (usedSession) {
          await User.deleteOne({ _id: linkedUserId }).session(session);
        } else {
          await User.deleteOne({ _id: linkedUserId });
        }
      } else if (linkedUserId) {
        // If not deleting the user, disassociate the user.client field
        if (usedSession) {
          await User.updateOne(
            { _id: linkedUserId },
            { $unset: { client: "" } }
          ).session(session);
        } else {
          await User.updateOne(
            { _id: linkedUserId },
            { $unset: { client: "" } }
          );
        }
      }

      // TODO: Delete or cleanup other related collections (vendors/accounts/orders/etc.)
      // e.g. await SomeModel.deleteMany({ client: clientId }).session(session);

      if (usedSession) {
        await session.commitTransaction();
        session.endSession();
      }

      return res.status(200).json({
        success: true,
        message: `Client ${hardDelete ? "hard-deleted" : "deleted"
          } successfully`,
        data: {
          id: clientId,
          deletedUser: deleteLinkedUser ? linkedUserId : null,
        },
      });
    } catch (err) {
      if (usedSession && session) {
        try {
          await session.abortTransaction();
          session.endSession();
        } catch (e) {
          console.error("Failed to abort session", e);
        }
      }
      console.error(err);
      return next(
        new ErrorResponse("Failed to delete client. " + err.message, 500)
      );
    }
  }

  // Soft delete (default)
  try {
    // Mark client as Inactive, set metadata.deleted and timestamp
    client.status = "Inactive";
    if (!client.metadata || typeof client.metadata !== "object")
      client.metadata = {};
    client.metadata.deleted = true;
    client.metadata.deletedAt = new Date();

    // Optionally you can also move the name to a backup field to avoid unique collisions:
    // client.metadata.previousName = client.name;
    // client.name = `${client.name}--deleted--${client._id}`;

    await client.save();

    // Disassociate linked user (if any) but do NOT delete user
    if (linkedUserId) {
      await User.updateOne({ _id: linkedUserId }, { $unset: { client: "" } });
    }

    return res.status(200).json({
      success: true,
      message: "Client soft-deleted (status set to Inactive)",
      data: { id: clientId },
    });
  } catch (err) {
    console.error(err);
    return next(
      new ErrorResponse("Failed to soft-delete client. " + err.message, 500)
    );
  }
});

// ── Client ↔ Risk-Question field mapping ─────────────────────────────────────
// Maps a riskQuestions question key to the dot-path on the Client document.
// Priority for value resolution: riskQuestion answer → client profile field → type default.
const CLIENT_FIELD_MAP = {
  entity_type: "clientTypeId",
  abn: "registrationNumber",
  co_name: "legalRepresentative.name",
  co_email: "legalRepresentative.email",
  co_phone: "legalRepresentative.phone",
};

// Safely traverse a dot-path on any plain object; returns undefined when missing.
function getNestedValue(obj, dotPath) {
  if (!obj || !dotPath) return undefined;
  return dotPath.split(".").reduce(
    (acc, key) => (acc != null && typeof acc === "object" ? acc[key] : undefined),
    obj
  );
}

// Return a type-appropriate empty/default value for a field definition.
function getTypeDefault(field) {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "multi-select": return [];
    case "rating": return field.min ?? 1;
    case "number": return null;
    case "date": return null;
    case "yes-no":
    case "single-select": return "";
    case "text":
    case "email":
    default: return "";
  }
}

// Resolve a field's display value using the priority chain:
//   1. Existing riskQuestions answer
//   2. Mapped client profile field
//   3. Type-appropriate default
function resolveFieldValue(field, riskAnswers, client) {
  const saved = getNestedValue(riskAnswers, field.key);
  const savedHasValue = saved !== undefined && saved !== null &&
    (Array.isArray(saved) ? saved.length > 0 : saved !== "");
  if (savedHasValue) return saved;

  const clientPath = CLIENT_FIELD_MAP[field.key];
  if (client && clientPath) {
    const clientObj = typeof client.toObject === "function" ? client.toObject() : client;
    const clientVal = getNestedValue(clientObj, clientPath);
    const clientHasValue = clientVal !== undefined && clientVal !== null &&
      (Array.isArray(clientVal) ? clientVal.length > 0 : clientVal !== "");
    if (clientHasValue) return clientVal;
  }

  return getTypeDefault(field);
}

// ── Risk questions schema (static config — no DB call) ────────────────────────

const RISK_QUESTIONS_SCHEMA = [
  {
    id: "identity",
    label: "Entity Details",
    desc: "Identify the reporting entity",
    fields: [
      {
        key: "entity_type", label: "Entity Type", type: "single-select", required: true,
        hint: "Select the AUSTRAC-regulated entity type that best describes your business.",
        options: [
          "Lawyers/Conveyancers", "Accountants", "Real Estate Agents",
          "Precious Metal Dealers", "TCSPs", "Banks & ADIs",
          "Remittance", "VASP/DCEP", "Gambling/Casino", "Insurance",
        ],
      },
      { key: "abn", label: "ABN", type: "text", placeholder: "XX XXX XXX XXX" },
      { key: "assessDate", label: "Assessment Date", type: "date" },
      { key: "documentDate", label: "Document Date", type: "date" },
      { key: "effectiveDate", label: "Program Effective Date", type: "date" },
      { key: "austracEnrolmentRef", label: "AUSTRAC Enrolment Reference", type: "text", placeholder: "e.g. ENR-20260001" },
      {
        key: "austrac_enrolled", label: "AUSTRAC Enrolment Status", type: "single-select",
        options: ["Enrolled and current", "Enrolment in progress", "Not yet enrolled", "Exempt"],
      },
      { key: "co_name", label: "Compliance Officer — Name", type: "text", required: true, placeholder: "Full name" },
      { key: "co_email", label: "Compliance Officer — Email", type: "email", placeholder: "co@firm.com.au" },
      { key: "co_phone", label: "Compliance Officer — Phone", type: "text", placeholder: "+61 4xx xxx xxx" },
      { key: "sm_name", label: "Senior Manager — Name", type: "text", placeholder: "Full name" },
      { key: "sm_email", label: "Senior Manager — Email", type: "email", placeholder: "sm@firm.com.au" },
    ],
  },
  {
    id: "sector",
    label: "Sector Information",
    desc: "Turnover, licences and enrolment",
    fields: [
      {
        key: "turnover_range", label: "Annual Turnover Range", type: "single-select",
        options: ["< $500K", "$500K – $2M", "$2M – $10M", "$10M – $50M", "> $50M"],
      },
      {
        key: "is_sole_practitioner", label: "Sole Practitioner / Principal-only firm?", type: "yes-no",
        options: ["Yes", "No"],
      },
      {
        key: "licence_types", label: "Licence / Registration Types", type: "multi-select",
        hint: "Select all that apply.",
        options: [
          "Legal Practitioner", "Property / Real Estate Agent", "Financial Services (AFSL)",
          "Tax Agent", "VASP Registration", "Remittance Registration",
          "Gambling Licence", "Insurance Licence", "Other",
        ],
      },
    ],
  },
  {
    id: "customer_types",
    label: "Client Types",
    desc: "Who you serve and PEP exposure",
    fields: [
      {
        key: "client_types", label: "Client Types Served", type: "multi-select", required: true,
        hint: "Select all categories of clients your entity onboards.",
        options: [
          "Individuals", "Sole traders", "Bodies corporate", "Trusts",
          "Partnerships", "Government / Public bodies", "Foreign entities", "Financial institutions",
        ],
      },
      {
        key: "foreign_client_proportion", label: "Foreign Client Proportion", type: "single-select",
        hint: "What proportion of your client base are foreign nationals or foreign-controlled entities?",
        options: ["< 5%", "5% – 30%", "More than 30%"],
      },
      {
        key: "complex_structures", label: "Complex Structures Frequency", type: "single-select",
        hint: "How often do you serve clients using trusts, multi-layer corporate structures, or nominee arrangements?",
        options: ["No", "Occasionally", "Regularly"],
      },
      {
        key: "pep_exposure", label: "PEP Exposure", type: "single-select",
        hint: "Do any clients hold (or are associated with) politically exposed persons?",
        options: ["No PEP exposure", "Domestic PEPs only", "Foreign PEPs only", "Both domestic and foreign PEPs"],
      },
    ],
  },
  {
    id: "delivery_channels",
    label: "Delivery Channels",
    desc: "How services are delivered",
    fields: [
      {
        key: "delivery_channels", label: "Delivery Channels Used", type: "multi-select", required: true,
        hint: "Select all channels through which you deliver designated services.",
        options: [
          "Face to face / in-person", "Online platform / web portal", "Email or correspondence",
          "Telephone", "Third-party agent or intermediary", "API / automated integration", "Mobile app",
        ],
      },
      {
        key: "non_f2f_proportion", label: "Non-Face-to-Face Proportion", type: "single-select",
        hint: "What proportion of clients are fully remote (no in-person contact at any stage)?",
        options: ["Less than 25%", "25% – 75%", "More than 75%"],
      },
      {
        key: "uses_intermediaries", label: "Use of Intermediaries", type: "single-select",
        hint: "Do third-party agents or intermediaries introduce clients or perform any CDD functions on your behalf?",
        options: ["No", "Yes — with formal CDD Arrangement", "Yes — without formal arrangement", "Occasionally"],
      },
      {
        key: "handles_cash", label: "Cash Handling", type: "single-select",
        hint: "Does the entity accept, receive, or handle physical cash in relation to designated services?",
        options: ["No", "Occasionally", "Regularly"],
      },
    ],
  },
  {
    id: "designated_services",
    label: "Designated Services",
    desc: "Specific service risk factors",
    fields: [
      {
        key: "ds_high_value_unfinanced", label: "High-value unfinanced purchases ≥$1.5M", type: "yes-no",
        hint: "Does the entity facilitate purchases ≥$1.5M where the full consideration is not financed by a licensed institution?",
        options: ["Yes", "No"],
      },
      {
        key: "ds_high_currency", label: "High-value currency exchange / cash transactions", type: "yes-no",
        hint: "Does the entity receive or exchange physical currency ≥$10,000 in the course of designated services?",
        options: ["Yes", "No"],
      },
      {
        key: "ds_intl_transfers", label: "International funds transfers", type: "yes-no",
        hint: "Does the entity facilitate or receive cross-border funds transfers as part of designated services?",
        options: ["Yes", "No"],
      },
      {
        key: "ds_anonymous_clients", label: "Anonymous or difficult-to-identify clients", type: "single-select",
        hint: "How frequently does the entity encounter clients where identity cannot be readily verified?",
        options: ["No", "Occasionally", "Regularly"],
      },
      {
        key: "ds_virtual_assets", label: "Virtual asset transactions", type: "yes-no",
        hint: "Does the entity buy, sell, exchange, or transfer virtual assets (crypto, tokens, NFTs) on behalf of clients?",
        options: ["Yes", "No"],
      },
      {
        key: "ds_complex_structures", label: "Complex structure services", type: "yes-no",
        hint: "Does the entity provide shelf company formation, nominee director arrangements, or structured BO vehicles?",
        options: ["Yes", "No"],
      },
      {
        key: "ds_unusual_services", label: "New or unusual services", type: "single-select",
        hint: "Does the entity provide services with no apparent economic rationale?",
        options: ["No", "Occasionally", "Yes"],
      },
    ],
  },
  {
    id: "client_channel_risks",
    label: "Client & Channel Risks",
    desc: "Observed risk indicators in your existing client base",
    fields: [
      {
        key: "cr_criminal_activity", label: "Suspected criminal activity by clients", type: "single-select",
        hint: "Have there been clients where criminal activity was suspected in connection with instructions given?",
        options: ["No", "Occasionally", "Regularly"],
      },
      {
        key: "cr_pep", label: "PEP-linked client activity", type: "single-select",
        hint: "Have you encountered clients with PEP connections in the past 12 months?",
        options: ["No", "Domestic PEPs", "Foreign PEPs", "Both"],
      },
      {
        key: "cr_unexplained_wealth", label: "Clients with unexplained wealth", type: "yes-no",
        hint: "Have clients presented assets or funds disproportionate to their known legitimate income?",
        options: ["Yes", "No"],
      },
      {
        key: "cr_npo", label: "NPO or charity clients", type: "single-select",
        hint: "Does the entity serve non-profit organisations, charities, or religious bodies?",
        options: ["No", "Occasionally", "Yes — including with enhanced risk indicators"],
      },
      {
        key: "ch_remote_only", label: "Remote-only clients", type: "yes-no",
        hint: "Are any clients fully remote — with no face-to-face interaction at any stage?",
        options: ["Yes", "No"],
      },
      {
        key: "ch_third_party_cdd", label: "Third-party CDD reliance", type: "single-select",
        hint: "Does the entity rely on third parties who perform any CDD functions on its behalf?",
        options: ["No", "Yes — with formal CDD Arrangement", "Yes — without formal arrangement"],
      },
    ],
  },
  {
    id: "jurisdiction",
    label: "Country Exposure",
    desc: "Jurisdictional risk",
    fields: [
      {
        key: "countries_exposure", label: "Countries / Regions of Client Exposure", type: "multi-select",
        hint: "Select all jurisdictions where clients, counterparties, or funds originate.",
        options: [
          "Australia only", "New Zealand", "South-East Asia", "East Asia", "South Asia",
          "Pacific Islands", "Europe (low-risk)", "Europe (higher-risk)",
          "Americas (low-risk)", "Americas (higher-risk)", "Middle East", "Africa", "Former Soviet states",
        ],
      },
      {
        key: "medium_risk_country", label: "Medium-risk country exposure", type: "yes-no",
        hint: "Do any clients or transactions involve jurisdictions rated medium risk in AUSTRAC / Basel AML Index?",
        options: ["Yes", "No"],
      },
      {
        key: "high_risk_country", label: "High-risk country exposure", type: "yes-no",
        hint: "Do any clients or transactions involve FATF grey-listed, high-risk, or DFAT-sanctioned jurisdictions?",
        options: ["Yes", "No"],
      },
      {
        key: "sanctions_screening_confirmed", label: "Sanctions Screening Status", type: "single-select",
        required: true,
        hint: "Is DFAT/OFAC/UN sanctions screening currently in place and operational for all new client onboarding?",
        options: ["Confirmed and operational", "In progress — partially implemented", "Not yet established"],
      },
    ],
  },
  {
    id: "ctrl_eff",
    label: "Control Effectiveness",
    desc: "Rate the current effectiveness of each control domain (1 = Initial/Ad-hoc → 5 = Optimised)",
    fields: [
      {
        key: "ctrlEff.cdd", label: "Customer Due Diligence (CDD)", type: "rating", min: 1, max: 5,
        hint: "CDD procedures, identity verification, beneficial ownership identification.",
        ratingLabels: ["", "Initial / Ad-hoc", "Developing", "Defined", "Managed", "Optimised"],
      },
      {
        key: "ctrlEff.tm", label: "Transaction Monitoring (TM)", type: "rating", min: 1, max: 5,
        hint: "Automated TM systems, threshold monitoring, anomaly detection.",
        ratingLabels: ["", "Initial / Ad-hoc", "Developing", "Defined", "Managed", "Optimised"],
      },
      {
        key: "ctrlEff.scr", label: "Sanctions & Screening (SCR)", type: "rating", min: 1, max: 5,
        hint: "DFAT/OFAC/UN sanctions screening at onboarding and ongoing.",
        ratingLabels: ["", "Initial / Ad-hoc", "Developing", "Defined", "Managed", "Optimised"],
      },
      {
        key: "ctrlEff.geo", label: "Geographic Risk Controls (GEO)", type: "rating", min: 1, max: 5,
        hint: "Country risk assessment, jurisdiction screening, FATF grey-list controls.",
        ratingLabels: ["", "Initial / Ad-hoc", "Developing", "Defined", "Managed", "Optimised"],
      },
      {
        key: "ctrlEff.gov", label: "Governance & Compliance (GOV)", type: "rating", min: 1, max: 5,
        hint: "Board oversight, CO accountability, training, annual reporting obligations.",
        ratingLabels: ["", "Initial / Ad-hoc", "Developing", "Defined", "Managed", "Optimised"],
      },
    ],
  },
];

// ── Validate CLIENT_FIELD_MAP against Client schema at startup ────────────────
; (function _validateClientFieldMap() {
  const missing = [];
  Object.entries(CLIENT_FIELD_MAP).forEach(([qKey, clientPath]) => {
    try {
      if (!Client.schema.path(clientPath)) {
        missing.push(`"${qKey}" → "${clientPath}"`);
      }
    } catch (_) {
      missing.push(`"${qKey}" → "${clientPath}" (validation error)`);
    }
  });
  if (missing.length) {
    console.warn("[CLIENT_FIELD_MAP] Paths not found in Client schema:", missing);
  }
})();

/**
 * Return the risk questionnaire schema with resolved field values.
 *
 * Without ?clientId  → sections + type-appropriate defaults for every field.
 * With    ?clientId  → each field value is resolved via priority chain:
 *                       1. Existing riskQuestions answer
 *                       2. Mapped client profile field (CLIENT_FIELD_MAP)
 *                       3. Type-appropriate default
 *
 * Each field in the response includes:
 *   value        – resolved value (always present)
 *   default      – type-appropriate fallback
 *   clientMapped – true when the field syncs to a client profile property
 *   clientPath   – the client document path (only when clientMapped is true)
 *
 * @route  GET /api/v1/clients/risk-questions/schema
 * @route  GET /api/v1/clients/risk-questions/schema?clientId=<id>
 */
exports.getRiskQuestionsSchema = asyncHandler(async (req, res, next) => {
  // Use the pre-populated client from the auth middleware (no extra DB round-trip).
  // Admins who have no linked client can still pass ?clientId=<id> explicitly.
  let client = req?.user?.client ?? null;

  if (!client && req.query.clientId) {
    client = await Client.findById(req.query.clientId);
    if (!client) {
      return next(new ErrorResponse(`Client not found with id of ${req.query.clientId}`, 404));
    }
  }

  const riskAnswers = client ? client.riskQuestions : {};
  const mappedKeys = new Set(Object.keys(CLIENT_FIELD_MAP));

  // entity_type maps to Client.clientType, which stores the EntityType _id.
  // Resolve it to the canonical EntityType name so the schema returns the
  // human-readable label (which matches the field's options) rather than an id.
  let entityTypeName = null;
  if (client?.clientType) {
    if (mongoose.isValidObjectId(client.clientType)) {
      const et = await EntityType.findById(client.clientType).select("name").lean();
      entityTypeName = et?.name || null;
    } else {
      // Legacy data: clientType already stored as a plain name string.
      entityTypeName = client.clientType;
    }
  }

  const enrichedSections = RISK_QUESTIONS_SCHEMA.map(section => ({
    ...section,
    fields: section.fields.map(field => {
      const clientMapped = mappedKeys.has(field.key);
      let value = resolveFieldValue(field, riskAnswers, client);
      // Never expose the raw clientType id for entity_type — use the name.
      if (field.key === "entity_type" && entityTypeName && mongoose.isValidObjectId(value)) {
        value = entityTypeName;
      }
      return {
        ...field,
        default: getTypeDefault(field),
        value,
        clientMapped,
        ...(clientMapped ? { clientPath: CLIENT_FIELD_MAP[field.key] } : {}),
      };
    }),
  }));

  const flat = RISK_QUESTIONS_SCHEMA.flatMap(s => s.fields).map(f => f.key);

  res.status(200).json({
    success: true,
    data: {
      sections: enrichedSections,
      fieldKeys: flat,
      totalFields: flat.length,
      ...(client ? { clientId: client._id } : {}),
    },
  });
});

/**
 * Upsert / merge riskQuestions on a client.
 * Merges the incoming questions object into the existing riskQuestions so
 * partial updates only overwrite the supplied keys.
 *
 * Bidirectional sync: any answer whose key appears in CLIENT_FIELD_MAP is
 * written back to the corresponding client profile field so both sources
 * stay consistent (e.g. co_name → legalRepresentative.name).
 *
 * @route  PUT /api/v1/client/:id/risk-questions
 */
/**
 * Upsert / merge riskQuestions on a client.
 * Merges the incoming questions object into the existing riskQuestions so
 * partial updates only overwrite the supplied keys.
 *
 * Bidirectional sync: any answer whose key appears in CLIENT_FIELD_MAP is
 * written back to the corresponding client profile field so both sources
 * stay consistent.
 *
 * entity_type sync (dual-write):
 *   riskQuestions.entity_type → name string  (always the human-readable label)
 *   client.clientType         → name string  (e.g. "Accountants")
 *   client.clientTypeId       → ObjectId str (EntityType._id as String)
 *
 * @route  PUT /api/v1/clients/:id/risk-questions
 */
exports.updateRiskQuestions = asyncHandler(async (req, res, next) => {
  const questions = req.body;

  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return next(new ErrorResponse("Body must contain a 'questions' object", 400));
  }

  const client = await Client.findById(req.params.id);
  if (!client) {
    return next(new ErrorResponse(`Client not found with id of ${req.params.id}`, 404));
  }

  // ── Resolve entity_type → both name string and ObjectId ──────────────────
  // Incoming value may be either a plain name ("Accountants") or an ObjectId string.
  let resolvedEntityName = null;   // → client.clientType  (name string)
  let resolvedEntityId = null;   // → client.clientTypeId (ObjectId as String)

  if (questions.entity_type !== undefined) {
    if (mongoose.isValidObjectId(questions.entity_type)) {
      // Incoming is an ObjectId — look up the name
      const et = await EntityType.findById(questions.entity_type).select("name").lean();
      if (et) {
        resolvedEntityId = String(et._id);
        resolvedEntityName = et.name;
      }
    } else {
      // Incoming is a plain name string — look up the ObjectId
      const et = await EntityType.findOne({ name: questions.entity_type }).select("_id").lean();
      resolvedEntityName = questions.entity_type;         // trust the name as-is
      resolvedEntityId = et?._id ? String(et._id) : null;
    }

    // Normalise what gets stored in riskQuestions.entity_type → always the name
    if (resolvedEntityName) {
      questions.entity_type = resolvedEntityName;
    }
  }

  // ── Merge answers into riskQuestions (partial update) ────────────────────
  Object.assign(client.riskQuestions, questions);

  // ── Bidirectional sync: write mapped answers back to client profile ───────
  // CLIENT_FIELD_MAP entry for entity_type now points to "clientTypeId"
  // (the ObjectId string field). clientType (name) is handled separately below.
  const syncedKeys = [];

  Object.entries(CLIENT_FIELD_MAP).forEach(([qKey, clientPath]) => {
    if (questions[qKey] === undefined) return;

    let valueToSync = questions[qKey];

    if (qKey === "entity_type") {
      // CLIENT_FIELD_MAP["entity_type"] === "clientTypeId"
      // Only sync if we successfully resolved an ObjectId
      if (!resolvedEntityId) return;
      valueToSync = resolvedEntityId;
    }

    const parts = clientPath.split(".");
    if (parts.length === 1) {
      client[parts[0]] = valueToSync;
    } else {
      // Ensure the parent object exists before setting a nested property
      if (!client[parts[0]] || typeof client[parts[0]] !== "object") {
        client[parts[0]] = {};
      }
      client[parts[0]][parts[1]] = valueToSync;
      client.markModified(parts[0]);
    }

    syncedKeys.push(qKey);
  });

  // ── Dual-write for entity_type: also keep clientType (name) in sync ───────
  if (questions.entity_type !== undefined) {
    if (resolvedEntityName) {
      client.clientType = resolvedEntityName;   // name string
    }
    if (resolvedEntityId) {
      client.clientTypeId = resolvedEntityId;     // ObjectId as String
    }
  }

  await client.save();

  res.status(200).json({
    success: true,
    data: {
      riskQuestions: client.riskQuestions,
      ...(syncedKeys.length ? { syncedClientFields: syncedKeys } : {}),
    },
  });

  runInBackground(`riskRegister:createFromClient:${client._id}`, async () => {
    await createRiskRegisterFromClient(client._id, {}, req.user);
    await markOnboardingStep({ client: client._id }, "risk_assessment", "completed", req.user?.id);
    await generateAMLDocsForClient(client._id, req.user?.id);
  });
});
/**
 * Optional: update client status (Active/Pending/Inactive/Blocked)
 * @route PUT /api/v1/clients/:id/status
 */
exports.updateClientStatus = asyncHandler(async (req, res, next) => {
  const { status, isActive } = req.body;
  const client = await Client.findById(req.params.id);
  if (!client) {
    return next(
      new ErrorResponse(`Client not found with id of ${req.params.id}`, 404)
    );
  }

  if (typeof status === "string") client.status = status;
  if (typeof isActive === "boolean") client.isActive = isActive;

  await client.save();

  res.status(200).json({
    success: true,
    data: client,
  });
});

// @desc   Create a single client
// @route  /api/v1/clients
// @access Public (or restrict as needed)
exports.createDummyClient = asyncHandler(async (req, res, next) => {
  // Validate request
  const isValid = await validateClientCreation(req.body, next);
  if (!isValid) return;

  const {
    name,
    clientType,
    clientTypeId,
    registrationNumber,
    taxId,
    email,
    phone,
    website,
    contacts,
    address,
    legalRepresentative,
    documents,
    status,
    settings,
    metadata,
    userName,
  } = req.body;

  let user = null;

  // Use emailHash for dedupe — plaintext email may be AES-encrypted at rest.
  user = await User.findOne({ emailHash: hashForSearch(email) });
  if (!user) {
    user = await User.create({
      name,
      email,
      password: "123456", // TODO: replace with random password
      isActive: true,
      userName,
    });
  }

  if (!user) return next(new ErrorResponse("Please try again!", 400));

  // Create client record
  const client = await Client.create({
    user: user._id,
    name,
    clientType,
    clientTypeId,
    registrationNumber,
    taxId,
    email,
    phone,
    website,
    contacts,
    address,
    legalRepresentative,
    documents,
    status,
    settings,
    metadata,
  });

  // Seed UserType AFTER Client exists so clientBelongs can be set correctly.
  await UserType.deleteOne({ user: user._id, userType: "client", role: "admin", clientBelongs: null, branchBelongs: null });
  await UserType.findOneAndUpdate(
    { user: user._id, userType: "client", role: "admin", clientBelongs: client._id, branchBelongs: null },
    { $setOnInsert: { isActive: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.status(201).json({
    succeed: true,
    data: client,
    id: client._id,
  });
});


