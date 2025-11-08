const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Customer = require("../models/Customer");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const User = require("../models/User");

const { createInviteToken, hashToken } = require("../utils");
const sendEmail = require("../utils/sendEmail");
const sendSMS = require("../utils/sendSms");
const InvitationEmailTemplate = require("../utils/email-template/invitation");
const CompanyKyc = require("../models/CompanyKyc");
const NonIndividualKyc = require("../models/NonIndividualKyc");
const TrustKyc = require("../models/TrustKyc");

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
  // expects advancedResults middleware to populate res.advancedResults
  res.status(200).json(res.advancedResults);
});

// @desc   Fetch single client by id
// @route  /api/v1/clients/:id
// @access Public
exports.getCustomer = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.params.id).populate("user");

  if (!customer) {
    return next(
      new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404)
    );
  }
  res.status(200).json({
    success: true,
    data: customer,
  });
});

// POST /api/v1/invites
// body: { contact: { email?, phone? }, client, branch, expiresInMinutes, source, notes }

exports.createInvite = asyncHandler(async (req, res, next) => {
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
        new ErrorResponse("Branch does not belong to the client", 400)
      );
    }
  }

  // normalize contact
  const email = contact.email ? contact.email.toLowerCase() : null;
  const phone = contact.phone || null;

  // 2) try to find an existing user by email/phone
  let user = null;
  if (email) user = await User.findOne({ email });
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

// GET /api/v1/invites/validate?token=...&cid=...
exports.validateInvite = asyncHandler(async (req, res, next) => {
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
      user = await User.findOne({ email });
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
    incomingPersonalKyc
  );
  return true;
}

/**
 * acceptInvitePersonal
 * - Upsert personal KYC for invited customer
 * - Link user -> customer
 * - Finalize: clear invite token and activate
 */
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
    if (!customer.inviteToken || customer.inviteToken !== hashed)
      return next(
        new ErrorResponse("Invalid invite token for this customer", 400)
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

/**
 * Helper: upsert entity doc for Company/Trust/NonIndividual
 * returns the doc or null
 */
async function upsertEntityModel(
  Model,
  payload,
  customerId,
  clientId,
  branchId
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
    if (!customer.inviteToken || customer.inviteToken !== hashed)
      return next(
        new ErrorResponse("Invalid invite token for this customer", 400)
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
      branchId
    );
  } else if (requestedType === "trust") {
    createdKycDoc = await upsertEntityModel(
      TrustKyc,
      kyc,
      customer._id,
      clientId,
      branchId
    );
  } else if (
    ["partnership", "government_body", "association", "cooperative"].includes(
      requestedType
    )
  ) {
    createdKycDoc = await upsertEntityModel(
      NonIndividualKyc,
      kyc,
      customer._id,
      clientId,
      branchId
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
        ", "
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
