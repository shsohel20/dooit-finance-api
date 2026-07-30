/**
 * Seeds a complete investigation chain against EXISTING customers:
 *
 *   Customer → Transaction → Alert → Case → { ECDD, SMR, TTR, IFTI, GFS, RFI }
 *
 * Nothing is invented about the customer — the script reads real Customer
 * documents and derives client/branch from the tenant relation on each, so the
 * seeded data lands inside the same tenant the customer already belongs to.
 *
 * Coverage: every schema path on all nine models is populated, so no UI section
 * renders blank for want of data. The only paths left at their defaults are the
 * soft-delete pair (isDeleted / deletedAt is set explicitly to the "live" value)
 * and refs to documents this script does not create (Alert.ruleRef →
 * RuleEngine, EcddReport.riskAssessment → IndividualRiskAssessment).
 *
 * Field-name split is deliberate and matches the models:
 *   • ECDD + SMR             → `caseId`
 *   • TTR + IFTI + GFS + RFI → `case`
 * Every report also carries `alert` (provenance) and `customer`.
 *
 * Usage:
 *   node seeds/seedCaseWorkflow.js                 20 rows for DEFAULT_CLIENT
 *   node seeds/seedCaseWorkflow.js --rows=50       more rows (customers cycle)
 *   node seeds/seedCaseWorkflow.js --client=<id>   target a different client
 *   node seeds/seedCaseWorkflow.js --fresh         delete previous seed data first
 *   node seeds/seedCaseWorkflow.js --clean         delete previous seed data and exit
 *
 * Everything created carries "SEED" inside its uid, which is how --fresh/--clean
 * find it. No non-seeded document is ever touched, except Alert.linkedCase /
 * Alert.status on alerts this script created.
 */

require("dotenv").config({ path: "./config/config.env" });

const mongoose = require("mongoose");

const Customer = require("../models/Customer");
const Client = require("../models/Client");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Alert = require("../models/Alert");
const Case = require("../models/Case");
const EcddReport = require("../models/EcddReport");
const SMR = require("../models/SmrReport");
const TTR = require("../models/TtrReport");
const IFTI = require("../models/IftiReport");
const GFS = require("../models/gfsReport");
const RFI = require("../models/Rfi");
const RuleEngine = require("../models/RuleEngine");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FRESH = argv.includes("--fresh");
const CLEAN_ONLY = argv.includes("--clean");

// How many chains to create. Independent of how many customers exist — the
// customer pool is cycled, so a client with 11 customers can still back 20
// rows. `--customers=` is kept as an alias for the original flag.
const ROWS = Number(
  (argv.find((a) => a.startsWith("--rows=")) || "").split("=")[1] ||
    (argv.find((a) => a.startsWith("--customers=")) || "").split("=")[1] ||
    20
);

// Tenant everything is seeded under. Only customers holding a relation with
// this client are selected, and that same relation supplies the branch — a
// customer may be onboarded under several clients, so the matching relation
// matters rather than simply the first one.
const DEFAULT_CLIENT = "6a39e8adb23e16e4366afd2e";
const CLIENT_ID =
  (argv.find((a) => a.startsWith("--client=")) || "").split("=")[1] ||
  DEFAULT_CLIENT;

// ── uid helper ───────────────────────────────────────────────────────────────
// Every model generates its uid with `Date.now()`, and several have a unique
// index on it — creating a batch in the same millisecond would collide. Set the
// uid explicitly (the pre-save hooks only fill it when absent) and keep "SEED"
// in it so cleanup can find it. The AL-/CA- prefixes are preserved because
// resolveCaseLinkage keys off them.
const STAMP = Date.now();
let counter = 0;
const uid = (prefix, sep = "_") => `${prefix}${sep}SEED${sep}${STAMP}${sep}${++counter}`;

const SEED_RX = /SEED/;

const MODELS = [
  ["Transaction", Transaction],
  ["Alert", Alert],
  ["Case", Case],
  ["EcddReport", EcddReport],
  ["SMR", SMR],
  ["TTR", TTR],
  ["IFTI", IFTI],
  ["GFS", GFS],
  ["RFI", RFI],
];

async function cleanSeedData() {
  console.log("\n  Removing previous seed data…");
  for (const [name, Model] of MODELS) {
    const { deletedCount } = await Model.deleteMany({ uid: SEED_RX });
    if (deletedCount) console.log(`    − ${name.padEnd(12)} ${deletedCount} removed`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const displayName = (customer) => {
  const kyc = customer.personalKyc?.personal_form?.customer_details || {};
  const fromKyc = [kyc.given_name, kyc.surname].filter(Boolean).join(" ");
  return customer.user?.name || fromKyc || `Customer ${customer.uid || customer._id}`;
};

const days = (n) => n * 24 * 60 * 60 * 1000;
const iso = (d) => new Date(d);

const address = () => ({
  fullStreetAddress: "Level 12, 120 Collins Street",
  city: "Melbourne",
  state: "VIC",
  postcode: "3000",
  country: "Australia",
});

/**
 * Rotated across the generated rows so the seeded set actually exercises the
 * list filters (status, type, currency, channel, amount and risk ranges)
 * instead of producing N identical records. The final variant is a closed case
 * so the closure/decision fields are covered with realistic values.
 */
const VARIANTS = [
  {
    txnType: "transfer", txnStatus: "completed", currency: "AUD",
    channel: "online-banking", subtype: "wire", amount: 125000,
    riskScore: 78, riskFlags: ["structuring", "high-value"],
    narrative: "Structured cash deposits below reporting threshold.",
    alertRisk: 78, alertLabel: "High", priority: "high",
    caseStatus: "under_investigation", caseType: "AML", slaStatus: "on_time",
    ruleId: "RULE-STR-114", ruleName: "Multiple sub-threshold cash deposits within 24h",
    offence: "Money laundering", suspicionType: "Structuring",
  },
  {
    txnType: "deposit", txnStatus: "completed", currency: "AUD",
    channel: "branch-counter", subtype: "cash", amount: 48000,
    riskScore: 55, riskFlags: ["cash-intensive"],
    narrative: "Large cash deposit inconsistent with stated occupation.",
    alertRisk: 55, alertLabel: "Medium", priority: "medium",
    caseStatus: "open", caseType: "AML", slaStatus: "on_time",
    ruleId: "RULE-CSH-021", ruleName: "Cash deposit inconsistent with customer profile",
    offence: "Proceeds of crime", suspicionType: "Unusual cash activity",
  },
  {
    txnType: "transfer", txnStatus: "pending", currency: "USD",
    channel: "swift", subtype: "wire", amount: 265000,
    riskScore: 91, riskFlags: ["high-risk-jurisdiction", "rapid-movement"],
    narrative: "Outbound wire to a high-risk jurisdiction shortly after deposit.",
    alertRisk: 91, alertLabel: "Critical", priority: "high",
    caseStatus: "escalated", caseType: "TF", slaStatus: "at_risk",
    ruleId: "RULE-JUR-007", ruleName: "Funds transfer to high-risk jurisdiction",
    offence: "Terrorism financing", suspicionType: "High-risk jurisdiction exposure",
  },
  {
    txnType: "withdrawal", txnStatus: "completed", currency: "AUD",
    channel: "atm", subtype: "cash", amount: 9500,
    riskScore: 42, riskFlags: ["threshold-avoidance"],
    narrative: "Repeated ATM withdrawals just under the reporting threshold.",
    alertRisk: 42, alertLabel: "Medium", priority: "low",
    caseStatus: "pending_review", caseType: "Fraud", slaStatus: "on_time",
    ruleId: "RULE-STR-002", ruleName: "Repeated sub-threshold ATM withdrawals",
    offence: "Fraud", suspicionType: "Threshold avoidance",
  },
  {
    txnType: "exchange", txnStatus: "failed", currency: "EUR",
    channel: "online-banking", subtype: "fx", amount: 74000,
    riskScore: 66, riskFlags: ["rapid-movement"],
    narrative: "Currency exchange followed by immediate onward transfer.",
    alertRisk: 66, alertLabel: "High", priority: "medium",
    caseStatus: "under_investigation", caseType: "AML", slaStatus: "breached",
    ruleId: "RULE-LAY-033", ruleName: "Layering via rapid currency conversion",
    offence: "Money laundering", suspicionType: "Layering",
  },
  {
    txnType: "transfer", txnStatus: "cancelled", currency: "AUD",
    channel: "mobile-app", subtype: "p2p", amount: 18500,
    riskScore: 31, riskFlags: [],
    narrative: "Peer transfers reviewed and found consistent with the profile.",
    alertRisk: 31, alertLabel: "Low", priority: "low",
    caseStatus: "closed", caseType: "Compliance", slaStatus: "on_time",
    ruleId: "RULE-P2P-054", ruleName: "Elevated peer-to-peer transfer velocity",
    offence: "None identified", suspicionType: "Transfer velocity",
    // Closure fields — only meaningful for a closed case.
    decision: "false_positive",
    closureReason: "Activity substantiated by payroll and rental records.",
  },
];

/** TTR has the strictest schema of the six — build its required parts in full. */
const buildTtrParts = (name, amount, reference, when) => ({
  partA: [
    {
      customers: {
        fullName: name,
        otherNames: ["M. Hossain"],
        dateOfBirth: iso(Date.now() - days(365 * 34)),
        businessAddress: address(),
        phoneNumbers: ["+61 400 000 000"],
        emailAddresses: ["seed.customer@example.com"],
        occupation: "Company Director",
        businessStructure: "individual",
        abn: "51 824 753 556",
        acn: "004 085 616",
        arbn: "123 456 789",
        accounts: [
          { type: "transaction", number: "AU-7842-0012-3345", currencyCode: "AUD", institution: "Commonwealth Bank of Australia" },
        ],
        digitalCurrencyWallets: [
          { type: "BTC", identifier: "bc1qseeddemowallet00000000000000000000", provider: "Self-custody" },
        ],
        identityVerification: {
          documentation: ["Passport", "Driver Licence"],
          electronicDataSource: ["Credit bureau"],
          deviceIdentifiers: ["dev-chrome-win11-8f3c"],
        },
      },
      transactionConductMethod: "individual",
      transactionConductDescription: "Conducted in person at the branch counter.",
    },
  ],
  partB: {
    type: "customer",
    customerIndex: 0,
    details: {
      fullName: name,
      dateOfBirth: iso(Date.now() - days(365 * 34)),
      occupation: "Company Director",
      relationshipToCustomer: "self",
    },
  },
  partC: {
    transaction: {
      date: when,
      referenceNumber: reference,
      totalAmount: { currencyCode: "AUD", amount },
      designatedService: "cash-deposit",
      moneyReceived: {
        australianDollars: { currencyCode: "AUD", amount },
        foreignCurrency: [
          { currencyCode: "USD", amount: 5000, exchangeRate: 1.52, audEquivalent: 7600 },
        ],
        digitalCurrency: [
          { type: "BTC", amount: 0.25, walletAddress: "bc1qseeddemowallet00000000000000000000", audEquivalent: 24000 },
        ],
        otherComponents: ["Bank cheque"],
      },
      moneyProvided: {
        australianDollars: { currencyCode: "AUD", amount: Math.round(amount / 2) },
        foreignCurrency: [],
        digitalCurrency: [],
        otherComponents: [],
      },
    },
    recipients: [
      {
        isCustomer: true,
        fullName: name,
        occupation: "Company Director",
        phoneNumbers: ["+61 400 000 000"],
        emailAddresses: ["seed.customer@example.com"],
        accounts: [
          { type: "transaction", number: "AU-7842-0012-3345", currencyCode: "AUD", institution: "Commonwealth Bank of Australia" },
        ],
        customerReference: reference,
      },
    ],
  },
  partD: {
    identificationNumber: "RE-100200300",
    name: "Dooit Financial Services Pty Ltd",
    branch: {
      identificationNumber: "BR-001",
      name: "Melbourne CBD",
      address: address(),
    },
    personCompleting: {
      name: "Compliance Officer",
      jobTitle: "AML/CTF Compliance Officer",
      phone: "+61 3 9000 0000",
      email: "compliance@example.com",
    },
  },
  metadata: {
    version: "1.0",
    createdBy: "seedCaseWorkflow",
    updatedBy: "seedCaseWorkflow",
    submissionDate: when,
    austracReference: `AUSTRAC-${STAMP}`,
    fileAttachments: ["ttr-supporting-evidence.pdf"],
  },
});

// ── Main ─────────────────────────────────────────────────────────────────────

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("  Connected to MongoDB");

  if (FRESH || CLEAN_ONLY) await cleanSeedData();
  if (CLEAN_ONLY) {
    await mongoose.disconnect();
    console.log("\n  Clean complete.\n");
    return;
  }

  if (!mongoose.Types.ObjectId.isValid(CLIENT_ID)) {
    throw new Error(`--client is not a valid ObjectId: ${CLIENT_ID}`);
  }
  const clientId = new mongoose.Types.ObjectId(CLIENT_ID);

  const clientDoc = await Client.findById(clientId).select("name user").lean();
  if (!clientDoc) {
    throw new Error(`Client not found: ${CLIENT_ID}`);
  }
  console.log(`  Client: ${clientDoc.name || "(unnamed)"}  ${CLIENT_ID}`);

  // Only customers onboarded under this client. The whole pool is loaded and
  // then cycled, so ROWS is not capped by the number of customers.
  const customers = await Customer.find({ "relations.client": clientId })
    .populate("user", "name email")
    .lean();

  if (!customers.length) {
    throw new Error(
      `No customers found with a relation to client ${CLIENT_ID}.`
    );
  }
  console.log(`  Customers available: ${customers.length}`);

  // Case.createdBy is required. Prefer the client's own user so the audit
  // trail stays inside the tenant; fall back to any user.
  const author =
    (clientDoc.user &&
      (await User.findById(clientDoc.user).select("_id").lean())) ||
    (await User.findOne().select("_id").lean());
  if (!author) throw new Error("No users found — cannot set Case.createdBy.");

  // A second user for reviewer / four-eyes fields, when one exists.
  const reviewer =
    (await User.findOne({ _id: { $ne: author._id } }).select("_id").lean()) ||
    author;

  // The last two refs point at documents this script does not create. Bind them
  // to real records when they exist — a fabricated ObjectId would be a dangling
  // ref that breaks .populate() downstream.
  const rule = await RuleEngine.findOne().select("_id version").lean();
  const assessment = await IndividualRiskAssessment.findOne().select("_id").lean();
  console.log(
    `  Refs: ruleRef ${rule ? "bound" : "none available"} · riskAssessment ${
      assessment ? "bound" : "none available"
    }`
  );

  console.log(`  Seeding ${ROWS} chain(s)\n`);
  const totals = {};
  const bump = (k) => (totals[k] = (totals[k] || 0) + 1);

  for (let i = 0; i < ROWS; i++) {
    // Cycle the pool so ROWS can exceed the number of customers.
    const customer = customers[i % customers.length];
    const v = VARIANTS[i % VARIANTS.length];

    // Use the relation for THIS client — a customer may hold several.
    const relation =
      customer.relations.find((r) => String(r.client) === CLIENT_ID) || {};
    const client = clientId;
    const branch = relation.branch || null;
    const name = displayName(customer);
    const tenant = { client, branch, customer: customer._id };
    const isClosed = v.caseStatus === "closed";

    // 1 ── Transaction ────────────────────────────────────────────────────────
    const amount = v.amount + Math.floor(Math.random() * 25000);
    // Spread over the last ~3 weeks so date-range filters have something to bite.
    const when = new Date(Date.now() - i * 26 * 60 * 60 * 1000);
    const reference = `SEED-${STAMP}-${i + 1}`;

    const txn = await Transaction.create({
      ...tenant,
      uid: uid("TXN"),
      timestamp: when,
      type: v.txnType,
      subtype: v.subtype,
      amount,
      currency: v.currency,
      convertedAmountAUD: v.currency === "AUD" ? amount : Math.round(amount * 1.52),
      reference,
      narrative: v.narrative,
      status: v.txnStatus,
      channel: v.channel,
      sender: {
        customer: customer._id,
        name,
        account: "AU-7842-0012-3345",
        institution: "Commonwealth Bank of Australia",
        institutionCountry: "Australia",
        bic: "CTBAAU2S",
        address: "Level 12, 120 Collins Street, Melbourne VIC 3000",
        extra: { customerRef: customer.uid || null },
      },
      receiver: {
        name: "Meridian Trade Solutions GmbH",
        account: "DE89370400440532013000",
        institution: "Deutsche Bank AG",
        institutionCountry: "DE",
        bic: "DEUTDEDB",
        address: "Taunusanlage 12, 60325 Frankfurt am Main",
        extra: { vendorRef: "MTS-2026-118" },
      },
      beneficiary: {
        name: "Sigma Logistics BV",
        account: "NL91ABNA0417164300",
        institution: "ABN AMRO Bank",
        institutionCountry: "NL",
        bic: "ABNANL2A",
        address: "Gustav Mahlerlaan 10, 1082 PP Amsterdam",
        extra: {},
      },
      intermediary: {
        name: "JP Morgan Chase Bank NA",
        account: "CHASUS33",
        institution: "JP Morgan Chase",
        institutionCountry: "US",
        bic: "CHASUS33",
        address: "383 Madison Ave, New York, NY 10179",
        extra: {},
      },
      purpose: "supplier_payment",
      remittancePurposeCode: "GDS",
      crypto: {
        walletAddress: "bc1qseeddemowallet00000000000000000000",
        txHash: `0xseed${STAMP}${i}`,
        network: "Bitcoin",
        hops: 2,
        cluster: "exchange-hosted",
      },
      bullion: { type: "gold", purity: "99.99", weight: 250 },
      riskScore: v.riskScore,
      riskFlags: v.riskFlags,
      forensic: {
        walletCluster: "cluster-7741",
        chainalysisScore: v.riskScore,
        notes: "Counterparty cluster previously associated with mixer activity.",
      },
      travelRule: {
        originatorVaspId: "VASP-AU-0012",
        originatorVaspName: "Dooit Financial Services Pty Ltd",
        originatorVaspLicense: "AUSTRAC-DCE-100200",
        beneficiaryVaspId: "VASP-DE-0447",
        beneficiaryVaspName: "Meridian Digital GmbH",
        travelMessageId: `TR-${STAMP}-${i + 1}`,
        protocol: "IVMS101",
      },
      relatedPartyTxnId: reference,
      relatedPartyFlag: i % 3 === 0,
      createdBy: author._id,
      metadata: { ip: "203.0.113.45", deviceId: "dev-chrome-win11-8f3c", source: "seedCaseWorkflow" },
    });
    bump("transactions");

    // 2 ── Alert ──────────────────────────────────────────────────────────────
    // uid keeps the AL- prefix so resolveCaseLinkage still identifies it.
    const alert = await Alert.create({
      ...tenant,
      uid: uid("AL", "-"),
      transaction: txn._id,
      analyst: author._id,
      caseType: v.caseType,
      alertOrigin: i % 4 === 3 ? "AI Based" : "Rule Based",
      ruleRef: rule?._id || null,
      ruleId: v.ruleId,
      ruleName: v.ruleName,
      ruleVersion: rule?.version || 3,
      ruleMeta: {
        threshold: 10000,
        lookbackHours: 24,
        matched: v.riskFlags,
        logic: "count(cash_deposits) >= 3 AND each(amount) < threshold",
      },
      explanation: v.narrative,
      riskScore: v.alertRisk,
      riskLabel: v.alertLabel,
      priority: v.priority,
      status: "new",
      statusReason: "Auto-generated by the transaction monitoring engine.",
      closedAt: null,
      slaDeadline: new Date(when.getTime() + days(3)),
      slaStatus: v.slaStatus,
      deduplicationKey: `${v.ruleId}:${customer._id}:${when.toISOString().slice(0, 10)}`,
      activity: [
        {
          type: "activity",
          title: "Alert generated",
          message: `${v.ruleName} triggered on ${reference}.`,
          createdBy: author._id,
          createdAt: when,
        },
        {
          type: "note",
          title: "Initial triage",
          message: "Assigned for review; transaction pattern warrants a closer look.",
          createdBy: author._id,
          createdAt: new Date(when.getTime() + 3600 * 1000),
        },
      ],
      auditLogs: [
        {
          action: "ALERT_CREATED",
          performedBy: author._id,
          timestamp: when,
          oldValue: null,
          newValue: { status: "new" },
          remark: "Created by rule engine.",
        },
      ],
      createdBy: author._id,
      metadata: { source: "seedCaseWorkflow", engine: "rule-engine" },
      isDeleted: false,
      deletedAt: null,
    });
    bump("alerts");

    // 3 ── Case ───────────────────────────────────────────────────────────────
    const caseDoc = await Case.create({
      client,
      branch,
      uid: uid("CA", "-"),
      title: `${v.ruleName} — ${name}`,
      description: v.narrative,
      type: "transaction_monitoring",
      caseType: v.caseType,
      riskScore: v.alertRisk,
      riskLabel: v.alertLabel,
      priority: v.priority,
      status: v.caseStatus,
      closureReason: isClosed ? v.closureReason : null,
      closedAt: isClosed ? new Date(when.getTime() + days(4)) : null,
      linkedCustomers: [customer._id],
      linkedAlerts: [alert._id],
      linkedTransactions: [txn._id],
      assignedTo: author._id,
      reviewer: reviewer._id,
      watchers: [reviewer._id],
      createdBy: author._id,
      decision: isClosed ? v.decision : null,
      decisionNotes: isClosed
        ? "Reviewed against payroll and rental records; no further action."
        : null,
      decidedAt: isClosed ? new Date(when.getTime() + days(4)) : null,
      decidedBy: isClosed ? reviewer._id : null,
      slaDeadline: new Date(when.getTime() + days(5)),
      slaStatus: v.slaStatus,
      tags: ["seed", v.caseType.toLowerCase(), v.suspicionType.toLowerCase().replace(/\s+/g, "-")],
      metadata: { source: "seedCaseWorkflow", variant: i % VARIANTS.length },
      isDeleted: false,
      deletedAt: null,
    });
    bump("cases");

    // Close the loop: the alert now belongs to the case. This is what
    // resolveCaseLinkage reads when a report is raised from the alert.
    await Alert.updateOne(
      { _id: alert._id },
      { $set: { linkedCase: caseDoc._id, status: "escalated_to_case" } }
    );

    // Transaction.investigation can only be filled once the case exists.
    await Transaction.updateOne(
      { _id: txn._id },
      {
        $set: {
          "investigation.case": caseDoc._id,
          "investigation.caseId": caseDoc.uid,
          "investigation.flagged": true,
          "investigation.investigatorNotes":
            "Linked to the open investigation; awaiting source-of-funds evidence.",
        },
      }
    );

    const link = { ...tenant, alert: alert._id };

    // 4 ── Reports ────────────────────────────────────────────────────────────
    // ECDD and SMR key the hub as `caseId`…
    await EcddReport.create({
      ...link,
      uid: uid("ECDD"),
      caseId: caseDoc._id,
      caseNumber: alert.uid,
      transaction: txn._id,
      analyst: author._id,
      generatedBy: author._id,
      riskAssessment: assessment?._id || null,
      analystName: "Compliance Analyst",
      position: "Compliance Officer",
      date: when,
      userId: String(customer.user?._id || customer._id),
      fullName: name,
      customerName: name,
      abn: "51 824 753 556",
      onboardingDate: relation.registeredAt || when,
      accountPurpose: "Personal investment and remittance",
      expectedVolume: 50000,
      annualIncome: 180000,
      beneficialOwner: name,
      directors: name,
      isPEP: "No",
      isSanctioned: "No",
      relatedParty: "N/A",
      accountCreationDate: relation.registeredAt || when,
      analysisEndDate: when,
      totalDepositsAUD: amount,
      totalWithdrawalsUSDT: 12000,
      totalWithdrawalsETH: 4.25,
      totalWithdrawalsBTC: 0.75,
      depositDetails: "Six cash deposits between AUD 8,400 and AUD 9,800 over eleven days.",
      withdrawalDetails: "Two outbound wires to the same overseas beneficiary.",
      additionalInfo: "Customer contacted for source-of-funds evidence; response pending.",
      ipLocations: 3,
      registeredAddress: "Level 12, 120 Collins Street, Melbourne VIC 3000",
      profileSummary: `${name} holds a personal account with elevated cash activity.`,
      transactionAnalysis: v.narrative,
      behavioralAnalysis:
        "Deposit cadence changed materially in the last 30 days versus the prior 12 months.",
      recommendation: "Apply enhanced ongoing monitoring for 6 months.",
      status: "Pending",
      settings: { reviewCycleMonths: 6, autoEscalate: true },
      metadata: { source: "seedCaseWorkflow", caseUid: caseDoc.uid },
    });
    bump("ecdd");

    await SMR.create({
      ...link,
      uid: uid("SMR"),
      caseId: caseDoc._id,
      caseNumber: alert.uid,
      status: "draft",
      partA: {
        serviceStatus: "provided",
        designatedServices: ["Item 1 - account and deposit taking", "Item 32 - currency exchange"],
        suspicionReasons: ["structuring", "unusual-pattern"],
        otherReasons: ["Customer reluctant to explain the source of funds."],
      },
      partB: {
        groundsForSuspicion:
          "Deposit pattern is consistent with deliberate threshold avoidance.",
      },
      partC: {
        personOrganisation: {
          name,
          otherNames: ["M. Hossain"],
          personDetails: { dateOfBirth: iso(Date.now() - days(365 * 34)), nationality: "Australian" },
          businessAddress: address(),
          phoneNumbers: ["+61 400 000 000"],
          emails: ["seed.customer@example.com"],
          accounts: [{ type: "transaction", number: "AU-7842-0012-3345", institution: "Commonwealth Bank of Australia" }],
          digitalWallets: [{ type: "BTC", identifier: "bc1qseeddemowallet00000000000000000000" }],
          occupation: "Company Director",
          beneficialOwners: [{ name }],
          officeHolders: [{ name }],
          documentation: "Passport, Driver Licence",
          identityVerification: { documentation: ["Passport"], electronicDataSource: ["Credit bureau"] },
          isCustomer: true,
          isAuthorisedAgent: false,
        },
      },
      partD: { hasOtherParties: true, otherParties: [{ name: "Meridian Trade Solutions GmbH" }] },
      partE: { hasUnidentifiedPersons: false, unidentifiedPersons: [] },
      partF: { transactions: [{ reference, amount, currency: v.currency, date: when }] },
      partG: {
        likelyOffence: [v.offence],
        previousReports: [{ date: new Date(when.getTime() - days(180)), referenceNumber: `SMR-PRIOR-${i + 1}` }],
        otherGovernmentBodies: ["AUSTRAC", "Australian Federal Police"],
        attachments: ["smr-transaction-schedule.pdf"],
      },
      partH: {
        reportingEntity: {
          name: "Dooit Financial Services Pty Ltd",
          address: address(),
          branchName: "Melbourne CBD",
          internalReference: caseDoc.uid,
          completedBy: {
            name: "Compliance Officer",
            jobTitle: "AML/CTF Compliance Officer",
            phone: "+61 3 9000 0000",
            email: "compliance@example.com",
          },
        },
      },
      metadata: {
        version: "1.0",
        createdBy: String(author._id),
        updatedBy: String(author._id),
        submissionDate: when,
        austracReference: `AUSTRAC-SMR-${STAMP}-${i + 1}`,
        workflowHistory: [
          {
            timestamp: when,
            user: String(author._id),
            action: "created",
            fromStatus: "",
            toStatus: "draft",
            notes: "Drafted from the linked alert.",
          },
        ],
      },
    });
    bump("smr");

    // …TTR, IFTI, GFS and RFI key it as `case`.
    await TTR.create({
      ...link,
      uid: uid("TTR"),
      case: caseDoc._id,
      referenceNumber: alert.uid,
      status: "draft",
      completionDate: when,
      ...buildTtrParts(name, amount, reference, when),
    });
    bump("ttr");

    const party = (isOrdering) => ({
      fullName: isOrdering ? name : "Meridian Trade Solutions GmbH",
      otherName: isOrdering ? "M. Hossain" : "Meridian GmbH",
      dateOfBirth: isOrdering ? iso(Date.now() - days(365 * 34)) : null,
      address: isOrdering ? "Level 12, 120 Collins Street" : "Taunusanlage 12",
      city: isOrdering ? "Melbourne" : "Frankfurt",
      state: isOrdering ? "VIC" : "Hesse",
      postcode: isOrdering ? "3000" : "60325",
      country: isOrdering ? "Australia" : "Germany",
      phone: isOrdering ? "+61 400 000 000" : "+49 69 910 00",
      email: isOrdering ? "seed.customer@example.com" : "ops@meridian.example",
      occupation: isOrdering ? "Company Director" : "Trading company",
      abnAcnArbn: isOrdering ? "51 824 753 556" : "DE114103379",
      customerNumber: isOrdering ? customer.uid || "" : "MTS-2026-118",
      accountNumber: isOrdering ? "AU-7842-0012-3345" : "DE89370400440532013000",
      businessStructure: isOrdering ? "individual" : "company",
      businessName: isOrdering ? "" : "Meridian Trade Solutions GmbH",
      institutionName: isOrdering ? "Commonwealth Bank of Australia" : "Deutsche Bank AG",
      institutionCity: isOrdering ? "Melbourne" : "Frankfurt",
      institutionCountry: isOrdering ? "Australia" : "Germany",
    });

    await IFTI.create({
      ...link,
      uid: uid("IFTI"),
      case: caseDoc._id,
      status: "draft",
      transaction: {
        dateReceived: when,
        dateAvailable: new Date(when.getTime() + days(1)),
        currencyCode: v.currency,
        totalAmount: amount,
        transferType: "electronic",
        propertyDescription: "Electronic funds transfer instruction",
        referenceNumber: reference,
      },
      orderingCustomer: party(true),
      beneficiaryCustomer: party(false),
      intermediaries: [
        {
          key: "intermediary-1",
          present: true,
          fullName: "JP Morgan Chase Bank NA",
          address: "383 Madison Ave",
          city: "New York",
          state: "NY",
          postcode: "10179",
          country: "United States",
        },
      ],
      reportCompletion: {
        transferReason: "Supplier payment for imported goods.",
        completedBy: {
          name: "Compliance Officer",
          jobTitle: "AML/CTF Compliance Officer",
          phone: "+61 3 9000 0000",
          email: "compliance@example.com",
        },
      },
      attachments: ["ifti-instruction.pdf"],
      generatedReport: `IFTI generated for ${reference}.`,
      metadata: { version: "1.0", createdBy: String(author._id), caseUid: caseDoc.uid },
    });
    bump("ifti");

    await GFS.create({
      ...link,
      uid: uid("GFS"),
      case: caseDoc._id,
      status: "draft",
      suspicionType: v.suspicionType,
      suspicionReason: v.narrative,
      suspicionDates: `${new Date(when.getTime() - days(11)).toISOString().slice(0, 10)} to ${when.toISOString().slice(0, 10)}`,
      suspicionIntensity: v.alertLabel,
      suspicionBehaviour: "Repeated sub-threshold deposits followed by an outbound wire.",
      customerName: name,
      customerUID: customer.uid,
      companyName: "Apex Capital Holdings Pty Ltd",
      customerAge: 34,
      accountOpeningDate: relation.registeredAt || when,
      sourceOfFunds: "Investment income and property rental",
      accountOpeningPurpose: "Personal investment and remittance",
      reviewStartDate: new Date(when.getTime() - days(30)),
      reviewEndDate: when,
      totalDeposited: amount,
      totalWithdrawn: Math.round(amount * 0.6),
      totalSuspicionAmount: Math.round(amount * 0.4),
      transactions: [
        {
          id: reference,
          date: when,
          amount,
          type: v.txnType,
          fromBank: "Commonwealth Bank of Australia",
          fromAccount: "AU-7842-0012-3345",
          fromName: name,
          toAccount: "DE89370400440532013000",
          reference,
          cryptoAddress: "bc1qseeddemowallet00000000000000000000",
        },
      ],
      ofis: [{ id: "OFI-1", name: "Deutsche Bank AG", reportDate: when, scamType: "Investment scam" }],
      pois: [{ id: "POI-1", name: "Meridian Trade Solutions GmbH", bank: "Deutsche Bank AG", account: "DE89370400440532013000", reference }],
      cryptoAddresses: ["bc1qseeddemowallet00000000000000000000"],
      ipAddresses: [{ id: "IP-1", address: "203.0.113.45", country: "Australia", date: when }],
      customerCountry: "Australia",
      additionalNotes: "Customer has not yet responded to the source-of-funds request.",
      attachments: ["gfs-evidence-pack.pdf"],
      generatedReport: `GFS report generated for ${caseDoc.uid}.`,
      metadata: { version: "1.0", createdBy: String(author._id), caseUid: caseDoc.uid },
    });
    bump("gfs");

    await RFI.create({
      ...link,
      uid: uid("RFI"),
      case: caseDoc._id,
      status: "Sent",
      primaryContactName: name,
      replyToEmail: "compliance@example.com",
      // Rfi has no `message` field — the ask lives in requestedItems[].text.
      requestedItems: [
        { text: "Source-of-funds evidence for the recent cash deposits.", txRef: reference },
        { text: "Supporting invoices for the international transfer.", txRef: reference },
      ],
      responseDeadline: new Date(when.getTime() + days(14)),
      followupDeadline: new Date(when.getTime() + days(21)),
      finalDeadline: new Date(when.getTime() + days(28)),
      activityNote: [
        { note: "RFI issued to the customer by email.", uploadedAt: when, by: author._id },
      ],
      sentAt: when,
      sentBy: author._id,
      settings: { remindersEnabled: true, reminderDays: 7 },
      metadata: { source: "seedCaseWorkflow", caseUid: caseDoc.uid },
    });
    bump("rfi");

    console.log(`    ✓ ${name.padEnd(28)} ${caseDoc.uid}  (alert ${alert.uid})`);
  }

  console.log("\n  Created:");
  Object.entries(totals).forEach(([k, v]) =>
    console.log(`    ${k.padEnd(14)} ${v}`)
  );

  await mongoose.disconnect();
  console.log("\n  Done.\n");
}

seed().catch(async (err) => {
  console.error("\n  Seed failed:", err.message);
  if (err.errors) {
    Object.entries(err.errors).forEach(([path, e]) =>
      console.error(`    · ${path}: ${e.message}`)
    );
  }
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
