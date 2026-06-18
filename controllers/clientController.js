// controllers/client.controller.js
const asyncHandler = require("../middleware/async");
const Client = require("../models/Client");
const User = require("../models/User");
const { validateClientCreation } = require("../utils");
const ErrorResponse = require("../utils/errorResponse");
const { generateQR } = require("../utils/qrService");

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

  user = await User.findOne({
    email,
    userName,
  });
  if (!user) {
    user = await User.create({
      name,
      email,
      userType: "client",
      password: "123456", // TODO: replace with random password
      role: "admin",
      isActive: true,
      userName,
    });
  }
  // Create new user

  if (!user) return next(new ErrorResponse("Please try again!", 400));

  // Create client record
  const client = await Client.create({
    user: user._id,
    name,
    clientType,
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

  res.status(201).json({
    succeed: true,
    data: client,
    id: client._id,
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
      { key: "abn",           label: "ABN",             type: "text",  placeholder: "XX XXX XXX XXX" },
      { key: "assessDate",    label: "Assessment Date",  type: "date" },
      {
        key: "austrac_enrolled", label: "AUSTRAC Enrolment Status", type: "single-select",
        options: ["Enrolled and current", "Enrolment in progress", "Not yet enrolled", "Exempt"],
      },
      { key: "co_name",  label: "Compliance Officer — Name",  type: "text",  required: true, placeholder: "Full name" },
      { key: "co_email", label: "Compliance Officer — Email", type: "email", placeholder: "co@firm.com.au" },
      { key: "co_phone", label: "Compliance Officer — Phone", type: "text",  placeholder: "+61 4xx xxx xxx" },
      { key: "sm_name",  label: "Senior Manager — Name",      type: "text",  placeholder: "Full name" },
      { key: "sm_email", label: "Senior Manager — Email",     type: "email", placeholder: "sm@firm.com.au" },
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

/**
 * Return the risk questionnaire schema (sections + fields + options).
 * Fully static — no DB call. Used by UI to data-bind dynamic question forms.
 * @route  GET /api/v1/clients/risk-questions/schema
 */
exports.getRiskQuestionsSchema = asyncHandler(async (req, res) => {
  const flat = RISK_QUESTIONS_SCHEMA.flatMap(s => s.fields).map(f => f.key);
  res.status(200).json({
    success: true,
    data: {
      sections: RISK_QUESTIONS_SCHEMA,
      fieldKeys: flat,
      totalFields: flat.length,
    },
  });
});

/**
 * Upsert / merge riskQuestions on a client.
 * Merges the incoming questions object into the existing riskQuestions,
 * so partial updates only overwrite the supplied keys.
 * @route  PUT /api/v1/clients/:id/risk-questions
 */
exports.updateRiskQuestions = asyncHandler(async (req, res, next) => {
  const { questions } = req.body;

  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return next(new ErrorResponse("Body must contain a 'questions' object", 400));
  }

  const client = await Client.findById(req.params.id);
  if (!client) {
    return next(new ErrorResponse(`Client not found with id of ${req.params.id}`, 404));
  }

  // Merge individual keys so a partial update only overwrites supplied fields
  Object.assign(client.riskQuestions, questions);
  await client.save();

  res.status(200).json({ success: true, data: { riskQuestions: client.riskQuestions } });
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

  user = await User.findOne({
    email,
    userName,
  });
  if (!user) {
    user = await User.create({
      name,
      email,
      userType: "client",
      password: "123456", // TODO: replace with random password
      role: "admin",
      isActive: true,
      userName,
    });
  }
  // Create new user

  if (!user) return next(new ErrorResponse("Please try again!", 400));

  // Create client record
  const client = await Client.create({
    user: user._id,
    name,
    clientType,
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

  res.status(201).json({
    succeed: true,
    data: client,
    id: client._id,
  });
});


