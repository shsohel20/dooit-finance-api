const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const mongoose = require("mongoose");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
const Customer = require("../models/Customer");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { hashForSearch } = require("../utils/encryption");

// ─── User helpers (mirrors clientController / customerController pattern) ────

/**
 * Returns a userName that does not exist in the Users collection.
 * Tries base → base_2 → base_3 … up to 10 attempts, then appends 4 random hex chars.
 */
async function uniqueUserName(base) {
  // Keep only alphanumeric, dots, underscores, hyphens
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 30) || "user";

  if (!(await User.exists({ userName: sanitized }))) return sanitized;

  for (let i = 2; i <= 10; i++) {
    const candidate = `${sanitized}_${i}`;
    if (!(await User.exists({ userName: candidate }))) return candidate;
  }

  // Fallback: append 4 random hex chars
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${sanitized}_${suffix}`;
}

/**
 * Find or create a user linked to a Client.
 * Matches clientController.createClient exactly:
 *   findOne({ email, userName }) → create({ userType: "client", role: "admin" })
 */
async function findOrCreateClientUser(clientData) {
  const email = clientData.email;
  const name = clientData.name;

  if (!email) return null;

  // Return existing user if already registered with this email
  let user = await User.findOne({ emailHash: hashForSearch(email) });
  if (user) return user;

  const userName = await uniqueUserName(
    clientData.userName || email.split("@")[0],
  );

  user = await User.create({
    name,
    email,
    userName,
    userType: "client",
    role: "admin",
    password: "123456",
    isActive: true,
  });
  return user;
}

/**
 * Find or create a user linked to a Branch.
 * Same pattern as client but userType "branch"; sets clientBelongs.
 */
async function findOrCreateBranchUser(branchData, clientId) {
  const email = branchData.email;
  const name = branchData.manager?.name || branchData.name;

  if (!email) return null;

  let user = await User.findOne({ emailHash: hashForSearch(email) });
  if (user) return user;

  const userName = await uniqueUserName(
    branchData.userName || email.split("@")[0],
  );

  user = await User.create({
    name,
    email,
    userName,
    userType: "branch",
    role: "user",
    password: "123456",
    isActive: true,
    clientBelongs: clientId,
  });
  return user;
}

/**
 * Find or create a user linked to a Customer.
 * Exhaustive lookup order (mirrors customerController invite flow + fallbacks):
 *   1. emailHash  — primary indexed lookup (works when email is encrypted)
 *   2. email      — plain field fallback (works for unencrypted / legacy records)
 *   3. phone      — phone-only users
 *   4. userName   — last resort by userName
 * If none found, creates a new user with userType "customer".
 */
async function findOrCreateCustomerUser(email, phone, displayName) {
  if (!email && !phone) return null;

  let user = null;

  // 1. emailHash — fastest, always indexed
  if (email) user = await User.findOne({ emailHash: hashForSearch(email) });

  // 2. plain email — catches unencrypted / pre-hash-migration records
  if (!user && email) user = await User.findOne({ email });

  // 3. phone
  if (!user && phone) user = await User.findOne({ phone });

  // 4. userName derived from email prefix
  if (!user && email) {
    const derivedUserName = email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "");
    if (derivedUserName)
      user = await User.findOne({ userName: derivedUserName });
  }

  if (user) return user;

  // Nothing found — create new customer user with a guaranteed-unique userName
  const baseUserName = email ? email.split("@")[0] : `customer_${Date.now()}`;

  const userName = await uniqueUserName(baseUserName);

  user = await User.create({
    name: displayName || userName,
    email: email || undefined,
    phone: phone || undefined,
    userName,
    userType: "customer",
    role: "customer",
    password: "123456",
    isActive: false,
  });

  return user;
}

// ─── Client / Branch find-or-create helpers ─────────────────────────────────

/**
 * Find an existing Client by any unique identifier, or create a new one.
 * Lookup order: email → registrationNumber → taxId → name
 */
async function findOrCreateClient(clientData, userId) {
  const { email, registrationNumber, taxId, name } = clientData;

  // Build OR query from whichever unique fields are provided
  const orConditions = [];
  if (email)              orConditions.push({ email });
  if (registrationNumber) orConditions.push({ registrationNumber });
  if (taxId)              orConditions.push({ taxId });
  if (name)               orConditions.push({ name });

  if (orConditions.length > 0) {
    const existing = await Client.findOne({ $or: orConditions });
    if (existing) return { client: existing, created: false };
  }

  const client = await Client.create({
    user:                userId || null,
    name,
    clientType:          clientData.clientType,
    email,
    phone:               clientData.phone,
    website:             clientData.website,
    registrationNumber,
    taxId,
    address:             clientData.address             || {},
    contacts:            clientData.contacts            || [],
    legalRepresentative: clientData.legalRepresentative || {},
    status:              clientData.status              || "Active",
    metadata:            clientData.metadata            || {},
  });

  return { client, created: true };
}

/**
 * Find an existing Branch by branchCode+client (compound unique) or name,
 * or create a new one.
 */
async function findOrCreateBranch(branchData, clientId, userId) {
  const { branchCode, name, email } = branchData;

  const orConditions = [];
  if (branchCode) orConditions.push({ client: clientId, branchCode });
  if (name)       orConditions.push({ name });
  if (email)      orConditions.push({ email });

  if (orConditions.length > 0) {
    const existing = await Branch.findOne({ $or: orConditions });
    if (existing) return { branch: existing, created: false };
  }

  const branch = await Branch.create({
    client:      clientId,
    user:        userId || null,
    name,
    branchCode,
    branchType:  branchData.branchType   || "Other",
    email,
    phone:       branchData.phone,
    swiftCode:   branchData.swiftCode,
    ifscCode:    branchData.ifscCode,
    address:     branchData.address      || {},
    contacts:    branchData.contacts     || [],
    manager:     branchData.manager      || {},
    services:    branchData.services     || [],
    workingHours: branchData.workingHours || {},
    status:      branchData.status       || "Active",
    metadata:    branchData.metadata     || {},
  });

  return { branch, created: true };
}

// ─── KYC builder ────────────────────────────────────────────────────────────

/**
 * Extract the primary contact email/phone/name for any customer type,
 * then build personalKyc and type-specific kycData for metadata.
 */
function buildCustomerKyc(customerData) {
  const type = customerData.customerType || "individual";
  let email,
    phone,
    displayName,
    given_name,
    surname,
    date_of_birth,
    occupation,
    industry,
    employer_name,
    identificationNo,
    residential_address,
    mailing_address;

  if (type === "individual") {
    given_name = customerData.given_name;
    surname = customerData.surname;
    email = customerData.email;
    phone = customerData.phone;
    date_of_birth = customerData.date_of_birth;
    occupation = customerData.occupation;
    industry = customerData.industry;
    employer_name = customerData.employer_name;
    identificationNo = customerData.identificationNo;
    residential_address = customerData.residential_address || {};
    mailing_address = customerData.mailing_address || {};
    displayName = `${given_name || ""} ${surname || ""}`.trim();
  } else {
    const cp = customerData.contact_person || customerData.trustee || {};
    given_name = cp.given_name || customerData.given_name || "";
    surname = cp.surname || customerData.surname || "";
    email = cp.email || customerData.email || "";
    phone = cp.phone || customerData.phone || "";
    occupation = cp.designation || cp.occupation;
    industry = customerData.industry;
    employer_name =
      customerData.company_name ||
      customerData.trust_name ||
      customerData.partnership_name ||
      customerData.association_name ||
      customerData.cooperative_name ||
      customerData.organization_name;

    const rawAddr = customerData.business_address || customerData.address || {};
    residential_address = {
      address: rawAddr.address || rawAddr.street || "",
      suburb: rawAddr.suburb || rawAddr.city || "",
      state: rawAddr.state || "",
      postcode: rawAddr.postcode || rawAddr.zipcode || "",
      country: rawAddr.country || "Bangladesh",
    };
    displayName = employer_name || `${given_name} ${surname}`.trim();
  }

  const personalKyc = {
    personal_form: {
      customer_details: {
        given_name,
        surname,
        date_of_birth: date_of_birth ? new Date(date_of_birth) : undefined,
        other_names: customerData.other_names,
        referral: customerData.referral,
      },
      contact_details: { email, phone },
      employment_details: { occupation, industry, employer_name },
      residential_address,
      mailing_address: mailing_address || residential_address,
      identificationNo,
    },
    funds_wealth: {
      source_of_funds: customerData.source_of_funds,
      source_of_wealth: customerData.source_of_wealth,
      account_purpose: customerData.account_purpose,
      estimated_trading_volume: customerData.estimated_trading_volume,
    },
  };

  // Type-specific data → stored in metadata.kycData
  const kycData = {};
  if (type === "company") {
    Object.assign(kycData, {
      company_name: customerData.company_name,
      company_registration: customerData.company_registration,
      company_tax_id: customerData.company_tax_id,
      company_type: customerData.company_type,
      date_of_incorporation: customerData.date_of_incorporation,
      country_of_incorporation: customerData.country_of_incorporation,
      directors: customerData.directors || [],
      shareholders: customerData.shareholders || [],
      ultimate_beneficial_owners: customerData.ultimate_beneficial_owners || [],
    });
  } else if (type === "trust") {
    Object.assign(kycData, {
      trust_name: customerData.trust_name,
      trust_deed_number: customerData.trust_deed_number,
      trust_type: customerData.trust_type,
      date_of_establishment: customerData.date_of_establishment,
      trustee: customerData.trustee || {},
      beneficiaries: customerData.beneficiaries || [],
      settlor: customerData.settlor || {},
    });
  } else if (type === "partnership") {
    Object.assign(kycData, {
      partnership_name: customerData.partnership_name,
      registration_number: customerData.registration_number,
      date_of_formation: customerData.date_of_formation,
      partners: customerData.partners || [],
    });
  } else if (type === "government_body") {
    Object.assign(kycData, {
      organization_name: customerData.organization_name,
      department: customerData.department,
      government_id: customerData.government_id,
      jurisdiction: customerData.jurisdiction,
    });
  } else if (type === "association") {
    Object.assign(kycData, {
      association_name: customerData.association_name,
      registration_number: customerData.registration_number,
      established_date: customerData.established_date,
      member_count: customerData.member_count,
      purpose: customerData.purpose,
    });
  } else if (type === "cooperative") {
    Object.assign(kycData, {
      cooperative_name: customerData.cooperative_name,
      registration_number: customerData.registration_number,
      established_date: customerData.established_date,
      member_count: customerData.member_count,
    });
  }

  return { personalKyc, kycData, email, phone, displayName };
}

/**
 * Find an existing Customer by any unique identifier, or create a new one.
 *
 * Lookup order:
 *   1. user._id          — linked user account (fastest, indexed)
 *   2. contact email     — personalKyc.personal_form.contact_details.email
 *   3. contact phone     — personalKyc.personal_form.contact_details.phone
 *   4. identificationNo  — NID / passport (individual only)
 *
 * If found and the client+branch relation does not yet exist on this customer,
 * the relation is appended and the document is saved (idempotent re-import).
 */
async function findOrCreateCustomer({
  userId,
  personalKyc,
  kycData,
  customerType,
  customerData,
  clientId,
  branchId,
}) {
  const email           = personalKyc?.personal_form?.contact_details?.email;
  const phone           = personalKyc?.personal_form?.contact_details?.phone;
  const identificationNo = personalKyc?.personal_form?.identificationNo;

  const orConditions = [];
  if (userId)            orConditions.push({ user: userId });
  if (email)             orConditions.push({ "personalKyc.personal_form.contact_details.email": email });
  if (phone)             orConditions.push({ "personalKyc.personal_form.contact_details.phone": phone });
  if (identificationNo)  orConditions.push({ "personalKyc.personal_form.identificationNo": identificationNo });

  let existing = null;
  if (orConditions.length > 0) {
    existing = await Customer.findOne({ $or: orConditions });
  }

  if (existing) {
    // Relation uniqueness check — only add if this client+branch combo is new
    const alreadyLinked = existing.relations.some(
      (r) =>
        r.client?.toString() === clientId.toString() &&
        r.branch?.toString() === branchId.toString(),
    );

    if (!alreadyLinked) {
      existing.relations.push({
        client:            clientId,
        branch:            branchId,
        type:              customerType,
        onboardingChannel: customerData.onboardingChannel || "In-Branch",
        source:            "dummy-import",
        active:            true,
      });
      await existing.save();
    }

    return { customer: existing, created: false, relationAdded: !alreadyLinked };
  }

  const customer = await Customer.create({
    user:     userId || null,
    relations: [
      {
        client:            clientId,
        branch:            branchId,
        type:              customerType,
        onboardingChannel: customerData.onboardingChannel || "In-Branch",
        source:            "dummy-import",
        active:            true,
      },
    ],
    personalKyc,
    country:   customerData.country   || "Bangladesh",
    kycStatus: customerData.kycStatus || "pending",
    isPep:     customerData.isPep     || false,
    sanction:  customerData.sanction  || false,
    metadata:  { ...(customerData.metadata || {}), kycData },
  });

  return { customer, created: true, relationAdded: true };
}

// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * POST /api/v1/dummy-import
 *
 * Bulk import: Client → Branch → Customer → Transactions in one request.
 * Users are auto-created from each entity's own fields — no separate "users" array.
 *
 * Client  → user created from client's name / email / userName
 * Branch  → user created from branch's email / userName (manager name used as display name)
 * Customer→ user found by emailHash/phone, or created with userType "customer"
 *
 * JSON body shape:
 * {
 *   "clients": [
 *     {
 *       "name":               "Alpha Bank Ltd",
 *       "clientType":         "Bank",
 *       "email":              "info@alphabank.com",   ← also becomes user email
 *       "userName":           "alpha.admin",           ← optional; defaults to email prefix
 *       "phone":              "...",
 *       "registrationNumber": "...",
 *       "taxId":              "...",
 *       "website":            "...",
 *       "address":            { street, city, state, country, zipcode },
 *       "legalRepresentative":{ name, email, phone, designation },
 *       "contacts":           [{ name, title, email, phone, primary }],
 *       "status":             "Active",
 *       "branches": [
 *         {
 *           "name":       "HQ Branch",
 *           "branchCode": "AB-HQ-001",
 *           "branchType": "Main|ATM|Corporate|Retail|Other",
 *           "email":      "hq@alphabank.com",   ← also becomes branch user email
 *           "userName":   "alpha.hq",            ← optional; defaults to email prefix
 *           "phone":      "...",
 *           "swiftCode":  "...",
 *           "ifscCode":   "...",
 *           "address":    { ... },
 *           "manager":    { name, email, phone, employeeId },
 *           "services":   [...],
 *           "status":     "Active",
 *           "customers": [
 *             {
 *               "customerType": "individual|company|partnership|trust|government_body|association|cooperative",
 *
 *               --- individual fields ---
 *               "given_name", "middle_name", "surname", "date_of_birth",
 *               "email", "phone", "occupation", "industry", "employer_name",
 *               "identificationNo", "residential_address", "mailing_address",
 *
 *               --- non-individual: primary contact ---
 *               "contact_person": { given_name, surname, email, phone, designation },
 *
 *               --- company extras ---
 *               "company_name", "company_registration", "company_tax_id",
 *               "company_type", "date_of_incorporation", "country_of_incorporation",
 *               "directors", "shareholders", "ultimate_beneficial_owners",
 *
 *               --- trust extras ---
 *               "trust_name", "trust_deed_number", "trust_type",
 *               "date_of_establishment", "trustee", "settlor", "beneficiaries",
 *
 *               --- partnership extras ---
 *               "partnership_name", "registration_number", "date_of_formation", "partners",
 *
 *               --- government_body extras ---
 *               "organization_name", "department", "government_id", "jurisdiction",
 *
 *               --- association extras ---
 *               "association_name", "registration_number", "established_date",
 *               "member_count", "purpose",
 *
 *               --- cooperative extras ---
 *               "cooperative_name", "registration_number", "established_date", "member_count",
 *
 *               --- shared ---
 *               "onboardingChannel", "kycStatus", "country",
 *               "source_of_funds", "source_of_wealth", "account_purpose",
 *               "isPep", "sanction",
 *
 *               "transactions": [
 *                 {
 *                   "type": "deposit|withdrawal|transfer|exchange|other",
 *                   "amount": 1000, "currency": "BDT",
 *                   "status": "completed",
 *                   "reference": "...", "narrative": "...", "channel": "...",
 *                   "timestamp": "ISO string",
 *                   "sender":      { name, account, institution, institutionCountry },
 *                   "beneficiary": { name, account, institution, institutionCountry }
 *                 }
 *               ]
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
const importDummyData = asyncHandler(async (req, res, next) => {
  const { clients } = req.body;

  if (!clients || !Array.isArray(clients) || clients.length === 0) {
    return next(
      new ErrorResponse(
        "Request body must contain a non-empty 'clients' array.",
        400,
      ),
    );
  }

  const summary = {
    clients: { created: 0, skipped: 0, errors: [] },
    branches: { created: 0, skipped: 0, errors: [] },
    customers: { created: 0, skipped: 0, relationAdded: 0, errors: [] },
    transactions: { created: 0, skipped: 0, errors: [] },
  };

  const createdClients = [];

  for (const clientData of clients) {
    // ── 1. Create client user (mirrors clientController.createClient) ─────────
    let clientUser = null;
    try {
      clientUser = await findOrCreateClientUser(clientData);
    } catch (err) {
      // non-fatal — client can exist without a user
    }

    // ── 2. Find or create Client ──────────────────────────────────────────────
    let client;
    try {
      const result = await findOrCreateClient(clientData, clientUser?._id);
      client = result.client;
      result.created ? summary.clients.created++ : summary.clients.skipped++;
    } catch (err) {
      summary.clients.errors.push({ name: clientData.name, error: err.message });
      continue;
    }

    const clientResult = {
      client: {
        id: client._id,
        name: client.name,
        uid: client.uid,
        userId: clientUser?._id,
      },
      branches: [],
    };

    for (const branchData of clientData.branches || []) {
      // ── 3. Create branch user ───────────────────────────────────────────────
      let branchUser = null;
      try {
        branchUser = await findOrCreateBranchUser(branchData, client._id);
      } catch (err) {
        // non-fatal
      }

      // ── 4. Find or create Branch ────────────────────────────────────────────
      let branch;
      try {
        const result = await findOrCreateBranch(branchData, client._id, branchUser?._id);
        branch = result.branch;
        result.created ? summary.branches.created++ : summary.branches.skipped++;
      } catch (err) {
        summary.branches.errors.push({ name: branchData.name, error: err.message });
        continue;
      }

      const branchResult = {
        branch: {
          id: branch._id,
          name: branch.name,
          uid: branch.uid,
          userId: branchUser?._id,
        },
        customers: [],
      };

      for (const customerData of branchData.customers || []) {
        const customerType = customerData.customerType || "individual";
        const { personalKyc, kycData, email, phone, displayName } =
          buildCustomerKyc(customerData);

        // ── 5. Find or create customer user (mirrors customerController invite) ──
        let customerUser = null;
        try {
          customerUser = await findOrCreateCustomerUser(
            email,
            phone,
            displayName,
          );
        } catch (err) {
          // non-fatal
        }

        // ── 6. Find or create Customer (unique by user/email/phone/identificationNo) ─
        let customer;
        try {
          const result = await findOrCreateCustomer({
            userId:       customerUser?._id,
            personalKyc,
            kycData,
            customerType,
            customerData,
            clientId:     client._id,
            branchId:     branch._id,
          });
          customer = result.customer;
          result.created ? summary.customers.created++ : summary.customers.skipped++;
        } catch (err) {
          summary.customers.errors.push({ name: displayName, type: customerType, error: err.message });
          continue;
        }

        const customerResult = {
          customer: {
            id: customer._id,
            uid: customer.uid,
            name: displayName,
            type: customerType,
            userId: customerUser?._id,
          },
          transactions: [],
        };

        // ── 7. Create Transactions ──────────────────────────────────────────────
        for (const txData of customerData.transactions || []) {
          try {
            const tx = await Transaction.create({
              customer: customer._id,
              client: client._id,
              branch: branch._id,
              type: txData.type || "other",
              subtype: txData.subtype,
              amount: txData.amount,
              currency: txData.currency || "BDT",
              convertedAmountAUD: txData.convertedAmountAUD,
              reference: txData.reference,
              narrative: txData.narrative,
              status: txData.status || "completed",
              channel: txData.channel,
              timestamp: txData.timestamp
                ? new Date(txData.timestamp)
                : new Date(),
              sender: txData.sender || {},
              beneficiary: txData.beneficiary || {},
              intermediary: txData.intermediary || {},
              receiver: txData.receiver || {},
              purpose: txData.purpose,
              riskScore: txData.riskScore || 0,
              riskFlags: txData.riskFlags || [],
              metadata: txData.metadata || {},
            });
            summary.transactions.created++;
            customerResult.transactions.push({
              id: tx._id,
              uid: tx.uid,
              amount: tx.amount,
              currency: tx.currency,
            });
          } catch (err) {
            summary.transactions.errors.push({
              reference: txData.reference,
              error: err.message,
            });
          }
        }

        branchResult.customers.push(customerResult);
      }

      clientResult.branches.push(branchResult);
    }

    createdClients.push(clientResult);
  }

  res.status(201).json({
    success: true,
    message: "Dummy data import complete.",
    summary,
    data: createdClients,
  });
});

module.exports = { importDummyData };
