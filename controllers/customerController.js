const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");

const { hashToken } = require("../utils");
const sendEmail = require("../utils/sendEmail");
const sendSMS = require("../utils/sendSms");
const InvitationEmailTemplate = require("../utils/email-template/invitation");
const CompanyKyc = require("../models/CompanyKyc");
const NonIndividualKyc = require("../models/NonIndividualKyc");
const TrustKyc = require("../models/TrustKyc");

const Customer = require("../models/Customer");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const User = require("../models/User");
const UserType = require("../models/UserType");
const { generateQR } = require("../utils/qrService");
const { hashForSearch } = require("../utils/encryption");
const { ensureSumsubApplicant, requestPendingReview, triggerAmlCheck } = require("../services/sumsubService");
const { runInBackground } = require("../utils/backgroundJob");
const {
  findOrCreateJourney,
  syncJourneyStatus,
} = require("../services/journeyService");
const OnboardingJourney = require("../models/OnboardingJourney");
const { buildSeedJourney } = require("../utils/journeyUtils");

exports.filterCustomerSection = (c, requestBody) => {
  if (!requestBody || !requestBody.name) return true;
  return c.name
    .toLowerCase()
    .trim()
    .includes(requestBody.name.toLowerCase().trim());
};

// @desc   Get all Customers
// @route  /api/v1/customer
// @access Public (or restrict as needed)
exports.getCustomers = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Customer']
  #swagger.summary = 'Get All Customers '
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  // expects advancedResults middleware to populate res.advancedResults
  res.status(200).json(res.advancedResults);
});

// @desc   Fetch single client by id
// @route  /api/v1/customer/:id
// @access Public
exports.getCustomer = asyncHandler(async (req, res, next) => {

  const client =
    req?.user?.client?._id || null;

  const branch =
    req?.user?.branch?._id || null;

  const customer = await Customer.findById(req.params.id).populate("user");
  if (!customer) {
    return next(
      new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404),
    );
  }

  const userRole = req.user?.role;
  const data = customer.decryptForRole(userRole);

  // also decrypt the populated user document if it carries encrypted fields
  if (customer.user && typeof customer.user.decryptForRole === "function") {
    data.user = customer.user.decryptForRole(userRole);
  }

  const filter = { customer: req.params.id };
  if (client) filter.client = client;
  if (branch) filter.branch = branch;

  const journeys = await OnboardingJourney.find(filter)
    .populate({ path: "client", select: "name" })
    .populate({ path: "branch", select: "name" })
    .sort({ createdAt: -1 })
    .lean({ virtuals: true });

  const journeyData = journeys.length > 0 ? journeys : [buildSeedJourney(customer)];

  res.status(200).json({
    success: true,
    data,
    journeys: journeyData,
  });
});


// @desc   Fetch single client by id
// @route  /api/v1/customer/onboarding/:id
// @access Public
exports.getCustomerOnBoardData = asyncHandler(async (req, res, next) => {
  const { type } = req.query;

  const customer = await Customer.findById(req.params.id)
    .select("_id relations")
    .populate("relations.client", "name")
    .populate("relations.branch", "name")
    .populate("relations.relationId");

  if (!customer) {
    return next(
      new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404)
    );
  }

  // const models = {
  //   individual: Customer,
  //   company: CompanyKyc,
  //   partnership: NonIndividualKyc,
  //   government_body: NonIndividualKyc,
  //   association: NonIndividualKyc,
  //   cooperative: NonIndividualKyc,
  //   trust: TrustKyc,
  // };

  // const Model = models[type];

  // if (!Model) {
  //   return next(new ErrorResponse("Invalid onboarding type.", 400));
  // }



  const relations = customer?.relations ?? []

  const data = relations.filter(relation => relation.type === type)


  res.status(200).json({
    success: true,
    data,
  });
});
// @desc   PUT BY ID
// @route  /api/v1/customer/onboarding/:id/request
// @access Public
exports.submitCustomerOnboardRequest = asyncHandler(async (req, res, next) => {

  const { token } = req.query;

  const {
    relationType,
    client = null,
    branch = null,
    onboardingChannel = 'web',
    source = 'in-branch',
    notes = "",
    entityId = null,
  } = req.body;

  if (!token)
    return next(new ErrorResponse("token required", 400));

  const hashed = hashToken(token);

  console.log(hashed)

  let customer = await Customer.findById(req.params.id).populate("user _id relations");

  if (!customer)
    return next(new ErrorResponse("Invite/customer not found", 404));

  const relMatch = customer.findRelationByHashedToken(hashed);

  console.log(relMatch)
  if (!relMatch)
    return next(new ErrorResponse("Invalid invite token for this customer", 400));

  const { relation, index } = relMatch; // index used to update the matched relation in place

  if (!relation.inviteToken || !relation.inviteTokenExpire)
    return next(new ErrorResponse("This invite is not valid", 400));

  if (Date.now() > new Date(relation.inviteTokenExpire).getTime())
    return next(new ErrorResponse("Invite expired", 410));

  const models = {
    individual: 'Customer',
    company: 'CompanyKyc',
    partnership: 'NonIndividualKyc',
    government_body: 'NonIndividualKyc',
    association: 'NonIndividualKyc',
    cooperative: 'NonIndividualKyc',
    trust: 'TrustKyc',
  };

  const resolvedRelationModel = models[relationType];

  if (!resolvedRelationModel)
    return next(new ErrorResponse(`Unknown relationType: ${relationType}`, 400));

  // ✅ Update the invited relation in place (matched by hashed token) — do NOT push a duplicate
  const rel = customer.relations[index];
  rel.type = relationType;
  rel.relationModel = resolvedRelationModel;
  if (entityId) rel.relationId = entityId;
  if (onboardingChannel) rel.onboardingChannel = onboardingChannel;
  if (source) rel.source = source;
  if (notes) rel.notes = notes;
  rel.active = true;
  // Only override client/branch when explicitly provided (the invite already set them)
  if (client) rel.client = client;
  if (branch) rel.branch = branch;

  // Clear the relation-level invite token (and any legacy top-level token) before saving
  customer.clearRelationInvite(index);
  customer.clearInviteToken();

  await customer.save();

  res.status(200).json({
    success: true,
    message: `You are Verified as ${relationType}`,
    relMatch,
    relations: customer.relations,
  });
});
// POST /api/v1/invites
// body: { contact: { email?, phone? }, client, branch, expiresInMinutes, source, notes }

exports.createInviteOld = asyncHandler(async (req, res, next) => {
  const loggedInUser = req.user ?? null;
  let client;
  let branch;
  if (loggedInUser?.userType == "branch") {
    const loggedInBranch = await Branch.findOne({ user: loggedInUser?.id });
    branch = loggedInBranch?.id ?? null;
    client = loggedInBranch?.client ?? null;
  } else {
    const loggedInClient = await Client.findOne({ user: loggedInUser?.id });
    client = loggedInClient?.id ?? null;
    branch = null;
  }

  const {
    contact,
    //  client,
    //branch,
    relationType, // new: relation-level type (e.g. "individual"|"company")
    onboardingChannel, // new: relation-level channel
    source = "in-branch",
    notes = "",
  } = req.body;

  if (!contact || (!contact.email && !contact.phone)) {
    return next(new ErrorResponse("Provide email or phone to invite", 400));
  }
  if (!client) return next(new ErrorResponse("client is required", 400));

  // 1) validate client + branch
  const clientExists = await Client.findById(client);
  if (!clientExists) return next(new ErrorResponse("Client not found", 404));

  if (branch) {
    const br = await Branch.findById(branch);
    if (!br) return next(new ErrorResponse("Branch not found", 404));
    if (br.client && br.client.toString() !== client.toString()) {
      return next(
        new ErrorResponse("Branch does not belong to the client", 400),
      );
    }
  }

  // normalize contact
  const email = contact.email ? contact.email.toLowerCase() : null;
  const phone = contact.phone || null;

  // 2) try to find an existing user by email/phone
  let user = null;
  if (email) user = await User.findOne({ emailHash: hashForSearch(email) });
  if (!user && phone) user = await User.findOne({ phone });

  // helper: idempotently add relation to a customer doc (uses relationType & onboardingChannel)
  const addRelationToCustomer = async (customerDoc) => {
    const clientIdStr = client.toString();
    const branchIdStr = branch ? branch.toString() : null;

    const exists = customerDoc.relations.find((r) => {
      const rClient = r.client ? r.client.toString() : null;
      const rBranch = r.branch ? r.branch.toString() : null;
      // match when branch is null/undefined as well
      const branchMatches =
        branchIdStr === null ? !rBranch : rBranch === branchIdStr;
      return rClient === clientIdStr && branchMatches;
    });

    if (exists) {
      customerDoc.metadata = {
        ...customerDoc.metadata,
        email,
        phone,
      };
      await customerDoc.save();
      // update metadata if needed (including relation-level type/onboardingChannel)
      let changed = false;
      if (source && exists.source !== source) {
        exists.source = source;
        changed = true;
      }
      if (notes && exists.notes !== notes) {
        exists.notes = notes;
        changed = true;
      }
      if (relationType && exists.type !== relationType) {
        exists.type = relationType;
        changed = true;
      }
      if (onboardingChannel && exists.onboardingChannel !== onboardingChannel) {
        exists.onboardingChannel = onboardingChannel;
        changed = true;
      }
      if (!exists.active) {
        exists.active = true;
        changed = true;
      }
      if (changed) await customerDoc.save();
      return { customer: customerDoc, added: false };
    }

    // push new relation row with the type & onboardingChannel inside it
    customerDoc.relations.push({
      client,
      branch: branch || undefined,
      type: relationType || "individual",
      onboardingChannel: onboardingChannel || "",
      registeredAt: Date.now(),
      source,
      notes,
      active: true,
    });

    // optional: set primary pointers if you use them
    if (!customerDoc.primaryClient) customerDoc.primaryClient = client;
    if (!customerDoc.primaryBranch && branch)
      customerDoc.primaryBranch = branch;
    const metadata = {
      invitedBy: req.user ? req.user._id : null,
      client: client,
      branch: branch || null,
      ...contact,
    };
    customerDoc.metadata = metadata;
    await customerDoc.save();
    return { customer: customerDoc, added: true };
  };

  // 3) find or create the customer record
  let customer = null;
  if (user) {
    customer = await Customer.findOne({ user: user._id });
    if (!customer && email) {
      customer = await Customer.findOne({
        "personalKyc.personal_form.contact_details.email": email,
      });
    }
  }

  if (customer) {
    await addRelationToCustomer(customer);
  } else {
    // try to find any customer by email (maybe invited earlier)
    if (email) {
      customer = await Customer.findOne({
        "personalKyc.personal_form.contact_details.email": email,
      });
      if (customer) {
        await addRelationToCustomer(customer);
      }
    }
  }

  // if still no customer, create new pending customer with relation
  if (!customer) {
    customer = new Customer({
      // type: relationType || "individual", // top-level fallback (optional)
      relations: [
        {
          client,
          branch: branch || undefined,
          type: relationType || "individual",
          onboardingChannel: onboardingChannel || "",
          registeredAt: Date.now(),
          source,
          notes,
          active: true,
        },
      ],
      invitedBy: req.user ? req.user._id : null,
      metadata: {
        invitedBy: req.user ? req.user._id : null,
        client: client,
        branch: branch || null,
        ...contact,
      },
    });
    await customer.save();
  }

  // 4) ALWAYS generate a fresh invite token, save & send
  const plain = customer.generateInviteToken();
  await customer.save();

  const INVITE_BASE =
    process.env.CLIENT_INVITE_URL || "https://app.example.com/accept-invite";
  const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}`;

  // 5) send invite (prefer provided contact; fallback to user's contact)
  const targetEmail = email || (user && user.email) || null;
  const targetPhone = phone || (user && user.phone) || null;

  if (targetEmail) {
    try {
      const subject = `${clientExists.name} invited you to register`;
      const html = InvitationEmailTemplate(clientExists.name, url);
      await sendEmail({ email: targetEmail, subject, message: html });
    } catch (err) {
      console.error("sendEmail error", err);
    }
  }
  if (targetPhone) {
    try {
      const message = `You are invited to register: ${url}`;
      await sendSMS(targetPhone, message);
    } catch (err) {
      console.error("sendSMS error", err);
    }
  }

  // 6) Final response
  return res.status(201).json({
    success: true,
    message: "Invite created and sent",
    data: { customerId: customer._id },
    invite:
      process.env.NODE_ENV === "development"
        ? { url, token: plain }
        : undefined,
  });
});

// exports.createInvite = asyncHandler(async (req, res, next) => {
//   const loggedInUser = req.user ?? null;
//   let client;
//   let branch;

//   if (loggedInUser?.userType == "branch") {
//     const loggedInBranch = await Branch.findOne({ user: loggedInUser?.id });
//     branch = loggedInBranch?.id ?? null;
//     client = loggedInBranch?.client ?? null;
//   } else {
//     const loggedInClient = await Client.findOne({ user: loggedInUser?.id });
//     client = loggedInClient?.id ?? null;
//     branch = null;
//   }
//   // ... same client/branch resolution as before ...

//   const {
//     contact,
//     relationType = null,
//     onboardingChannel,
//     source = "in-branch",
//     notes = "",
//   } = req.body;
//   if (!contact || (!contact.email && !contact.phone))
//     return next(new ErrorResponse("Provide email or phone to invite", 400));
//   if (!client) return next(new ErrorResponse("client is required", 400));

//   // validate client + branch
//   const clientExists = await Client.findById(client);
//   if (!clientExists) return next(new ErrorResponse("Client not found", 404));

//   if (branch) {
//     const br = await Branch.findById(branch);
//     if (!br) return next(new ErrorResponse("Branch not found", 404));
//     if (br.client && br.client.toString() !== client.toString()) {
//       return next(
//         new ErrorResponse("Branch does not belong to the client", 400)
//       );
//     }
//   }

//   // find user by email/phone if exists
//   let user = null;
//   const email = contact.email ? contact.email.toLowerCase() : null;
//   const phone = contact.phone || null;
//   if (email) user = await User.findOne({ email });
//   if (!user && phone) user = await User.findOne({ phone });

//   // helper: find existing customer linked to that client/branch or create new
//   let customer = null;
//   if (user) {
//     customer = await Customer.findOne({ user: user._id });
//   }
//   // if (!customer && email) {
//   //   customer = await Customer.findOne({
//   //     "personalKyc.personal_form.contact_details.email": email,
//   //   });
//   // }

//   // Add relation if needed (reuse your addRelationToCustomer logic)...
//   // After ensuring the relation exists, find its index:
//   // find relation index that matches client+branch
//   const ensureRelation = async (customerDoc) => {
//     const clientIdStr = client.toString();
//     const branchIdStr = branch ? branch.toString() : null;
//     let idx = customerDoc.relations.findIndex((r) => {
//       const rClient = r.client ? r.client.toString() : null;
//       const rBranch = r.branch ? r.branch.toString() : null;
//       const branchMatches =
//         branchIdStr === null ? !rBranch : rBranch === branchIdStr;
//       return rClient === clientIdStr && branchMatches;
//     });
//     if (idx === -1) {
//       // create relation row
//       customerDoc.relations.push({
//         client,
//         branch: branch || undefined,
//         type: relationType || "individual",
//         onboardingChannel: onboardingChannel || "",
//         registeredAt: Date.now(),
//         source,
//         notes,
//         active: true,
//         invitedBy: req.user ? req.user._id : null,
//       });
//       await customerDoc.save();
//       idx = customerDoc.relations.length - 1;
//     } else {
//       // update relation fields if needed (same logic you had for update)
//       const r = customerDoc.relations[idx];
//       r.source = source || r.source;
//       r.notes = notes || r.notes;
//       r.type = relationType || r.type || "individual";
//       if (onboardingChannel) r.onboardingChannel = onboardingChannel;
//       r.active = true;
//       if (!r.invitedBy) r.invitedBy = req.user ? req.user._id : null;
//       await customerDoc.save();
//     }
//     return idx;
//   };

//   if (!customer) {
//     // create new customer with relation
//     customer = new Customer({
//       relations: [
//         {
//           client,
//           branch: branch || undefined,
//           type: relationType || "individual",
//           onboardingChannel: onboardingChannel || "",
//           registeredAt: Date.now(),
//           source,
//           notes,
//           active: true,
//           invitedBy: req.user ? req.user._id : null,
//         },
//       ],
//       metadata: {
//         invitedBy: req.user ? req.user._id : null,
//         client: client,
//         branch: branch || null,
//         ...contact,
//       },
//     });
//     await customer.save();
//   }

//   // ensure relation index
//   const relIndex = await ensureRelation(customer); // returns relation index

//   // generate invite token *for the relation*
//   const plain = customer.setRelationInvite(relIndex);
//   // set invitedBy explicitly on relation (if not already)
//   customer.relations[relIndex].invitedBy = req.user
//     ? req.user._id
//     : customer.relations[relIndex].invitedBy;
//   await customer.save();

//   const INVITE_BASE =
//     process.env.CLIENT_INVITE_URL || "http://localhost:3000/accept-invite";
//   const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}`;

//   // send invite (prefer provided contact; fallback to user's contact)

//   const targetEmail = email || (user && user.email) || null;
//   const targetPhone = phone || (user && user.phone) || null;
//   if (targetEmail) {
//     try {
//       const subject = `${clientExists.name} invited you to register`;
//       const html = InvitationEmailTemplate(clientExists.name, url);
//       await sendEmail({ email: targetEmail, subject, message: html });
//     } catch (err) {
//       console.error("sendEmail error", err);
//     }
//   }
//   if (targetPhone) {
//     try {
//       const message = `You are invited to register: ${url}`;
//       await sendSMS(targetPhone, message);
//     } catch (err) {
//       console.error("sendSMS error", err);
//     }
//   }

//   return res.status(201).json({
//     success: true,
//     message: "Invite created and sent",
//     data: { customerId: customer._id, relationIndex: relIndex },
//     invite:
//       process.env.NODE_ENV === "development"
//         ? { url, token: plain }
//         : undefined,
//   });
// });

exports.createInvite = asyncHandler(async (req, res, next) => {
  const loggedInUser = req.user ?? null;

  let client = null;
  let branch = null;

  // ---------------------------
  // Resolve client + branch
  // ---------------------------
  if (loggedInUser?.userType === "branch") {
    const b = await Branch.findOne({ user: loggedInUser.id });
    if (!b) return next(new ErrorResponse("Branch not found", 404));
    branch = b._id;
    client = b.client;
  } else {
    const c = await Client.findOne({ user: loggedInUser?.id });
    if (!c) return next(new ErrorResponse("Client not found", 404));
    client = c._id;
  }

  // ---------------------------
  // Input
  // ---------------------------
  const {
    contact,
    relationType,
    onboardingChannel,
    source = "in-branch",
    notes = "",
  } = req.body;

  if (!contact || (!contact.email && !contact.phone)) {
    return next(new ErrorResponse("Provide email or phone", 400));
  }

  // ---------------------------
  // Validate relationType
  // ---------------------------
  const allowedTypes = [
    "individual",
    "company",
    "partnership",
    "government_body",
    "association",
    "cooperative",
    "trust",
  ];

  const safeType = allowedTypes.includes(relationType)
    ? relationType
    : "individual";

  // ---------------------------
  // Find user
  // ---------------------------
  const email = contact.email?.toLowerCase() || null;
  const phone = contact.phone || null;

  let user = null;
  if (email) user = await User.findOne({ emailHash: hashForSearch(email) });
  if (!user && phone) user = await User.findOne({ phone });

  // If an account already exists for this contact, ensure they hold an active
  // "customer" UserType membership scoped to this invite's client/branch
  // (update-or-create). Anonymous invitees with no account yet get their
  // membership at accept-time instead (acceptInvitePersonal/acceptInviteEntity).
  if (user) {
    await UserType.findOneAndUpdate(
      {
        user: user._id,
        userType: "customer",
        role: "customer",
        clientBelongs: client ?? null,
        branchBelongs: branch ?? null,
      },
      { $set: { isActive: true }, $setOnInsert: { assignedBy: req.user?._id ?? null } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  // ---------------------------
  // Find customer
  // Pass 1: by linked User account
  // Pass 2: by metadata (email / phone / client / branch) — catches customers
  //         created from a previous anonymous invite with no User yet
  // ---------------------------
  let customer = user ? await Customer.findOne({ user: user._id }) : null;

  if (!customer) {
    const metaOr = [];
    if (email) metaOr.push({ "metadata.email": email });
    if (phone) metaOr.push({ "metadata.phone": phone });

    if (metaOr.length > 0) {
      const metaFilter = { $or: metaOr };
      if (client) metaFilter["metadata.client"] = client;
      if (branch) metaFilter["metadata.branch"] = branch;
      customer = await Customer.findOne(metaFilter);
    }
  }

  // ---------------------------
  // Create customer if needed
  // ---------------------------
  if (!customer) {
    customer = new Customer({
      relations: [
        {
          client,
          branch,
          type: safeType,
          onboardingChannel: onboardingChannel || "",
          source,
          notes,
          active: true,
          relationModel: "Customer",
          relationId: null,
          invitedBy: req.user?._id,
        },
      ],
      metadata: {
        invitedBy: req.user?._id,
        client,
        branch,
        ...contact,
      },
    });
  }

  // ---------------------------
  // 🔧 Repair old broken relations
  // ---------------------------
  customer.relations.forEach((r) => {
    if (!r.type) r.type = "individual";
  });

  // ---------------------------
  // Ensure relation exists
  // ---------------------------
  let relIndex = customer.relations.findIndex(
    (r) =>
      r.client?.toString() === client.toString() &&
      (branch ? r.branch?.toString() === branch.toString() : !r.branch),
  );

  if (relIndex === -1) {
    customer.relations.push({
      client,
      branch,
      type: safeType,
      onboardingChannel: onboardingChannel || "",
      source,
      notes,
      relationModel: "Customer",
      relationId: customer?._id,
      active: false,
      invitedBy: req.user?._id,
    });
    relIndex = customer.relations.length - 1;
  } else {
    const r = customer.relations[relIndex];
    r.type = safeType;
    r.source = source || r.source;
    r.notes = notes || r.notes;
    if (onboardingChannel) r.onboardingChannel = onboardingChannel;
    r.active = false;

    if (!r.relationModel) r.relationModel = "Customer";
    if (!r.relationId) r.relationId = r._id;
    if (!r.invitedBy) r.invitedBy = req.user?._id;
  }

  // ---------------------------
  // Set relation invite token
  // ---------------------------
  const plain = customer.setRelationInvite(relIndex);

  await customer.save();

  // ─────────────────────────────────────────────────────────────────────────
  // Sumsub applicant — idempotent creation
  // Runs after invite is persisted so invite creation never fails due to
  // a Sumsub API error. Result is included in the response for the caller.
  //
  // Decision tree (handled inside ensureSumsubApplicant):
  //   1. sumsubApplicantId exists locally  → verify it's still alive in Sumsub
  //   2. Not found locally                 → look up in Sumsub by externalUserId
  //   3. Not found in Sumsub               → create new applicant
  // ─────────────────────────────────────────────────────────────────────────
  let sumsubResult = null;
  let sumsubError = null;

  try {
    sumsubResult = await ensureSumsubApplicant(customer);
  } catch (err) {
    // Non-fatal — log and surface in response; invite is already saved
    sumsubError = err.message;
    console.error(
      "[createInvite] Sumsub applicant creation failed:",
      err.message,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Record journey_start step — creates/updates the OnboardingJourney so
  // the invite + Sumsub applicant creation is tracked in the local DB.
  // Non-fatal: a journey error must never fail the invite response.
  // ─────────────────────────────────────────────────────────────────────────
  let journeyId = null;
  try {
    const journey = await findOrCreateJourney({
      customerId: customer._id,
      clientId: client,
      branchId: branch || null,
      relationIndex: relIndex,
      channel: onboardingChannel || "Mobile App",
      provider: "sumsub",
    });

    const stepStatus = sumsubResult ? "approved" : "submitted";

    journey.setStepStatus("journey_start", stepStatus, {
      required: false, // tracking step — never blocks journey completion
      bumpAttempt: false,
      data: {
        inviteMethod: "direct",
        invitedBy: req.user?._id || null,
        applicantId: sumsubResult?.applicantId || null,
        inspectionId: sumsubResult?.inspectionId || null,
        applicantCreated: sumsubResult?.created ?? null,
        sumsubError: sumsubError || null,
        at: new Date(),
      },
    });

    journey.recordEvent({
      step: "journey_start",
      action: "invite_created",
      status: stepStatus,
      note: sumsubResult
        ? `Applicant ${sumsubResult.created ? "created" : "found"} in Sumsub (${sumsubResult.applicantId})`
        : `Invite created — Sumsub pending${sumsubError ? `: ${sumsubError}` : ""}`,
      actor: req.user?._id || null,
      actorRole: "staff",
      payload: {
        customerId: customer._id,
        inviteMethod: "direct",
        applicantId: sumsubResult?.applicantId || null,
        applicantCreated: sumsubResult?.created ?? null,
        sumsubError: sumsubError || undefined,
      },
    });

    syncJourneyStatus(journey);
    await journey.save();
    journeyId = journey._id;
  } catch (journeyErr) {
    console.error(
      "[createInvite] journey_start recording failed:",
      journeyErr.message,
    );
  }

  // ---------------------------
  // Build invite URL
  // ---------------------------
  const INVITE_BASE =
    process.env.CLIENT_INVITE_URL || "http://localhost:3000/accept-invite";

  const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}?client=${client}`;

  // ---------------------------
  // Send email / sms
  // ---------------------------
  const targetEmail = email || user?.email;
  const targetPhone = phone || user?.phone;

  if (targetEmail) {
    try {
      await sendEmail({
        email: targetEmail,
        subject: "You are invited to register",
        message: InvitationEmailTemplate("Client", url),
      });
    } catch (e) {
      console.error("email fail", e);
    }
  }

  if (targetPhone) {
    try {
      await sendSMS(targetPhone, `Register here: ${url}`);
    } catch (e) {
      console.error("sms fail", e);
    }
  }

  // ---------------------------
  // Response
  // ---------------------------
  res.status(201).json({
    success: true,
    message: "Invite created",
    data: {
      customerId: customer._id,
      relationIndex: relIndex,
      journeyId: journeyId || null,
      sumsub: sumsubResult
        ? {
          applicantId: sumsubResult.applicantId,
          inspectionId: sumsubResult.inspectionId,
          created: sumsubResult.created,
        }
        : null,
      sumsubError: sumsubError || undefined,
    },
    invite:
      process.env.NODE_ENV === "development"
        ? { url, token: plain }
        : undefined,
  });
});
exports.createInviteFromQr = asyncHandler(async (req, res, next) => {
  const {
    client,
    branch,
    contact,
    relationType = "individual",
    onboardingChannel = "app",
    source = "in-branch",
    notes = "",
  } = req.body;

  console.log(relationType)

  const verifyClient = await Client.findById(client);
  const verifyBranch = await Branch.findById(branch);

  if (client && !verifyClient) {
    return next(new ErrorResponse("Client ID not Valid", 400));
  }
  if (branch && !verifyBranch) {
    return next(new ErrorResponse("Branch ID not Valid", 400));
  }

  if (!contact || (!contact.email && !contact.phone)) {
    return next(new ErrorResponse("Provide email or phone", 400));
  }

  // ---------------------------
  // Validate relationType
  // ---------------------------
  const allowedTypes = [
    "individual",
    "company",
    "partnership",
    "government_body",
    "association",
    "cooperative",
    "trust",
  ];

  const safeType = allowedTypes.includes(relationType)
    ? relationType
    : "individual";

  // ---------------------------
  // Find user
  // ---------------------------
  const email = contact.email?.toLowerCase() || null;
  const phone = contact.phone || null;

  let user = null;
  if (email) user = await User.findOne({ emailHash: hashForSearch(email) });

  console.log(user)
  if (!user && phone) user = await User.findOne({ phone });

  // If an account already exists for this contact, ensure they hold an active
  // "customer" UserType membership scoped to this invite's client/branch
  // (update-or-create). Anonymous invitees with no account yet get their
  // membership at accept-time instead (acceptInvitePersonal/acceptInviteEntity).
  if (user) {
    await UserType.findOneAndUpdate(
      {
        user: user._id,
        userType: "customer",
        role: "customer",
        clientBelongs: client ?? null,
        branchBelongs: branch ?? null,
      },
      { $set: { isActive: true }, $setOnInsert: { assignedBy: req.user?._id ?? null } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  // ---------------------------
  // Find customer
  // Pass 1: by linked User account
  // Pass 2: by metadata (email / phone / client / branch) — catches customers
  //         created from a previous anonymous QR invite with no User yet
  // ---------------------------
  let customer = user ? await Customer.findOne({ user: user._id }) : null;



  if (!customer) {
    const metaOr = [];
    if (email) metaOr.push({ "metadata.email": email });
    if (phone) metaOr.push({ "metadata.phone": phone });

    if (metaOr.length > 0) {
      const metaFilter = { $or: metaOr };
      if (client) metaFilter["metadata.client"] = client;
      if (branch) metaFilter["metadata.branch"] = branch;
      customer = await Customer.findOne(metaFilter);
    }
  }
  // return res.status(200).json({
  //   customer,
  // });
  // ---------------------------
  // Create customer if needed
  // ---------------------------
  if (!customer) {
    customer = new Customer({
      relations: [
        {
          client,
          branch,
          type: safeType,
          onboardingChannel: onboardingChannel || "websdk",
          source,
          notes,
          active: false,

          invitedBy: req.user?._id,
        },
      ],
      metadata: {
        invitedBy: req.user?._id,
        client,
        branch,
        ...contact,
      },
    });
  }

  // ---------------------------
  // 🔧 Repair old broken relations
  // ---------------------------
  customer.relations.forEach((r) => {
    if (!r.type) r.type = "individual";
  });

  // ---------------------------
  // Ensure relation exists
  // ---------------------------
  let relIndex = customer.relations.findIndex(
    (r) =>
      r.client?.toString() === client.toString() &&
      (branch ? r.branch?.toString() === branch.toString() : !r.branch),
  );

  if (relIndex === -1) {
    customer.relations.push({
      client,
      branch,
      type: safeType,
      onboardingChannel: onboardingChannel || "",
      source,
      notes,
      active: true,
      invitedBy: req.user?._id,
    });
    relIndex = customer.relations.length - 1;
  } else {
    const r = customer.relations[relIndex];
    r.type = safeType;
    r.source = source || r.source;
    r.notes = notes || r.notes;
    if (onboardingChannel) r.onboardingChannel = onboardingChannel;
    r.active = true;
    if (!r.invitedBy) r.invitedBy = req.user?._id;
  }

  // ---------------------------
  // Set relation invite token
  // ---------------------------
  const plain = customer.setRelationInvite(relIndex);

  await customer.save();

  // ─────────────────────────────────────────────────────────────────────────
  // Sumsub applicant — idempotent creation
  // Runs after invite is persisted so invite creation never fails due to
  // a Sumsub API error. Result is included in the response for the caller.
  //
  // Decision tree (handled inside ensureSumsubApplicant):
  //   1. sumsubApplicantId exists locally  → verify it's still alive in Sumsub
  //   2. Not found locally                 → look up in Sumsub by externalUserId
  //   3. Not found in Sumsub               → create new applicant
  // ─────────────────────────────────────────────────────────────────────────
  let sumsubResult = null;
  let sumsubError = null;

  //TODO
  try {
    sumsubResult = await ensureSumsubApplicant(customer);
  } catch (err) {
    // Non-fatal — log and surface in response; invite is already saved
    sumsubError = err.message;
    console.error(
      "[createInviteFromQr] Sumsub applicant creation failed:",
      err.message,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Record journey_start step — creates/updates the OnboardingJourney so
  // the QR invite + Sumsub applicant creation is tracked in the local DB.
  // Non-fatal: a journey error must never fail the invite response.
  // ─────────────────────────────────────────────────────────────────────────
  let journeyId = null;
  try {
    const journey = await findOrCreateJourney({
      customerId: customer._id,
      clientId: client,
      branchId: branch || null,
      relationIndex: relIndex,
      channel: onboardingChannel || "app",
      provider: "dooit", //TODO Sumsub
    });

    const stepStatus = sumsubResult ? "approved" : "submitted";

    journey.setStepStatus("journey_start", stepStatus, {
      required: false, // tracking step — never blocks journey completion
      bumpAttempt: false,
      data: {
        inviteMethod: "qr",
        invitedBy: req.user?._id || null,
        applicantId: sumsubResult?.applicantId || null,
        inspectionId: sumsubResult?.inspectionId || null,
        applicantCreated: sumsubResult?.created ?? null,
        sumsubError: sumsubError || null,
        at: new Date(),
      },
    });

    journey.recordEvent({
      step: "journey_start",
      action: "invite_created",
      status: stepStatus,
      note: sumsubResult
        ? `Applicant ${sumsubResult.created ? "created" : "found"} in Sumsub (${sumsubResult.applicantId})`
        : `QR invite created — Sumsub pending${sumsubError ? `: ${sumsubError}` : ""}`,
      actor: req.user?._id || null,
      actorRole: "staff",
      payload: {
        customerId: customer._id,
        inviteMethod: "qr",
        applicantId: sumsubResult?.applicantId || null,
        applicantCreated: sumsubResult?.created ?? null,
        sumsubError: sumsubError || undefined,
      },
    });

    syncJourneyStatus(journey);
    await journey.save();
    journeyId = journey._id;
  } catch (journeyErr) {
    console.error(
      "[createInviteFromQr] journey_start recording failed:",
      journeyErr.message,
    );
  }

  // ---------------------------
  // Build invite URL
  // ---------------------------
  const INVITE_BASE =
    process.env.CLIENT_INVITE_URL || "http://localhost:3000/accept-invite";

  const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}`;

  // ---------------------------
  // Response
  // ---------------------------
  res.status(201).json({
    success: true,
    message: "Invite created",
    data: {
      url,
      customerId: customer._id,
      token: plain,
      relationIndex: relIndex,
      journeyId: journeyId || null,
      sumsub: sumsubResult
        ? {
          applicantId: sumsubResult.applicantId,
          inspectionId: sumsubResult.inspectionId,
          created: sumsubResult.created,
        }
        : null,
      sumsubError: sumsubError || undefined,
    },
    invite:
      process.env.NODE_ENV === "development"
        ? { url, token: plain, customerId: customer._id }
        : undefined,
  });
});

// GET /api/v1/invites/validate?token=...&cid=...
exports.validateInviteOld = asyncHandler(async (req, res, next) => {
  const { token, cid } = req.query;

  if (!token || !cid)
    return next(new ErrorResponse("token and cid required", 400));
  // const customer = await Customer.findById(cid).populate(
  //   "relations.client relations.branch user"
  // );
  const customer = await Customer.findById(cid).populate("user");
  if (!customer)
    return next(new ErrorResponse("Invite/customer not found", 404));

  if (!customer.inviteToken || !customer.inviteTokenExpire) {
    return next(new ErrorResponse("This invite is not valid", 400));
  }

  const hashed = hashToken(token);
  if (hashed !== customer.inviteToken)
    return next(new ErrorResponse("Invalid invite token", 400));
  if (Date.now() > new Date(customer.inviteTokenExpire).getTime())
    return next(new ErrorResponse("Invite expired", 410));

  // suggested contact info from customer's personalKyc
  const email = customer.metadata?.email ?? null;
  const phone = customer.metadata.phone ?? null;

  // Check user existence:
  // 1) If customer.user exists, prefer that (linked user)
  // 2) Otherwise check by suggestedEmail and suggestedPhone
  let user = null;
  let userExists = false;
  let linkedToCustomer = false;

  if (customer.user) {
    user = await User.findById(customer.user);
    if (user) {
      userExists = true;
      linkedToCustomer = true;
    } else {
      // customer.user reference broken; clear flag
      linkedToCustomer = false;
    }
  } else {
    if (email) {
      user = await User.findOne({ emailHash: hashForSearch(email) });
    }
    if (!user && phone) {
      user = await User.findOne({ phone });
    }
    if (user) userExists = true;
  }

  res.status(200).json({
    success: true,
    data: {
      customerId: customer._id,
      //  relations: customer.relations,
      email,
      phone,
      userExists,
      userId: user ? user._id : null,
      linkedToCustomer,
      isInviteActive: customer.isInviteActive,
      user,
    },
  });
});
exports.validateInvite = asyncHandler(async (req, res, next) => {
  const { token, cid } = req.query;
  if (!token || !cid)
    return next(new ErrorResponse("token and cid required", 400));

  const hashed = hashToken(token);

  // if cid provided, prefer that doc and find matching relation
  let customer = await Customer.findById(cid).populate("user");
  if (!customer)
    return next(new ErrorResponse("Invite/customer not found", 404));

  // find relation whose inviteToken matches
  const relMatch = customer.findRelationByHashedToken(hashed);
  if (!relMatch) {
    return next(
      new ErrorResponse("Invalid invite token for this customer", 400),
    );
  }
  const { relation, index } = relMatch;

  if (!relation.inviteToken || !relation.inviteTokenExpire) {
    return next(new ErrorResponse("This invite is not valid", 400));
  }
  if (Date.now() > new Date(relation.inviteTokenExpire).getTime()) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  // suggested contact info
  const email = customer.metadata?.email ?? null;
  const phone = customer.metadata?.phone ?? null;

  // check user existence logic (unchanged)
  let user = null;
  let userExists = false;
  let linkedToCustomer = false;
  if (customer.user) {
    user = await User.findById(customer.user);
    if (user) {
      userExists = true;
      linkedToCustomer = true;
    } else linkedToCustomer = false;
  } else {
    if (email) user = await User.findOne({ emailHash: hashForSearch(email) });
    if (!user && phone) user = await User.findOne({ phone });
    if (user) userExists = true;
  }

  res.status(200).json({
    success: true,
    data: {
      customerId: customer._id,
      relationIndex: index,
      relation: {
        client: relation.client,
        branch: relation.branch,
        type: relation.type,
        onboardingChannel: relation.onboardingChannel,
      },
      email,
      phone,
      userExists,
      userId: user ? user._id : null,
      linkedToCustomer,
      isInviteActive: !!(
        relation.inviteToken &&
        relation.inviteTokenExpire &&
        relation.inviteTokenExpire > Date.now()
      ),
      user,
    },
  });
});

/**
 * Merge/update personalKyc into customer.personalKyc (shallow merge)
 */
async function upsertPersonalKyc(customer, incomingPersonalKyc) {
  if (!incomingPersonalKyc || Object.keys(incomingPersonalKyc).length === 0) {
    return customer.personalKyc && Object.keys(customer.personalKyc).length > 0;
  }

  customer.personalKyc = Object.assign(
    {},
    customer.personalKyc || {},
    incomingPersonalKyc,
  );
  return true;
}

/**
 * acceptInvitePersonal
 * - Upsert personal KYC for invited customer
 * - Link user -> customer
 * - Finalize: clear invite token and activate
 */
exports.acceptInvitePersonalOld = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, personalKyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));

  const hashed = hashToken(token);
  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
    if (!customer.inviteToken || customer.inviteToken !== hashed)
      return next(
        new ErrorResponse("Invalid invite token for this customer", 400),
      );
  } else {
    customer = await Customer.findOne({ inviteToken: hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  // expiry
  if (
    !customer.inviteTokenExpire ||
    Date.now() > new Date(customer.inviteTokenExpire).getTime()
  ) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  // ensure invite has client info
  const clientId = customer.metadata?.client || null;
  const branchId = customer.metadata?.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  // link user if needed
  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // upsert personal KYC (merge)
  const hasPersonalNow = await upsertPersonalKyc(customer, personalKyc || {});

  // finalize and persist
  if (hasPersonalNow) {
    customer.kycStatus = "in_review";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "in_review",
      note: "Personal KYC provided by invited user",
      changedBy: user._id,
      changedAt: Date.now(),
    });

    // persist metadata
    customer.metadata = customer.metadata || {};
    customer.metadata.client = clientId;
    if (branchId) customer.metadata.branch = branchId;

    // finalize: clear token & activate
    customer.clearInviteToken();
    customer.isActive = true;

    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Personal KYC accepted and invite finalised",
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
      },
    });
  }

  // fallback — shouldn't normally happen
  return next(new ErrorResponse("Failed to process personal KYC", 500));
});

exports.acceptInvitePersonal = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, personalKyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));
  const hashed = hashToken(token);

  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
  } else {
    // find by relation token across customers
    customer = await Customer.findOne({ "relations.inviteToken": hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  // find matching relation
  const relMatch = customer.findRelationByHashedToken(hashed);
  if (!relMatch) return next(new ErrorResponse("Invalid invite token", 400));
  const { relation, index: relIndex } = relMatch;

  // expiry
  if (
    !relation.inviteTokenExpire ||
    Date.now() > new Date(relation.inviteTokenExpire).getTime()
  ) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  // ensure invite has client info (relation has client)
  const clientId = relation.client;
  const branchId = relation.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  // link user if needed
  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // upsert personal KYC (same helper)
  const hasPersonalNow = await upsertPersonalKyc(customer, personalKyc || {});

  // ✅ Activate the matched relation
  customer.relations[relIndex].active = true;
  // finalize and persist
  if (hasPersonalNow) {
    customer.kycStatus = "in_review";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "in_review",
      note: "Personal KYC provided by invited user",
      changedBy: user._id,
      changedAt: Date.now(),
    });

    // persist relation-level metadata (if desired)
    // keep top-level metadata.client for convenience if you want:
    customer.metadata = customer.metadata || {};
    customer.metadata.client = clientId;
    if (branchId) customer.metadata.branch = branchId;

    // clear token **only for this relation**
    customer.clearRelationInvite(relIndex);

    // optionally activate customer (business rule)
    customer.isActive = true;

    await customer.save();

    // Ensure a customer UserType membership scoped to this client/branch exists
    // for the invited user. Their baseline membership from registration is
    // unscoped (clientBelongs/branchBelongs null); accepting the invite ties
    // them to this specific tenant. Idempotent via the unique index.
    await UserType.findOneAndUpdate(
      {
        user: user._id,
        userType: "customer",
        role: "customer",
        clientBelongs: clientId,
        branchBelongs: branchId,
      },
      { $setOnInsert: { isActive: true, assignedBy: user._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (customer?.sumsubApplicantId) {
      console.log(`Request to review to sum sub — scheduling background job`.bgBlue);
      runInBackground(`sumsub:pendingReview+aml [${customer.sumsubApplicantId}]`, async () => {
        await requestPendingReview(customer.sumsubApplicantId);
        await triggerAmlCheck(customer);
      });
    }


    return res.status(200).json({
      success: true,
      message: "Personal KYC accepted and invite finalised (relation-level)",
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
        relationIndex: relIndex,
      },
    });
  }

  return next(new ErrorResponse("Failed to process personal KYC", 500));
});

/**
 * Helper: upsert entity doc for Company/Trust/NonIndividual
 * returns the doc or null
 */
async function upsertEntityModel(
  Model,
  payload,
  customerId,
  clientId,
  branchId,
) {
  if (!payload || Object.keys(payload).length === 0) {
    // return existing if any
    return await Model.findOne({ customer: customerId, client: clientId });
  }

  let doc = await Model.findOne({
    customer: customerId,
    client: clientId,
    branch: branchId || undefined,
  });
  if (!doc) {
    payload.client = clientId;
    if (branchId) payload.branch = branchId;
    payload.customer = customerId;
    doc = await Model.create(payload);
  } else {
    // merge important sub docs shallowly
    const keys = Object.keys(payload);
    keys.forEach((k) => {
      if (k === "general_information" || k === "trust_details") {
        doc[k] = Object.assign({}, doc[k] || {}, payload[k] || {});
      } else {
        doc[k] = payload[k];
      }
    });
    await doc.save();
  }
  return doc;
}

/**
 * acceptInviteEntity
 * - Handles company/trust/nonIndividual types
 * - Upserts entity KYC doc
 * - DOES NOT clear invite token unless BOTH personalKyc present AND entity KYC present
 * - If missing pieces, returns a structured response listing what's still required
 */
exports.acceptInviteEntityOld = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, requestedType, kyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));
  if (!requestedType)
    return next(new ErrorResponse("requestedType is required", 400));

  const hashed = hashToken(token);
  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
    if (!customer.inviteToken || customer.inviteToken !== hashed)
      return next(
        new ErrorResponse("Invalid invite token for this customer", 400),
      );
  } else {
    customer = await Customer.findOne({ inviteToken: hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  // expiry
  if (
    !customer.inviteTokenExpire ||
    Date.now() > new Date(customer.inviteTokenExpire).getTime()
  )
    return next(new ErrorResponse("Invite expired", 410));

  const clientId = customer.metadata?.client || null;
  const branchId = customer.metadata?.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  // link user if needed
  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // ensure personalKyc presence
  const hasPersonal =
    customer.personalKyc && Object.keys(customer.personalKyc).length > 0;

  // Upsert entity doc (if payload provided) OR try find existing
  let createdKycDoc = null;
  let typeKycPresent = false;

  if (requestedType === "company") {
    createdKycDoc = await upsertEntityModel(
      CompanyKyc,
      kyc,
      customer._id,
      clientId,
      branchId,
    );
  } else if (requestedType === "trust") {
    createdKycDoc = await upsertEntityModel(
      TrustKyc,
      kyc,
      customer._id,
      clientId,
      branchId,
    );
  } else if (
    ["partnership", "government_body", "association", "cooperative"].includes(
      requestedType,
    )
  ) {
    createdKycDoc = await upsertEntityModel(
      NonIndividualKyc,
      kyc,
      customer._id,
      clientId,
      branchId,
    );
  } else {
    return next(new ErrorResponse("Unsupported requestedType", 400));
  }

  if (createdKycDoc) {
    typeKycPresent = true;
  }

  // persist metadata client/branch
  customer.metadata = customer.metadata || {};
  customer.metadata.client = clientId;
  if (branchId) customer.metadata.branch = branchId;

  // Determine what's missing
  const missing = [];
  if (!hasPersonal) missing.push("personalKyc"); // representative details (required)
  if (!typeKycPresent) missing.push(`${requestedType}Kyc`);

  if (missing.length > 0) {
    // Do NOT clear token. Save customer with updated metadata (and possibly linked user).
    customer.kycStatus = "pending";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "pending",
      note: `Processed entity KYC input for type ${requestedType}; missing: ${missing.join(
        ", ",
      )}`,
      changedBy: user._id,
      changedAt: Date.now(),
    });

    await customer.save();

    // Return structured response telling frontend what to do next
    return res.status(200).json({
      success: true,
      message: "Entity KYC processed but additional steps required",
      required: missing, // frontend can use this to route the user
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
        createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
      },
    });
  }

  // If we reach here: both personal and entity KYC present -> finalise
  customer.kycStatus = "in_review";
  customer.kycHistory = customer.kycHistory || [];
  customer.kycHistory.push({
    status: "in_review",
    note: `Entity (${requestedType}) KYC provided & representative personal KYC present`,
    changedBy: user._id,
    changedAt: Date.now(),
  });

  // finalize: clear token & activate
  customer.clearInviteToken();
  customer.isActive = true;

  await customer.save();

  return res.status(200).json({
    success: true,
    message: "Entity KYC accepted and invite finalised",
    data: {
      customerId: customer._id,
      userId: user._id,
      kycStatus: customer.kycStatus,
      createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
    },
  });
});
// controllers/customerController.js (replace acceptInviteEntity with this)
exports.acceptInviteEntityOld2 = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, requestedType, kyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));
  if (!requestedType)
    return next(new ErrorResponse("requestedType is required", 400));

  const hashed = hashToken(token);

  // find customer: prefer cid then fallback to any customer with relation token
  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
  } else {
    customer = await Customer.findOne({ "relations.inviteToken": hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  // locate the relation that matches the hashed token
  const match = customer.findRelationByHashedToken(hashed);
  if (!match) return next(new ErrorResponse("Invalid invite token", 400));
  const { relation, index: relIndex } = match;

  // invite expiry check (relation-level)
  if (
    !relation.inviteTokenExpire ||
    Date.now() > new Date(relation.inviteTokenExpire).getTime()
  ) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  // ensure relation has client info
  const clientId = relation.client;
  const branchId = relation.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  // link user -> customer if needed
  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // Optional: update relation type/onboardingChannel if provided (keeps relation consistent)
  if (requestedType && relation.type !== requestedType) {
    relation.type = requestedType;
  }
  // persist any provided relation-level onboardingChannel
  if (req.body.onboardingChannel) {
    relation.onboardingChannel = req.body.onboardingChannel;
  }

  // upsert entity-level KYC doc (single normalized payload 'kyc')
  let createdKycDoc = null;
  let typeKycPresent = false;

  try {
    if (requestedType === "company") {
      createdKycDoc = await upsertEntityModel(
        CompanyKyc,
        kyc,
        customer._id,
        clientId,
        branchId,
      );
    } else if (requestedType === "trust") {
      createdKycDoc = await upsertEntityModel(
        TrustKyc,
        kyc,
        customer._id,
        clientId,
        branchId,
      );
    } else if (
      ["partnership", "government_body", "association", "cooperative"].includes(
        requestedType,
      )
    ) {
      createdKycDoc = await upsertEntityModel(
        NonIndividualKyc,
        kyc,
        customer._id,
        clientId,
        branchId,
      );
    } else {
      return next(new ErrorResponse("Unsupported requestedType", 400));
    }

    if (createdKycDoc) {
      typeKycPresent = true;
      // attach KYC doc id to relation for traceability (persist ref on relation)
      relation.entityKycId = createdKycDoc._id;
      // optionally store the model name so you know which collection holds the doc
      relation.entityKycModel =
        createdKycDoc.constructor && createdKycDoc.constructor.modelName
          ? createdKycDoc.constructor.modelName
          : null;
    }
  } catch (err) {
    console.error("upsertEntityModel error", err);
    return next(new ErrorResponse("Failed to store entity KYC", 500));
  }
  // ✅ Activate the matched relation
  customer.relations[relIndex].active = true;
  // persist client/branch into top-level metadata for quick access (optional)
  customer.metadata = customer.metadata || {};
  customer.metadata.client = clientId;
  if (branchId) customer.metadata.branch = branchId;

  // Ensure a customer UserType membership scoped to this client/branch exists
  // for the invited user (registration baseline is unscoped). Seeded on both the
  // "missing steps" and "finalised" paths since the user is already linked to the
  // relation here. Idempotent via the unique index.
  await UserType.findOneAndUpdate(
    {
      user: user._id,
      userType: "customer",
      role: "customer",
      clientBelongs: clientId,
      branchBelongs: branchId,
    },
    { $setOnInsert: { isActive: true, assignedBy: user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // check presence of personal KYC (representative) on the customer
  const hasPersonal =
    customer.personalKyc && Object.keys(customer.personalKyc).length > 0;

  // what remains to be completed
  const missing = [];
  if (!hasPersonal) missing.push("personalKyc");
  if (!typeKycPresent) missing.push(`${requestedType}Kyc`);

  if (missing.length > 0) {
    // do NOT clear the invite token (relation-level) — let invite stay active for completing steps
    customer.kycStatus = "pending";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "pending",
      note: `Entity KYC input processed for type ${requestedType}; missing: ${missing.join(
        ", ",
      )}`,
      changedBy: user._id,
      changedAt: Date.now(),
    });

    // persist relation updates and save
    customer.relations[relIndex] = relation;
    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Entity KYC processed; additional steps required",
      required: missing,
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
        createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
        relationIndex: relIndex,
      },
    });
  }

  // both personal KYC and entity KYC present -> finalize
  customer.kycStatus = "in_review";
  customer.kycHistory = customer.kycHistory || [];
  customer.kycHistory.push({
    status: "in_review",
    note: `Entity (${requestedType}) KYB provided & representative personal KYC present`,
    changedBy: user._id,
    changedAt: Date.now(),
  });

  // clear invite only for this relation and activate customer
  customer.clearRelationInvite(relIndex);
  customer.isActive = true;

  // persist relation (with entityKycId) + save
  customer.relations[relIndex] = relation;
  await customer.save();

  return res.status(200).json({
    success: true,
    message: "Entity KYC accepted and invite finalised for relation",
    data: {
      customerId: customer._id,
      userId: user._id,
      kycStatus: customer.kycStatus,
      createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
      relationIndex: relIndex,
    },
  });
});
exports.acceptInviteEntity = asyncHandler(async (req, res, next) => {
  const user = req.user;
  if (!user) return next(new ErrorResponse("Authentication required", 401));

  const { token, cid, requestedType, kyc } = req.body;
  if (!token) return next(new ErrorResponse("token is required", 400));
  if (!requestedType)
    return next(new ErrorResponse("requestedType is required", 400));

  const hashed = hashToken(token);

  let customer;
  if (cid) {
    customer = await Customer.findById(cid);
    if (!customer) return next(new ErrorResponse("Customer not found", 404));
  } else {
    customer = await Customer.findOne({ "relations.inviteToken": hashed });
    if (!customer) return next(new ErrorResponse("Invite not found", 404));
  }

  const match = customer.findRelationByHashedToken(hashed);
  if (!match) return next(new ErrorResponse("Invalid invite token", 400));
  const { relation, index: relIndex } = match;

  if (
    !relation.inviteTokenExpire ||
    Date.now() > new Date(relation.inviteTokenExpire).getTime()
  ) {
    return next(new ErrorResponse("Invite expired", 410));
  }

  const clientId = relation.client;
  const branchId = relation.branch || null;
  if (!clientId)
    return next(new ErrorResponse("Invite missing client info", 400));

  if (!customer.user || customer.user.toString() !== user._id.toString()) {
    customer.user = user._id;
  }

  // ✅ Use index consistently — no more mutating `relation` ref directly
  if (requestedType && customer.relations[relIndex].type !== requestedType) {
    customer.relations[relIndex].type = requestedType;
  }
  if (req.body.onboardingChannel) {
    customer.relations[relIndex].onboardingChannel = req.body.onboardingChannel;
  }

  // ✅ Activate the matched relation on ALL paths
  customer.relations[relIndex].active = true;

  let createdKycDoc = null;
  let typeKycPresent = false;

  // ✅ Explicit model name map — no more constructor.modelName risk
  const kycModelNames = {
    company: 'CompanyKyc',
    trust: 'TrustKyc',
    partnership: 'NonIndividualKyc',
    government_body: 'NonIndividualKyc',
    association: 'NonIndividualKyc',
    cooperative: 'NonIndividualKyc',
  };

  try {
    if (requestedType === "company") {
      createdKycDoc = await upsertEntityModel(CompanyKyc, kyc, customer._id, clientId, branchId);
    } else if (requestedType === "trust") {
      createdKycDoc = await upsertEntityModel(TrustKyc, kyc, customer._id, clientId, branchId);
    } else if (
      ["partnership", "government_body", "association", "cooperative"].includes(requestedType)
    ) {
      createdKycDoc = await upsertEntityModel(NonIndividualKyc, kyc, customer._id, clientId, branchId);
    } else {
      return next(new ErrorResponse("Unsupported requestedType", 400));
    }

    if (createdKycDoc) {
      typeKycPresent = true;
      // ✅ Set via index, with explicit model name
      customer.relations[relIndex].entityKycId = createdKycDoc._id;
      customer.relations[relIndex].entityKycModel = kycModelNames[requestedType];
      // customer.relations[relIndex].type = requestedType;
    }
  } catch (err) {
    console.error("upsertEntityModel error", err);
    return next(new ErrorResponse("Failed to store entity KYC", 500));
  }

  customer.metadata = customer.metadata || {};
  customer.metadata.client = clientId;
  if (branchId) customer.metadata.branch = branchId;

  await UserType.findOneAndUpdate(
    {
      user: user._id,
      userType: "customer",
      role: "customer",
      clientBelongs: clientId,
      branchBelongs: branchId,
    },
    { $setOnInsert: { isActive: true, assignedBy: user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const hasPersonal =
    customer.personalKyc && Object.keys(customer.personalKyc).length > 0;

  const missing = [];
  if (!hasPersonal) missing.push("personalKyc");
  if (!typeKycPresent) missing.push(`${requestedType}Kyc`);

  if (missing.length > 0) {
    customer.kycStatus = "pending";
    customer.kycHistory = customer.kycHistory || [];
    customer.kycHistory.push({
      status: "pending",
      note: `Entity KYC input processed for type ${requestedType}; missing: ${missing.join(", ")}`,
      changedBy: user._id,
      changedAt: Date.now(),
    });

    // ✅ No more redundant `customer.relations[relIndex] = relation`
    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Entity KYC processed; additional steps required",
      required: missing,
      data: {
        customerId: customer._id,
        userId: user._id,
        kycStatus: customer.kycStatus,
        createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
        relationIndex: relIndex,
      },
    });
  }

  // customer.kycStatus = "in_review";
  customer.kycHistory = customer.kycHistory || [];
  customer.kycHistory.push({
    status: "in_review",
    note: `Entity (${requestedType}) KYB provided & representative personal KYC present`,
    changedBy: user._id,
    changedAt: Date.now(),
  });

  customer.clearRelationInvite(relIndex);
  customer.isActive = true;

  // ✅ No more redundant `customer.relations[relIndex] = relation`
  await customer.save();

  return res.status(200).json({
    success: true,
    message: "Entity KYB accepted and invite finalised for relation",
    data: {
      customerId: customer._id,
      userId: user._id,
      kycStatus: customer.kycStatus,
      createdKycDocId: createdKycDoc ? createdKycDoc._id : null,
      relationIndex: relIndex,
    },
  });
});
/**
 * Dispatcher: direct to personal or entity handlers
 */
exports.acceptInvite = asyncHandler(async (req, res, next) => {
  const { requestedType } = req.body;

  if (!requestedType || requestedType === "individual") {
    return exports.acceptInvitePersonal(req, res, next);
  }
  return exports.acceptInviteEntity(req, res, next);
});

/**
 * POST /api/customers/create-with-user
 * Body: the JSON you provided
 */
exports.createCustomerDummy = asyncHandler(async (req, res, next) => {
  /*
  #swagger.tags = ['Onboarding']
  #swagger.summary = 'Dummy Customer Insert'
  #swagger.parameters['body'] = { in: 'body', required: true, schema: { $ref: '#/definitions/DummyCustomer' } }
  #swagger.responses[200] = { description: 'Success' }
  #swagger.responses[400] = { description: 'Bad Request' }
  #swagger.responses[401] = { description: 'Unauthorized' }
*/
  const body = req.body || {};
  const { kyc } = body;

  // sensible defaults
  const DEFAULT_PASSWORD = "123456";
  const saltRounds = 10;

  // map possible incoming requestedType values to canonical ones
  const mapRequestedType = (t) => {
    if (!t) return "individual";
    const s = String(t).toLowerCase();
    if (["individual"].includes(s)) return "individual";
    if (["company", "corporate", "corp"].includes(s)) return "company";
    if (["trust"].includes(s)) return "trust";
    if (["partnership"].includes(s)) return "partnership";
    if (["government_body", "government", "gov"].includes(s))
      return "government_body";
    if (["association", "cooperative"].includes(s)) return "association";
    return s; // fallback
  };

  const requestedType = mapRequestedType(body.requestedType);

  // start mongoose session for transaction
  const session = await mongoose.startSession();
  try {
    let createdUser = null;
    let createdCustomer = null;
    let createdKyc = [];

    await session.withTransaction(async () => {
      // 1) Find client / branch by name (if provided)
      // branchName preferred — try Branch model and also return its client
      let clientDoc = null;
      let branchDoc = null;

      if (body.branchName) {
        branchDoc = await Branch.findOne({
          name: { $regex: `^${escapeRegExp(body.branchName)}$`, $options: "i" },
        })
          .session(session)
          .populate("client");
        if (branchDoc) clientDoc = branchDoc.client || null;
      }
      if (!clientDoc && body.clientName) {
        clientDoc = await Client.findOne({
          name: { $regex: `^${escapeRegExp(body.clientName)}$`, $options: "i" },
        }).session(session);
      }

      if (!clientDoc) {
        return next(
          new ErrorResponse(`Client Not found, please check client name`, 404),
        );
      }
      if (body.branchName && !branchDoc) {
        return next(
          new ErrorResponse(`Branch Not found, please check client name`, 404),
        );
      }

      // 2) Find or create user by email or userName
      const userPayload = {
        name:
          body.name ||
          `${body.personalKyc?.personal_form?.customer_details?.given_name || ""
            } ${body.personalKyc?.personal_form?.customer_details?.surname || ""
            }`.trim() ||
          body.userName ||
          "Unnamed",
        userName: body.userName,
        email: body.email,
        userType: body.userType || "customer",
        role: body.role || "customer",
        isActive: true,
      };

      // Try find existing user by email or userName
      const existingUser = await User.findOne({
        $or: [
          { emailHash: hashForSearch(userPayload.email) },
          { userName: userPayload.userName },
        ],
      }).session(session);

      if (existingUser) {
        createdUser = existingUser;
      } else {
        const hashed = await bcrypt.hash(DEFAULT_PASSWORD, saltRounds);
        const userToCreate = new User({
          ...userPayload,
          password: hashed,
          photoUrl: User.schema.paths.photoUrl?.defaultValue || undefined,
        });
        createdUser = await userToCreate.save({ session });
      }

      // 2b) Seed this customer's UserType membership scoped to the resolved
      // client/branch. Idempotent — the unique (user, userType, role, client,
      // branch) index dedupes, so re-imports never create duplicate rows.
      await UserType.findOneAndUpdate(
        {
          user: createdUser._id,
          userType: userPayload.userType,
          role: userPayload.role,
          clientBelongs: clientDoc ? clientDoc._id : null,
          branchBelongs: branchDoc ? branchDoc._id : null,
        },
        { $setOnInsert: { isActive: true, assignedBy: req.user?._id ?? null } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      );

      // 3) Build relation object (if we have client or branch info)
      const relationCandidate =
        clientDoc || branchDoc
          ? {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            type: requestedType,
            onboardingChannel: body.onboardingChannel || "API",
            registeredAt: body.registeredAt
              ? new Date(body.registeredAt)
              : new Date(),
            source: body.source || "api",
            notes: body.notes || "",
            active: true,
          }
          : null;

      // 4) Create or update Customer
      let customerDoc = await Customer.findOne({
        user: createdUser._id,
      }).session(session);

      if (customerDoc) {
        // ensure relations array exists
        customerDoc.relations = customerDoc.relations || [];

        // if relationCandidate exists, check if same client+branch relation already present
        if (relationCandidate) {
          const exists = customerDoc.relations.some((r) => {
            const sameClient = relationCandidate.client
              ? String(r.client) === String(relationCandidate.client)
              : true;
            const sameBranch = relationCandidate.branch
              ? String(r.branch) === String(relationCandidate.branch)
              : true;
            return sameClient && sameBranch;
          });
          if (!exists) {
            customerDoc.relations.push(relationCandidate);
          } else {
            // update existing relation fields if needed (merge)
            customerDoc.relations = customerDoc.relations.map((r) => {
              const matchClient =
                relationCandidate.client &&
                String(r.client) === String(relationCandidate.client);
              const matchBranch =
                relationCandidate.branch &&
                String(r.branch) === String(relationCandidate.branch);
              if (matchClient || matchBranch) {
                return Object.assign(r, relationCandidate);
              }
              return r;
            });
          }
        }

        // update some other fields from payload if provided
        if (body.personalKyc) customerDoc.personalKyc = body.personalKyc;
        if (body.documents) customerDoc.documents = body.documents;
        if (body.declaration) customerDoc.declaration = body.declaration;
        if (body.country) customerDoc.country = body.country;
        customerDoc.isActive = true;

        // save updated customer
        createdCustomer = await customerDoc.save({ session });
      } else {
        // create new customer
        const customerPayload = {
          user: createdUser ? createdUser._id : null,
          personalKyc: body.personalKyc || {},
          documents: body.documents || [],
          declaration: body.declaration || {},
          country: body.country || "Bangladesh",
          consentToScreen: body.consentToScreen || false,
          isActive: true,
          metadata: body.metadata || {},
          relations: relationCandidate ? [relationCandidate] : [],
        };
        const newCustomer = new Customer(customerPayload);
        createdCustomer = await newCustomer.save({ session });
      }

      // 5) If requestedType is not individual, FIND-AND-UPDATE (or create) KYC
      if (requestedType !== "individual") {
        if (!createdCustomer || !createdCustomer._id) {
          throw new ErrorResponse(
            "Customer creation failed before KYC creation",
            500,
          );
        }

        /**
         * Helper: try find existing kyc record using typical unique fields,
         * update if found, otherwise create new.
         *
         * `model` - mongoose model (CompanyKyc / TrustKyc / NonIndividualKyc)
         * `findQuery` - object to locate existing record (should include client/branch/customer if applicable)
         * `payload` - data to set/create
         * Returns { action: 'created'|'updated', doc }
         */
        async function findOrUpdateKyc(model, findQuery, payload) {
          // try find existing
          const existing = await model.findOne(findQuery).session(session);
          if (existing) {
            // merge payload into existing doc (shallow merge)
            Object.assign(existing, payload);
            await existing.save({ session });
            return { action: "updated", doc: existing };
          } else {
            const created = await model.create([payload], { session });
            return { action: "created", doc: created[0] };
          }
        }

        // Build reasonable queries for each KYC type using common unique fields
        if (requestedType === "company") {
          // Prefer registration number, then legal name / registered business name
          const possibleReg =
            (kyc &&
              (kyc.general_information?.registration_number ||
                kyc.registration_number)) ||
            (kyc && (kyc.registrationNumber || kyc.registration_number));
          const possibleName =
            (kyc && (kyc.general_information?.legal_name || kyc.legal_name)) ||
            (kyc &&
              (kyc.general_information?.registered_business_name ||
                kyc.registered_business_name));

          let findQuery = { customer: createdCustomer._id };
          if (possibleReg) {
            findQuery["general_information.registration_number"] = possibleReg;
          } else if (possibleName) {
            findQuery["general_information.legal_name"] = possibleName;
          } else {
            // fallback to searching by customer + client/branch
            findQuery = {
              customer: createdCustomer._id,
              client: clientDoc ? clientDoc._id : undefined,
              branch: branchDoc ? branchDoc._id : undefined,
            };
          }

          const compPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            general_information: (kyc && kyc.general_information) || {},
            documents: (kyc && kyc.documents) || body.documents || [],
            ...kyc, // include other KYC fields if present (careful with collisions)
          };

          const result = await findOrUpdateKyc(
            CompanyKyc,
            findQuery,
            compPayload,
          );
          createdKyc.push({
            type: "CompanyKyc",
            action: result.action,
            id: result.doc._id,
            message:
              result.action === "updated"
                ? `CompanyKyc updated (id: ${result.doc._id})`
                : `CompanyKyc created (id: ${result.doc._id})`,
          });
        } else if (requestedType === "trust") {
          // Prefer trust name or registration numbers when available
          const possibleTrustName =
            (kyc &&
              (kyc.trust_details?.full_trust_name || kyc.full_trust_name)) ||
            (kyc && kyc.trustName);

          const possibleReg =
            (kyc &&
              (kyc.trust_details?.trust_type?.unregulated_trust
                ?.registration_number ||
                kyc.trust_details?.trust_type?.self_managed_super_fund?.abn)) ||
            (kyc && kyc.registrationNumber);

          let findQuery = { customer: createdCustomer._id };
          if (possibleTrustName) {
            findQuery["trust_details.full_trust_name"] = possibleTrustName;
          } else if (possibleReg) {
            // try the registration number in common nested paths
            findQuery[
              "trust_details.trust_type.unregulated_trust.registration_number"
            ] = possibleReg;
          } else {
            findQuery = {
              customer: createdCustomer._id,
              client: clientDoc ? clientDoc._id : undefined,
              branch: branchDoc ? branchDoc._id : undefined,
            };
          }

          const trustPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            trust_details: (kyc && kyc.trust_details) || {},
            documents: (kyc && kyc.documents) || body.documents || [],
            ...kyc,
          };

          const result = await findOrUpdateKyc(
            TrustKyc,
            findQuery,
            trustPayload,
          );
          createdKyc.push({
            type: "TrustKyc",
            action: result.action,
            id: result.doc._id,
            message:
              result.action === "updated"
                ? `TrustKyc updated (id: ${result.doc._id})`
                : `TrustKyc created (id: ${result.doc._id})`,
          });
        } else {
          // NonIndividualKyc: try registered_business_name or entity_name
          const possibleName =
            (kyc &&
              (kyc.general_information?.registered_business_name ||
                kyc.registered_business_name)) ||
            (kyc && (kyc.general_information?.entity_name || kyc.entity_name));

          let findQuery = { customer: createdCustomer._id };
          if (possibleName) {
            findQuery["general_information.registered_business_name"] =
              possibleName;
          } else {
            findQuery = {
              customer: createdCustomer._id,
              client: clientDoc ? clientDoc._id : undefined,
              branch: branchDoc ? branchDoc._id : undefined,
            };
          }

          const nonIndPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            general_information: (kyc && kyc.general_information) || {},
            documents: (kyc && kyc.documents) || body.documents || [],
            ...kyc,
          };

          const result = await findOrUpdateKyc(
            NonIndividualKyc,
            findQuery,
            nonIndPayload,
          );
          createdKyc.push({
            type: "NonIndividualKyc",
            action: result.action,
            id: result.doc._id,
            message:
              result.action === "updated"
                ? `NonIndividualKyc updated (id: ${result.doc._id})`
                : `NonIndividualKyc created (id: ${result.doc._id})`,
          });
        }
      } // end KYC block
    }); // end transaction

    // return created items (refresh customer to include generated uid)
    const resultCustomer = await Customer.findById(createdCustomer._id)
      .populate("user", "name email uid userName")
      .populate("relations.client")
      .populate("relations.branch")
      .lean();

    // SECURITY NOTE: we return a flag that a default password was created.
    res.status(201).json({
      success: true,
      message: "Customer (and user/kyc where applicable) created",
      data: {
        user: {
          _id: createdUser._id,
          name: createdUser.name,
          userName: createdUser.userName,
          email: createdUser.email,
          // DO NOT return password or hashed password.
          defaultPasswordSet: existingWas(createdUser) ? false : true,
        },
        customer: resultCustomer,
        kyc: createdKyc,
      },
    });

    // helper to check existing user earlier (we can't reference existingUser outside transaction easily)
    function existingWas(u) {
      // if sequence existed before creation it's probably existing, but best is to check createdAt vs now.
      // For simplicity: assume defaultPasswordSet true only if createdAt is within last 2 minutes
      return new Date() - new Date(u.createdAt) > 120000;
    }
  } catch (err) {
    console.error("createCustomerWithUserAndKyc error:", err);
    throw err; // asyncHandler will turn into 500 response
  } finally {
    session.endSession();
  }
});

function escapeRegExp(string) {
  return String(string || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

///Company Controller:

// Get many company KYC records (with filters, pagination, search)
exports.getCompanyKycs = asyncHandler(async (req, res, next) => {
  // Query params: page, limit, client, branch, customer, reg (registration number),
  // uid, sequence, search (legal_name or trading_names), sort
  const {
    page = 1,
    limit = 25,
    client,
    branch,
    customer,
    reg,
    uid,
    sequence,
    search,
    sort = "-createdAt",
  } = req.query;

  const qPage = Math.max(parseInt(page, 10) || 1, 1);
  const qLimit = Math.max(parseInt(limit, 10) || 25, 1);

  const filter = {};

  if (client) filter.client = client;
  if (branch) filter.branch = branch;
  if (customer) filter.customer = customer;
  if (uid) filter.uid = uid;
  if (sequence) filter.sequence = Number(sequence);
  if (reg)
    filter["general_information.registration_number"] = String(reg).trim();

  if (search) {
    const rx = new RegExp(String(search).trim(), "i");
    filter.$or = [
      { "general_information.legal_name": rx },
      { "general_information.trading_names": rx },
    ];
  }

  const skip = (qPage - 1) * qLimit;
  const total = await CompanyKyc.countDocuments(filter);
  const pages = Math.ceil(total / qLimit);

  const docs = await CompanyKyc.find(filter)
    // .populate("client", "name _id")
    // .populate("branch", "name _id")
    // .populate("customer", "personalKyc country isPep sanction kycStatus") // adjust fields as you like
    .sort(sort)
    .skip(skip)
    .limit(qLimit)
    .lean();

  res.status(200).json({
    success: true,
    count: docs.length,
    total,
    page: qPage,
    pages,
    data: docs,
  });
});

// Get single company KYC by id|uid|sequence
exports.getCompanyKyc = asyncHandler(async (req, res, next) => {
  const identifier = req.params.id; // can be ObjectId, uid (COMKYC_...), or sequence number

  // Try find by Mongo ObjectId
  let doc = null;
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);

  if (isObjectId) {
    doc = await CompanyKyc.findById(identifier)
      // .populate("client", "name _id")
      // .populate("branch", "name _id")
      .populate("customer", "personalKyc country isPep sanction kycStatus")
      .lean();
  }

  // If not found by ObjectId, try uid match (e.g. COMKYC_123456) or sequence
  if (!doc) {
    // if identifier looks like COMKYC_* or contains non-numeric chars treat as uid
    if (typeof identifier === "string" && identifier.match(/^COMKYC_/i)) {
      doc = await CompanyKyc.findOne({ uid: identifier })
        .populate("client", "name _id")
        .populate("branch", "name _id")
        .populate("customer", "user _id")
        .lean();
    } else if (!Number.isNaN(Number(identifier))) {
      // numeric -> sequence
      doc = await CompanyKyc.findOne({ sequence: Number(identifier) })
        .populate("client", "name _id")
        .populate("branch", "name _id")
        .populate("customer", "user _id")
        .lean();
    } else {
      // fallback: try search by legal_name (exact) as last resort
      doc = await CompanyKyc.findOne({
        "general_information.legal_name": identifier,
      })
        .populate("client", "name _id")
        .populate("branch", "name _id")
        .populate("customer", "user _id")
        .lean();
    }
  }

  if (!doc) {
    return next(
      new ErrorResponse(
        `CompanyKyc not found for identifier: ${identifier}`,
        404,
      ),
    );
  }

  res.status(200).json({
    success: true,
    data: doc,
  });
});

///For Trust:

// Get many trust KYC records
exports.getTrustKycs = asyncHandler(async (req, res, next) => {
  const {
    page = 1,
    limit = 25,
    client,
    branch,
    customer,
    uid,
    sequence,
    abn,
    reg,
    search,
    sort = "-createdAt",
  } = req.query;

  const qPage = Math.max(parseInt(page, 10) || 1, 1);
  const qLimit = Math.max(parseInt(limit, 10) || 25, 1);

  const filter = {};

  if (client) filter.client = client;
  if (branch) filter.branch = branch;
  if (customer) filter.customer = customer;
  if (uid) filter.uid = uid;
  if (sequence) filter.sequence = Number(sequence);

  // Trust registration filters
  if (reg) {
    filter["trust_details.trust_type.unregulated_trust.registration_number"] =
      String(reg).trim();
  }

  if (abn) {
    filter["trust_details.trust_type.self_managed_super_fund.abn"] =
      String(abn).trim();
  }

  // search by trust name
  if (search) {
    const rx = new RegExp(String(search).trim(), "i");
    filter["trust_details.full_trust_name"] = rx;
  }

  const skip = (qPage - 1) * qLimit;

  const total = await TrustKyc.countDocuments(filter);
  const pages = Math.ceil(total / qLimit);

  const docs = await TrustKyc.find(filter)
    // .populate("client", "name _id")
    // .populate("branch", "name _id")
    // .populate("customer", "personalKyc country isPep sanction kycStatus")
    .sort(sort)
    .skip(skip)
    .limit(qLimit)
    .lean();

  res.status(200).json({
    success: true,
    count: docs.length,
    total,
    page: qPage,
    pages,
    data: docs,
  });
});

// Get single trust KYC by id | uid | sequence
exports.getTrustKyc = asyncHandler(async (req, res, next) => {
  const identifier = req.params.id;

  let doc = null;
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);

  // Try ObjectId
  if (isObjectId) {
    doc = await TrustKyc.findById(identifier)
      .populate("client", "name _id")
      .populate("branch", "name _id")
      .populate("customer", "personalKyc country isPep sanction kycStatus")
      .lean();
  }

  // Try UID
  if (!doc && /^TRKYC_/i.test(identifier)) {
    doc = await TrustKyc.findOne({ uid: identifier })
      .populate("client", "name _id")
      .populate("branch", "name _id")
      .populate("customer", "user _id")
      .lean();
  }

  // Try sequence
  if (!doc && !Number.isNaN(Number(identifier))) {
    doc = await TrustKyc.findOne({ sequence: Number(identifier) })
      .populate("client", "name _id")
      .populate("branch", "name _id")
      .populate("customer", "user _id")
      .lean();
  }

  // Try trust name fallback
  if (!doc) {
    doc = await TrustKyc.findOne({
      "trust_details.full_trust_name": identifier,
    })
      .populate("client", "name _id")
      .populate("branch", "name _id")
      .populate("customer", "user _id")
      .lean();
  }

  if (!doc) {
    return next(
      new ErrorResponse(
        `TrustKyc not found for identifier: ${identifier}`,
        404,
      ),
    );
  }

  res.status(200).json({
    success: true,
    data: doc,
  });
});

///For Non individual by Type
exports.getNonIndividualKycs = asyncHandler(async (req, res, next) => {
  function buildNonIndividualTypeFilter(type) {
    switch (type) {
      case "partnership":
        return { "partnership.partnership_type": { $exists: true, $ne: null } };

      case "government_body":
        return {
          "government_body.government_body_type": { $exists: true, $ne: null },
        };

      case "association":
      case "cooperative":
        return {
          "association_cooperative.entity_type": { $exists: true, $ne: null },
        };

      default:
        return {};
    }
  }

  const {
    page = 1,
    limit = 25,
    client,
    branch,
    customer,
    type,
    uid,
    sequence,
    search,
    sort = "-createdAt",
  } = req.query;

  const qPage = Math.max(parseInt(page, 10) || 1, 1);
  const qLimit = Math.max(parseInt(limit, 10) || 25, 1);

  const filter = {};

  if (client) filter.client = client;
  if (branch) filter.branch = branch;
  if (customer) filter.customer = customer;
  if (uid) filter.uid = uid;
  if (sequence) filter.sequence = Number(sequence);

  // ✅ type filter
  if (type) {
    Object.assign(filter, buildNonIndividualTypeFilter(type));
  }

  // ✅ search by name
  if (search) {
    const rx = new RegExp(search, "i");
    filter.$or = [
      { "general_information.entity_name": rx },
      { "general_information.registered_business_name": rx },
    ];
  }

  const skip = (qPage - 1) * qLimit;

  const total = await NonIndividualKyc.countDocuments(filter);
  const pages = Math.ceil(total / qLimit);
  console.log(filter);
  const docs = await NonIndividualKyc.find(filter)
    .sort(sort)
    .skip(skip)
    .limit(qLimit)
    .lean();

  res.status(200).json({
    success: true,
    count: docs.length,
    total,
    page: qPage,
    pages,
    data: docs,
  });
});

exports.downloadQR = asyncHandler(async (req, res, next) => {
  const { format = "png" } = req.query;

  const clientId = req.user?.client?._id;
  const branchId = req.user?.branch?._id || null;

  if (!clientId) {
    return next(new ErrorResponse("Client not found for this user", 400));
  }

  // ============================
  // Generate QR
  // ============================

  const qr = await generateQR({
    clientId: clientId.toString(),
    branchId: branchId ? branchId.toString() : null,
    format,
    useUrl: true,
  });

  // ============================
  // Send File
  // ============================

  if (format === "svg") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=qr-${branchId || clientId}.svg`,
    );
    return res.send(qr);
  }

  // Default PNG
  res.setHeader("Content-Type", "image/png");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=qr-${branchId || clientId}.png`,
  );

  return res.send(qr);
});
