const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Customer = require("../models/Customer");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const User = require("../models/User");

const { hashToken } = require("../utils");
const sendEmail = require("../utils/sendEmail");
const sendSMS = require("../utils/sendSms");
const InvitationEmailTemplate = require("../utils/email-template/invitation");
const CompanyKyc = require("../models/CompanyKyc");
const NonIndividualKyc = require("../models/NonIndividualKyc");
const TrustKyc = require("../models/TrustKyc");
const { default: mongoose } = require("mongoose");

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
  // ... same client/branch resolution as before ...

  const {
    contact,
    relationType,
    onboardingChannel,
    source = "in-branch",
    notes = "",
  } = req.body;
  if (!contact || (!contact.email && !contact.phone))
    return next(new ErrorResponse("Provide email or phone to invite", 400));
  if (!client) return next(new ErrorResponse("client is required", 400));

  // validate client + branch
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

  // find user by email/phone if exists
  let user = null;
  const email = contact.email ? contact.email.toLowerCase() : null;
  const phone = contact.phone || null;
  if (email) user = await User.findOne({ email });
  if (!user && phone) user = await User.findOne({ phone });

  // helper: find existing customer linked to that client/branch or create new
  let customer = null;
  if (user) {
    customer = await Customer.findOne({ user: user._id });
  }
  // if (!customer && email) {
  //   customer = await Customer.findOne({
  //     "personalKyc.personal_form.contact_details.email": email,
  //   });
  // }

  // Add relation if needed (reuse your addRelationToCustomer logic)...
  // After ensuring the relation exists, find its index:
  // find relation index that matches client+branch
  const ensureRelation = async (customerDoc) => {
    const clientIdStr = client.toString();
    const branchIdStr = branch ? branch.toString() : null;
    let idx = customerDoc.relations.findIndex((r) => {
      const rClient = r.client ? r.client.toString() : null;
      const rBranch = r.branch ? r.branch.toString() : null;
      const branchMatches =
        branchIdStr === null ? !rBranch : rBranch === branchIdStr;
      return rClient === clientIdStr && branchMatches;
    });
    if (idx === -1) {
      // create relation row
      customerDoc.relations.push({
        client,
        branch: branch || undefined,
        type: relationType || "individual",
        onboardingChannel: onboardingChannel || "",
        registeredAt: Date.now(),
        source,
        notes,
        active: true,
        invitedBy: req.user ? req.user._id : null,
      });
      await customerDoc.save();
      idx = customerDoc.relations.length - 1;
    } else {
      // update relation fields if needed (same logic you had for update)
      const r = customerDoc.relations[idx];
      r.source = source || r.source;
      r.notes = notes || r.notes;
      if (relationType) r.type = relationType;
      if (onboardingChannel) r.onboardingChannel = onboardingChannel;
      r.active = true;
      if (!r.invitedBy) r.invitedBy = req.user ? req.user._id : null;
      await customerDoc.save();
    }
    return idx;
  };

  if (!customer) {
    // create new customer with relation
    customer = new Customer({
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
          invitedBy: req.user ? req.user._id : null,
        },
      ],
      metadata: {
        invitedBy: req.user ? req.user._id : null,
        client: client,
        branch: branch || null,
        ...contact,
      },
    });
    await customer.save();
  }

  // ensure relation index
  const relIndex = await ensureRelation(customer); // returns relation index

  // generate invite token *for the relation*
  const plain = customer.setRelationInvite(relIndex);
  // set invitedBy explicitly on relation (if not already)
  customer.relations[relIndex].invitedBy = req.user
    ? req.user._id
    : customer.relations[relIndex].invitedBy;
  await customer.save();

  const INVITE_BASE =
    process.env.CLIENT_INVITE_URL || "http://localhost:3000/accept-invite";
  const url = `${INVITE_BASE}?token=${plain}&cid=${customer._id}`;

  // send invite (prefer provided contact; fallback to user's contact)

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

  return res.status(201).json({
    success: true,
    message: "Invite created and sent",
    data: { customerId: customer._id, relationIndex: relIndex },
    invite:
      process.env.NODE_ENV === "development"
        ? { url, token: plain }
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
      new ErrorResponse("Invalid invite token for this customer", 400)
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
    if (email) user = await User.findOne({ email });
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
// controllers/customerController.js (replace acceptInviteEntity with this)
exports.acceptInviteEntity = asyncHandler(async (req, res, next) => {
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

  // persist client/branch into top-level metadata for quick access (optional)
  customer.metadata = customer.metadata || {};
  customer.metadata.client = clientId;
  if (branchId) customer.metadata.branch = branchId;

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
        ", "
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
    note: `Entity (${requestedType}) KYC provided & representative personal KYC present`,
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
  const body = req.body || {};

  // sensible defaults
  const DEFAULT_PASSWORD = "123456";
  const saltRounds = 10;

  // map possible incoming requestedType values to canonical ones
  // (fix typos like "indivisual")
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
          new ErrorResponse(`Client Not found, please check client name`, 404)
        );
      }
      if (body.branchName && !branchDoc) {
        return next(
          new ErrorResponse(`Branch Not found, please check client name`, 404)
        );
      }
      // NOTE: if neither found, we will still proceed — relation will be omitted.
      // If you want to force existence, uncomment the following:
      // if (body.clientName && !clientDoc) throw new Error('Client not found by name');
      // if (body.branchName && !branchDoc) throw new Error('Branch not found by name');

      // 2) Find or create user by email or userName
      const userPayload = {
        name:
          body.name ||
          `${
            body.personalKyc?.personal_form?.customer_details?.given_name || ""
          } ${
            body.personalKyc?.personal_form?.customer_details?.surname || ""
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
        $or: [{ email: userPayload.email }, { userName: userPayload.userName }],
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

      // 3) Build relation object (if we have client or branch info)

      // 4) Create Customer

      //If customer already existing here:

      let customerDoc;

      customerDoc = await Customer.findOne({ user: createdUser });
      let relations = [];
      if (customerDoc) {
        relations = customerDoc.relations;
        if (clientDoc || branchDoc) {
          const rel = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            type: requestedType === "individual" ? "individual" : requestedType,
            onboardingChannel: body.onboardingChannel || "API",
            registeredAt: body.registeredAt
              ? new Date(body.registeredAt)
              : new Date(),
            source: body.source || "api",
            notes: body.notes || "",
            active: true,
          };
          relations.push(rel);
          res.status(201).json({
            success: true,
            message: "Customer (and user/kyc where applicable) created",
            data: relations,
            // clientDoc,
          });
        }

        ///
      } else {
        const customerPayload = {
          user: createdUser ? createdUser._id : null,
          personalKyc: body.personalKyc || {},
          documents: body.documents || [],
          declaration: body.declaration || {},
          country: body.country || "Bangladesh",
          consentToScreen: body.consentToScreen || false,
          isActive: true,
          metadata: body.metadata || {},
          relations: relations,
        };

        customerDoc = new Customer(customerPayload);
      }

      // createdCustomer = await customerDoc.save({ session });

      // 5) If requestedType is not individual, create corresponding KYC record(s)
      if (requestedType !== "individual") {
        // choose which KYC model to create
        // company -> CompanyKyc, trust -> TrustKyc, else -> NonIndividualKyc
        if (requestedType === "company") {
          const compPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            general_information: body.general_information || {},
            documents: body.documents || [],
          };
          const created = await CompanyKyc.create([compPayload], { session });
          createdKyc.push({ type: "CompanyKyc", doc: created[0] });
        } else if (requestedType === "trust") {
          const trustPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            trust_details: body.trust_details || {},
            documents: body.documents || [],
          };
          const created = await TrustKyc.create([trustPayload], { session });
          createdKyc.push({ type: "TrustKyc", doc: created[0] });
        } else {
          // fallback: create NonIndividualKyc
          const nonIndPayload = {
            client: clientDoc ? clientDoc._id : undefined,
            branch: branchDoc ? branchDoc._id : undefined,
            customer: createdCustomer._id,
            general_information: body.general_information || {},
            documents: body.documents || [],
          };
          const created = await NonIndividualKyc.create([nonIndPayload], {
            session,
          });
          createdKyc.push({ type: "NonIndividualKyc", doc: created[0] });
        }
      }
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
        kyc: createdKyc.map((k) => ({ type: k.type, id: k.doc._id })),
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

// small helper to safely escape regex chars for name search
function escapeRegExp(string) {
  return String(string || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
