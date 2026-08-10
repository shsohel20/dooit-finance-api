/**
 * Seeds SofVerification sessions (the Source of Funds tab — onboarding
 * customer queue + case-manager detail) for a tenant's customers.
 *
 * Built the same way seedCaseWorkflow.js is: on EXISTING customers of the
 * target client. One session per customer (the model has a unique index on
 * `customer` and deliberately no client/branch — SOF evidence is the
 * customer's, not any one tenant's), so a customer who already holds a real
 * session is skipped rather than touched.
 *
 * OCR records are produced by the application's own mapper
 * (buildSofOcrRecord) from raw /process-bank-documents payloads embedded
 * below, so what lands in Mongo is exactly what a live upload writes — not a
 * hand-approximation of it. The payloads are real responses captured from the
 * OCR service (Revolut statement, ING statement, payslip).
 *
 * Variants rotate across the customer list so every UI state is represented:
 *   0  verified session   — OCR-timeout doc (needs_review, Re-run OCR shows)
 *                           + fully verified Revolut statement (rich OCR)
 *   1  verified session   — ING statement + payslip, both verified
 *   2  in_review session  — single timeout doc awaiting re-run
 *   3  in_review session  — rejected at upload: url null, never stored
 *                           (OCR-first policy), only the OCR verdict remains
 *   4  pending session    — link emailed, nothing uploaded yet
 *
 * Cleanup handles: SofVerification carries no uid and no metadata field, so —
 * like AmlMatch in seedCaseWorkflow — seeded rows are marked inside the
 * provider payload (`documents.ocr.raw.seedMarker`). Variants 2/4 have no raw
 * payload to mark, so every seeded session also carries the seed address in
 * `sentTo.email`; --fresh/--clean match either handle. No real session can
 * carry both a null-actor seed address and that marker, so nothing genuine is
 * ever swept.
 *
 * Usage (run from api/):
 *   node seeds/seedSofVerification.js                    all eligible customers, DEFAULT_CLIENT
 *   node seeds/seedSofVerification.js --rows=8           first 8 eligible customers
 *   node seeds/seedSofVerification.js --client=<id>      target a different client
 *   node seeds/seedSofVerification.js --fresh            delete previous seed sessions first
 *   node seeds/seedSofVerification.js --clean            delete previous seed sessions and exit
 *   node seeds/seedSofVerification.js --dry-run          validate everything, write nothing
 */

require("dotenv").config({ path: "./config/config.env" });

const mongoose = require("mongoose");

const Customer = require("../models/Customer");
const SofVerification = require("../models/SofVerification");
// The app's own raw-response → stored-record mapper, so seeded OCR blocks are
// byte-for-byte what uploadSofDocument would have written.
const { buildSofOcrRecord } = require("../controllers/sofVerificationController");

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FRESH = argv.includes("--fresh");
const CLEAN_ONLY = argv.includes("--clean");
const DRY_RUN = argv.includes("--dry-run");

// 0 = every eligible customer of the tenant.
const ROWS = Number((argv.find((a) => a.startsWith("--rows=")) || "").split("=")[1] || 0);

// Same default tenant as seedCaseWorkflow.js.
const DEFAULT_CLIENT = "6a39e8adb23e16e4366afd2e";
const CLIENT_ID =
  (argv.find((a) => a.startsWith("--client=")) || "").split("=")[1] || DEFAULT_CLIENT;

// If this customer is in the selection they get variant 0 — the exact document
// set captured from the live session this seeder was modelled on.
const SAMPLE_CUSTOMER = "6a48e9540ec6cabdad766ff4";

const SEED_MARKER = "seedSofVerification";
// Cleanup handle for sessions whose variant carries no raw payload to mark.
// Deliberately not a routable address.
const SEED_EMAIL = "sof-seed@dooit.local";

const DAY = 24 * 60 * 60 * 1000;

// Real vault files from the session this was modelled on — View / Re-run OCR
// hit an actual PDF instead of 404ing.
const FILE_TIMEOUT_STATEMENT =
  "https://files.strikeo.com/public/docs/1786275304286-761174007.pdf";
const FILE_REVOLUT_STATEMENT =
  "https://files.strikeo.com/public/docs/1786275427844-788582365.pdf";

// ── Raw OCR payloads (as /process-bank-documents returns them) ───────────────

const REVOLUT_RAW = {
  success: true,
  document_type: "bank_statement",
  is_valid: true,
  rejection_reason: null,
  data: {
    is_valid_bank_document: true,
    rejection_reason: null,
    account_information: {
      account_holder_name: "MOHAMMAD SHAHRIAR HOSSAIN",
      account_holder_address: "Unit G02/12-14 Howard Ave\n2152\nNorthmead\nNSW",
      bank_name: "Revolut Payments Australia Pty Ltd",
      branch_name: null,
      account_number: "583047535",
      account_type: "Account (E-Money)",
      currency: "AUD",
      customer_id: null,
      routing_number: "013964",
      statement_period_start: "2024-09-02",
      statement_period_end: "2025-11-08",
      opening_balance: "AU$0.00",
      closing_balance: "AU$0.88",
    },
    pages: [
      {
        page_number: 1,
        transactions: [
          { date: "2 Sept 2024", value_date: null, description: "Top-up by *8309", reference_number: "From: *8309", transaction_type: "Top-up", branch: null, debit: null, credit: "AU$4.99", balance: "AU$4.99", dr_cr: "Cr" },
          { date: "2 Sept 2024", value_date: null, description: "Card Delivery Fee", reference_number: "Card: ****0231", transaction_type: "Fee", branch: null, debit: "AU$4.99", credit: null, balance: "AU$0.00", dr_cr: "Dr" },
          { date: "20 Sept 2024", value_date: null, description: "Top-up by *8309", reference_number: "From: *8309", transaction_type: "Top-up", branch: null, debit: null, credit: "AU$100.00", balance: "AU$100.00", dr_cr: "Cr" },
          { date: "20 Sept 2024", value_date: null, description: "Exchanged to QAR", reference_number: "247.77 QAR", transaction_type: "Exchange", branch: null, debit: "AU$100.00", credit: null, balance: "AU$0.00", dr_cr: "Dr" },
          { date: "2024-10-16", value_date: null, description: "Exchanged to AUD", reference_number: "247.77 QAR", transaction_type: "Exchange", branch: null, debit: null, credit: "AU$100.88", balance: "AU$100.88", dr_cr: "Cr" },
          { date: "2024-12-21", value_date: null, description: "To Mohammad Hossain", reference_number: "Sent from Revolut, To: Mohammad Hossain, 11259866", transaction_type: "Transfer", branch: null, debit: "AU$100.00", credit: null, balance: "AU$0.88", dr_cr: "Dr" },
        ],
      },
    ],
    summary: { total_debit: "AU$204.99", total_credit: "AU$205.87", transaction_count: 6 },
  },
  analysis: {
    patterns: [
      "Regular top-ups from the same source (*8309) on 2 Sept and 20 Sept.",
      "Frequent use of the account for currency exchange (AUD to QAR, then QAR to AUD).",
      "Account balance frequently returns to or remains near AU$0.00 after transactions.",
    ],
    anomalies: [
      "The stated statement period end date (2025-11-08) is significantly in the future relative to the latest transaction date (2024-12-21).",
      "A transfer of AU$100.00 to 'Mohammad Hossain' on 2024-12-21, which is very similar to the account holder's name 'MOHAMMAD SHAHRIAR HOSSAIN'.",
      "The pattern of immediate debit after credit (e.g., AU$4.99 top-up followed by AU$4.99 fee; AU$100.00 top-up followed by AU$100.00 exchange), suggesting funds are not held for long.",
      "Round number transactions, specifically the AU$100.00 top-up, exchange, and transfer.",
    ],
    insights: [
      "The account functions primarily as a transit account for specific transactions like card setup, currency exchange, and onward transfers, rather than for holding significant funds or receiving regular income.",
      "Low transaction velocity with only 6 transactions recorded over approximately 3.5 months (September to December 2024).",
      "Net inflow of AU$0.88 over the observed transaction period, indicating funds are not accumulating in the account.",
      "The primary source of funds is consistently identified as '*8309'.",
      "The 'Account (E-Money)' type is consistent with its observed transactional behavior, suggesting it's not a traditional primary bank account.",
    ],
    summary:
      "The Revolut account for MOHAMMAD SHAHRIAR HOSSAIN exhibits low transaction velocity, primarily serving as a transit account for specific activities. Funds are regularly topped up from a consistent source (*8309) and then quickly debited for purposes such as card delivery fees, currency exchange between AUD and QAR, and onward transfers, often leaving the balance at or near AU$0.00. A notable transaction is a AU$100.00 transfer to 'Mohammad Hossain,' a name very similar to the account holder. The statement period's future-dated end is an unusual data point.",
  },
  error: null,
  raw_text: null,
};

const ING_RAW = {
  success: true,
  document_type: "bank_statement",
  is_valid: true,
  rejection_reason: null,
  data: {
    is_valid_bank_document: true,
    rejection_reason: null,
    account_information: {
      account_holder_name: "Mr Mohammad Shahriar Hossain",
      account_holder_address: "U G02 12-14 Howard Avenue\nNORTHMEAD, NSW 2152",
      bank_name: "ING",
      branch_name: null,
      account_number: "812145116",
      account_type: "Savings Maximiser",
      currency: "AUD",
      customer_id: "80555013",
      routing_number: "923100",
      statement_period_start: "2025-07-01",
      statement_period_end: "2025-07-28",
      opening_balance: "$5,807.60",
      closing_balance: "$7,498.60",
    },
    pages: [
      {
        page_number: 1,
        transactions: [
          { date: "2025-07-03", value_date: null, description: "Me - Receipt 844268", reference_number: "844268", transaction_type: null, branch: null, debit: "-$150.00", credit: null, balance: "$5,657.60", dr_cr: null },
          { date: "2025-07-08", value_date: null, description: "Me - Receipt 229896", reference_number: "229896", transaction_type: null, branch: null, debit: null, credit: "$3,130.00", balance: "$8,586.60", dr_cr: null },
          { date: "2025-07-08", value_date: null, description: "Me - Receipt 235777", reference_number: "235777", transaction_type: null, branch: null, debit: "-$1,700.00", credit: null, balance: "$6,886.60", dr_cr: null },
          { date: "2025-07-23", value_date: null, description: "Me - Receipt 343086", reference_number: "343086", transaction_type: null, branch: null, debit: null, credit: "$3,600.00", balance: "$8,618.60", dr_cr: null },
          { date: "2025-07-26", value_date: null, description: "Me - Receipt 847800", reference_number: "847800", transaction_type: null, branch: null, debit: "-$100.00", credit: null, balance: "$7,498.60", dr_cr: null },
        ],
      },
    ],
    summary: { total_debit: null, total_credit: null, transaction_count: 13 },
  },
  analysis: {
    patterns: [
      "Two significant credit transactions ($3,130.00 and $3,600.00) occur approximately bi-weekly (July 8th and July 23rd).",
      "All transactions consistently use the generic description 'Me - Receipt XXXXXX', providing no specific counterparty or transaction type details.",
    ],
    anomalies: [
      "The generic transaction description 'Me - Receipt XXXXXX' for all entries is unusual as it provides no specific counterparty or transaction type details, hindering transparency.",
      "Two large debits ($1,700.00 and $1,550.00) occur within two days immediately following a large credit on July 8th.",
    ],
    insights: [
      "The account experienced a net inflow of $1,691.00 during the statement period, with total credits of $6,730.00 and total debits of $5,039.00.",
      "The nature of the transactions (credits followed by significant debits) could indicate funds being received and then disbursed, but the generic descriptions prevent further analysis of the purpose of these funds.",
    ],
    summary:
      "The statement for Mr Mohammad Shahriar Hossain's ING Savings Maximiser account from July 1st to July 28th, 2025, shows a net inflow of $1,691.00, increasing the balance from $5,807.60 to $7,498.60. A notable anomaly is the generic 'Me - Receipt XXXXXX' description for all transactions, which obscures counterparty and transaction type details.",
  },
  error: null,
  raw_text: null,
};

const PAYSLIP_RAW = {
  success: true,
  document_type: "payslip",
  is_valid: true,
  rejection_reason: null,
  data: {
    is_valid_bank_document: true,
    rejection_reason: null,
    payslips: [
      {
        page_number: 1,
        employee_name: "Mohammad Shahriar Hossain",
        employee_address: "93 Osprey Dr\nYangebup WA 6164",
        employee_id: null,
        employer_name: "Perth Temporary Fencing",
        employer_abn: "48 609 325 327",
        position_title: null,
        employment_type: "Casual employment",
        pay_frequency: "Fortnightly",
        pay_date: "2023-10-10",
        pay_period_start: "2023-09-25",
        pay_period_end: "2023-10-08",
        annual_salary: null,
        gross_pay: "268.75",
        net_pay: "268.75",
        tax: "0.00",
        superannuation_amount: "29.56",
        super_fund_name: "SGC - Rest Super",
        super_member_number: "711607454",
        ytd_gross: "268.75",
        ytd_tax: "0.00",
        ytd_net: null,
        payment_bsb: "062-334",
        payment_account: "****9866",
      },
    ],
  },
  analysis: {
    patterns: [
      "Pay frequency is stated as Fortnightly, and the pay period duration (14 days) is consistent with this.",
      "Superannuation is calculated at approximately 11% of gross pay, consistent with the current Superannuation Guarantee rate.",
    ],
    anomalies: ["The gross pay of $268.75 for a fortnight is relatively low."],
    insights: [
      "The employee is currently employed by Perth Temporary Fencing in a casual capacity.",
      "The estimated annual income based on this single payslip is $6,987.50.",
    ],
    summary:
      "This payslip for Mohammad Shahriar Hossain from Perth Temporary Fencing shows fortnightly casual employment with a gross income of $268.75 for the period ending 2023-10-08. No tax was withheld, consistent with low-income earners claiming the tax-free threshold.",
  },
  error: null,
  raw_text: null,
};

const REJECTED_RAW = {
  success: true,
  document_type: "bank_statement",
  is_valid: false,
  rejection_reason:
    "The uploaded file is not a recognisable bank document. No account information, transaction ledger or issuing institution could be identified.",
  data: { is_valid_bank_document: false, rejection_reason: "Not a valid bank document" },
  analysis: null,
  error: null,
  raw_text: null,
};

// ── Document builders ────────────────────────────────────────────────────────

// Marks the raw payload so cleanup can find the session — mirrors how
// seedCaseWorkflow marks AmlMatch rows inside the provider payload.
const marked = (raw) => ({ ...raw, seedMarker: SEED_MARKER });

const ocrOf = (raw, docType) => buildSofOcrRecord(marked(raw), { docType });

// An upload made while the OCR service was down: stored (evidence kept),
// needs_review, and re-runnable through reprocessSofDocument.
const timeoutDoc = (daysAgo) => ({
  docType: "bank_statement",
  type: "sof_qr_upload",
  name: "Statement (2).pdf",
  url: FILE_TIMEOUT_STATEMENT,
  mimeType: "application/pdf",
  status: "needs_review",
  ocr: buildSofOcrRecord(null, {
    docType: "bank_statement",
    ocrError: "timeout of 90000ms exceeded",
  }),
  uploadedAt: new Date(Date.now() - daysAgo * DAY),
});

const revolutDoc = (daysAgo) => ({
  docType: "bank_statement",
  type: "sof_qr_upload",
  name: "account-statement_2024-09-02_2025-11-08_en-au_efc85c.pdf",
  url: FILE_REVOLUT_STATEMENT,
  mimeType: "application/pdf",
  status: "verified",
  ocr: ocrOf(REVOLUT_RAW, "bank_statement"),
  uploadedAt: new Date(Date.now() - daysAgo * DAY),
});

const ingDoc = (daysAgo) => ({
  docType: "bank_statement",
  type: "sof_qr_upload",
  name: "ing-savings-maximiser_2025-07.pdf",
  url: FILE_REVOLUT_STATEMENT,
  mimeType: "application/pdf",
  status: "verified",
  ocr: ocrOf(ING_RAW, "bank_statement"),
  uploadedAt: new Date(Date.now() - daysAgo * DAY),
});

const payslipDoc = (daysAgo) => ({
  docType: "payslip",
  type: "sof_qr_upload",
  name: "payslip_2023-10-10_perth-temporary-fencing.pdf",
  url: FILE_TIMEOUT_STATEMENT,
  mimeType: "application/pdf",
  status: "verified",
  ocr: ocrOf(PAYSLIP_RAW, "payslip"),
  uploadedAt: new Date(Date.now() - daysAgo * DAY),
});

// Rejected at upload — under the OCR-first policy the file was never stored,
// so url is null; only the verdict and the reason remain on the record.
const rejectedDoc = (daysAgo) => ({
  docType: "bank_statement",
  type: "sof_qr_upload",
  name: "IMG_20260805_114233.jpg",
  url: null,
  mimeType: "image/jpeg",
  status: "rejected",
  ocr: ocrOf(REJECTED_RAW, "bank_statement"),
  uploadedAt: new Date(Date.now() - daysAgo * DAY),
});

// Same session-status rule as uploadSofDocument.
const sessionStatus = (docs) =>
  docs.length === 0
    ? "pending"
    : docs.some((d) => d.status === "verified")
      ? "verified"
      : "in_review";

// One entry per variant, rotated across the customer list.
const VARIANTS = [
  { label: "timeout + verified Revolut", docs: () => [timeoutDoc(2), revolutDoc(1)] },
  { label: "ING + payslip verified", docs: () => [ingDoc(5), payslipDoc(4)] },
  { label: "timeout awaiting re-run", docs: () => [timeoutDoc(1)] },
  { label: "rejected at upload (not stored)", docs: () => [rejectedDoc(3)] },
  { label: "link sent, nothing uploaded", docs: () => [] },
];

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanSeedData() {
  const { deletedCount } = await SofVerification.deleteMany({
    $or: [
      { "documents.ocr.raw.seedMarker": SEED_MARKER },
      { "sentTo.email": SEED_EMAIL },
    ],
  });
  console.log(`  − SofVerification ${deletedCount} seeded session(s) removed`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n  SOF seeder — client ${CLIENT_ID}${DRY_RUN ? " (dry run)" : ""}`);

  if (FRESH || CLEAN_ONLY) await cleanSeedData();
  if (CLEAN_ONLY) {
    await mongoose.disconnect();
    console.log("  Done.\n");
    return;
  }

  const clientOid = new mongoose.Types.ObjectId(CLIENT_ID);
  const customers = await Customer.find({ "relations.client": clientOid })
    .select("_id uid")
    .lean();

  if (!customers.length) {
    console.log("  No customers hold a relation with this client — nothing to seed.\n");
    await mongoose.disconnect();
    return;
  }

  // The customer the sample session belonged to gets the sample variant.
  customers.sort((a, b) =>
    String(a._id) === SAMPLE_CUSTOMER ? -1 : String(b._id) === SAMPLE_CUSTOMER ? 1 : 0,
  );

  // One session per customer (unique index) — a customer with a real session
  // is left alone entirely.
  const existing = new Set(
    (
      await SofVerification.find({ customer: { $in: customers.map((c) => c._id) } })
        .select("customer")
        .lean()
    ).map((s) => String(s.customer)),
  );

  const eligible = customers.filter((c) => !existing.has(String(c._id)));
  const targets = ROWS > 0 ? eligible.slice(0, ROWS) : eligible;

  console.log(
    `  ${customers.length} customer(s) in tenant, ${existing.size} already have a session, seeding ${targets.length}\n`,
  );

  let created = 0;
  const byVariant = {};

  for (let i = 0; i < targets.length; i++) {
    const customer = targets[i];
    const variant = VARIANTS[i % VARIANTS.length];
    const docs = variant.docs();

    const doc = new SofVerification({
      customer: customer._id,
      status: sessionStatus(docs),
      documents: docs,
      // Public uploads have no actor — matches the live sessions.
      createdBy: null,
      // The seed address doubles as the cleanup handle for variants that
      // carry no raw OCR payload to mark (timeout-only, empty).
      sentTo: { email: SEED_EMAIL, sentAt: new Date(Date.now() - 6 * DAY) },
    });

    try {
      await doc.validate();
    } catch (err) {
      err.message = `SofVerification (${customer.uid || customer._id}): ${err.message}`;
      throw err;
    }
    if (!DRY_RUN) await SofVerification.create(doc.toObject());

    byVariant[variant.label] = (byVariant[variant.label] || 0) + 1;
    created += 1;
    console.log(`    ✓ ${(customer.uid || String(customer._id)).padEnd(28)} ${variant.label}`);
  }

  console.log(`\n  Created ${created} session(s)${DRY_RUN ? " (dry run — nothing written)" : ""}:`);
  Object.entries(byVariant).forEach(([k, v]) => console.log(`    ${String(v).padStart(2)} × ${k}`));

  await mongoose.disconnect();
  console.log("\n  Done.\n");
}

seed().catch(async (err) => {
  console.error("\n  Seed failed:", err.message);
  if (err.errors) {
    Object.entries(err.errors).forEach(([path, e]) => console.error(`    · ${path}: ${e.message}`));
  }
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
