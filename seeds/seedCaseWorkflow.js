/**
 * Seeds a complete investigation chain:
 *
 *   Branch → Customer (+ CustomerAccount + CRA) → Transaction → Alert → Case
 *          → { ECDD, RFI, SMR, GFS, IFTI, TTR } (+ CaseNote + AuditLog)
 *
 * By default the chain is built on EXISTING customers: the script reads real
 * Customer documents and derives client/branch from the tenant relation on
 * each, so the seeded data lands inside the tenant the customer already
 * belongs to.
 *
 * A brand-new tenant has no customers to build on. Two flags fill that gap, and
 * both work through `Customer.relations[]` — the array entry that is what makes
 * a customer belong to a client:
 *
 *   --attach-customers=N|all  Adds this client to the relations[] of Customers
 *                             that ALREADY EXIST and hold no relation to it.
 *                             No new Customer is created; the real customer
 *                             base simply gains this tenant. Type and
 *                             onboarding channel are carried over from the
 *                             customer's existing relation. Idempotent.
 *
 *   --make-customers=N        Creates N synthetic Customers instead, each with
 *                             a relations[] entry for the client plus a
 *                             CustomerAccount and a CRA. Use only when there is
 *                             no real customer base to attach. All are
 *                             `individual` — company/trust relations need a
 *                             CompanyKyc/TrustKyc behind relationId.
 *
 * Either flag also provisions a Branch for the tenant when it has none.
 * --attach-customers additionally:
 *   • copies each customer's most recent OnboardingJourney across to this
 *     client — steps, documents, events, OCR and provider payloads preserved,
 *     only the tenant fields rewritten (also available as --copy-journeys);
 *   • screens each customer and writes AmlMatch rows through amlMatchService,
 *     so amlStatus / isPep / sanction are derived by the application's own rule
 *     rather than asserted here (also available as --seed-aml-matches).
 *
 * NOTE AmlMatch carries no client field — a match is keyed (customer, matchId)
 * and therefore follows the customer into every tenant they belong to. There is
 * nothing tenant-specific to copy; a customer either has matches or does not.
 *
 * Coverage: every schema path on every model is populated, so no UI section
 * renders blank for want of data. The only paths left at their defaults are the
 * soft-delete pair (isDeleted / deletedAt is set explicitly to the "live" value)
 * and Alert.ruleRef → RuleEngine, which is bound to a real rule when one exists.
 *
 * AI narratives: every section that has a prose slot gets a full analyst-style
 * write-up rather than a one-line placeholder — ECDD profile summary /
 * transaction analysis / behavioural analysis / recommendation, SMR
 * partB.groundsForSuspicion, GFS suspicionReason + generatedReport, the IFTI
 * narrative, the TTR conduct description, the RFI email body, the CRA notes and
 * the case notes. They are all generated together from one context so a case
 * reads as a single coherent analysis. The same bundle is mirrored onto
 * Alert.metadata and EcddReport.metadata as ecddReport / smrReport / rfiReport /
 * gfsReport (+ dismissalReport on the resolved variant), matching the payload
 * shape the *AlertSeeder scripts persist from the AI service.
 *
 * Field-name split is deliberate and matches the models:
 *   • ECDD + SMR             → `caseId`
 *   • TTR + IFTI + GFS + RFI → `case`
 * Every report also carries `alert` (provenance) and `customer`.
 *
 * Usage:
 *   node seeds/seedCaseWorkflow.js                     20 rows for DEFAULT_CLIENT
 *   node seeds/seedCaseWorkflow.js --rows=50           more rows (customers cycle)
 *   node seeds/seedCaseWorkflow.js --client=<id>       target a different client
 *   node seeds/seedCaseWorkflow.js --attach-customers=all  onboard existing customers
 *   node seeds/seedCaseWorkflow.js --make-customers=8  create 8 customers first
 *   node seeds/seedCaseWorkflow.js --fresh             delete previous seed data first
 *   node seeds/seedCaseWorkflow.js --clean             delete previous seed data and exit
 *   node seeds/seedCaseWorkflow.js --drop-synthetic --client=<id>
 *                                                      remove ONLY the --make-customers
 *                                                      customers of that client and their
 *                                                      chains, and exit. Unlike --clean,
 *                                                      chains built on real customers and
 *                                                      other tenants are left alone.
 *
 * Bootstrapping a tenant that has no customers yet (run from api/):
 *   node seeds/seedCaseWorkflow.js --dry-run --attach-customers=all --rows=20 --client=6a716afc2544b240f81a7dba
 *   node seeds/seedCaseWorkflow.js          --attach-customers=all --rows=20 --client=6a716afc2544b240f81a7dba
 *
 * Everything created carries "SEED" inside its uid, which is how --fresh/--clean
 * find it — including the Branch and Customers made by --make-customers.
 * CaseNote and AuditLog have no uid, so they are matched through the seeded
 * cases they belong to and removed before those cases are. Relations added by
 * --attach-customers are stamped `source: "seed"` and pulled back off the real
 * customer, which is never itself deleted. No non-seeded document is otherwise
 * touched, except Alert.linkedCase / Alert.status on alerts this script created.
 */

require("dotenv").config({ path: "./config/config.env" });

const crypto = require("crypto");
const mongoose = require("mongoose");
// loadRiskCache() logs through the colors String prototype extensions.
require("colors");

const Customer = require("../models/Customer");
const CustomerAccount = require("../models/CustomerAccount");
const Client = require("../models/Client");
const Branch = require("../models/Branch");
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
const CaseNote = require("../models/CaseNote");
const AuditLog = require("../models/AuditLog");
const OnboardingJourney = require("../models/OnboardingJourney");
const AmlMatch = require("../models/AmlMatch");
const {
  upsertMatchesForCustomer,
  recomputeCustomerAmlStatus,
} = require("../services/amlMatchService");
const { loadRiskCache, getCache } = require("../utils/riskFactorCache");
const { buildRiskAssessmentFromCustomer } = require("../utils/riskAssessment");
const { logCraEvent } = require("../utils/craAudit");
const RuleEngine = require("../models/RuleEngine");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FRESH = argv.includes("--fresh");
const CLEAN_ONLY = argv.includes("--clean");
// Build and validate every document without writing anything. Catches cast /
// enum / required failures up front instead of part-way through a run.
const DRY_RUN = argv.includes("--dry-run");

// How many chains to create. Independent of how many customers exist — the
// customer pool is cycled, so a client with 11 customers can still back 20
// rows. `--customers=` is kept as an alias for the original flag.
const ROWS = Number(
  (argv.find((a) => a.startsWith("--rows=")) || "").split("=")[1] ||
    (argv.find((a) => a.startsWith("--customers=")) || "").split("=")[1] ||
    20
);

// How many Customers to CREATE before the chain runs, each carrying a
// relations[] entry for the target client. 0 (the default) keeps the original
// behaviour: build only on customers that already exist in the tenant.
const MAKE_CUSTOMERS = Number(
  (argv.find((a) => a.startsWith("--make-customers=")) || "").split("=")[1] || 0
);

// Attach the target client to Customers that ALREADY EXIST but hold no relation
// to it — the real customer base gains this tenant rather than a synthetic one
// being invented alongside it. `all` takes every eligible customer; null (the
// default) means the flag was not passed at all.
const ATTACH_RAW = (argv.find((a) => a.startsWith("--attach-customers=")) || "")
  .split("=")[1];
const ATTACH_CUSTOMERS =
  ATTACH_RAW === undefined ? null : ATTACH_RAW === "all" ? 0 : Number(ATTACH_RAW);

// Relation.source stamped on every relations[] entry this script writes. It is
// what --fresh/--clean matches to detach them again, so it must not collide
// with the values the application itself writes ("api", "in-branch", "web", …).
const SEED_RELATION_SOURCE = "seed";

const RELATION_TYPES = [
  "individual", "company", "partnership", "government_body",
  "association", "cooperative", "trust",
];

// Removes ONLY the synthetic customers made by --make-customers, and everything
// hanging off them, for the target client. Distinct from --clean: chains built
// on real customers carry SEED uids too, so --clean would take those with it.
const DROP_SYNTHETIC = argv.includes("--drop-synthetic");

// Copies each attached customer's existing OnboardingJourney across to this
// client. Runs automatically with --attach-customers; the flag exists so it can
// be run on its own against customers attached by an earlier invocation.
const COPY_JOURNEYS = argv.includes("--copy-journeys");

// Screens each attached customer and writes the resulting AmlMatch rows. Runs
// automatically with --attach-customers; the flag runs it on its own.
const SEED_AML = argv.includes("--seed-aml-matches");

// AmlMatch carries no client and no uid, so seeded rows are marked inside the
// provider payload — the only field on the model that will hold a handle for
// cleanup without corrupting a column the UI renders.
const AML_SEED_MARKER = "seedCaseWorkflow";

// Gives each attached customer a CustomerAccount and a CRA under this client —
// both are tenant-scoped, so an onboarded customer has neither until written.
// Runs automatically with --attach-customers.
const SEED_ACCOUNTS = argv.includes("--seed-accounts");

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

// Run tally, shared by the provisioning helpers and the chain loop.
const totals = {};
const bump = (k) => (totals[k] = (totals[k] || 0) + 1);

// Every model whose seeded rows are identifiable by "SEED" in the uid.
// Ordered leaf-first so a partial failure never strands a child row.
const MODELS = [
  ["EcddReport", EcddReport],
  ["SMR", SMR],
  ["TTR", TTR],
  ["IFTI", IFTI],
  ["GFS", GFS],
  ["RFI", RFI],
  ["Case", Case],
  ["Alert", Alert],
  ["Transaction", Transaction],
  ["CRA", IndividualRiskAssessment],
  ["CustomerAccount", CustomerAccount],
  ["Customer", Customer],
  ["Branch", Branch],
];

async function cleanSeedData() {
  console.log("\n  Removing previous seed data…");

  // Relations pushed onto pre-existing customers by --attach-customers. Those
  // customers are real and must survive — only the relations[] entry this
  // script added for this client is pulled back off.
  if (mongoose.Types.ObjectId.isValid(CLIENT_ID)) {
    const clientOid = new mongoose.Types.ObjectId(CLIENT_ID);

    // Journeys copied onto this tenant. Matched on the marker rather than the
    // client alone, so a journey the tenant genuinely owns is never removed.
    const journeys = await OnboardingJourney.deleteMany({
      client: clientOid,
      "metadata.source": "seedCaseWorkflow",
    });
    if (journeys.deletedCount) {
      console.log(`    − ${"OnboardingJourney".padEnd(16)} ${journeys.deletedCount} removed`);
    }

    // AML matches written for this tenant's attached customers. Matched on the
    // marker inside the provider payload — the model carries no client field,
    // so a genuine match from a real screen must not be caught by this.
    const aml = await AmlMatch.deleteMany({ "raw.seedMarker": AML_SEED_MARKER });
    if (aml.deletedCount) {
      console.log(`    − ${"AmlMatch".padEnd(16)} ${aml.deletedCount} removed`);
    }

    const rel = { client: clientOid, source: SEED_RELATION_SOURCE };
    const { modifiedCount } = await Customer.updateMany(
      { relations: { $elemMatch: rel } },
      { $pull: { relations: rel } }
    );
    if (modifiedCount) {
      console.log(`    − ${"relations[]".padEnd(16)} ${modifiedCount} detached`);
    }
  }

  // CaseNote and AuditLog carry no uid, so they are matched through the cases
  // they belong to — which means they must go before the Case rows do.
  const seededCases = await Case.find({ uid: SEED_RX }).select("_id").lean();
  if (seededCases.length) {
    const caseIds = seededCases.map((c) => c._id);
    for (const [name, Model] of [["CaseNote", CaseNote], ["AuditLog", AuditLog]]) {
      const { deletedCount } = await Model.deleteMany({ case: { $in: caseIds } });
      if (deletedCount) console.log(`    − ${name.padEnd(16)} ${deletedCount} removed`);
    }
  }

  for (const [name, Model] of MODELS) {
    const { deletedCount } = await Model.deleteMany({ uid: SEED_RX });
    if (deletedCount) console.log(`    − ${name.padEnd(16)} ${deletedCount} removed`);
  }
}

/**
 * Copies each attached customer's OnboardingJourney across to this client.
 *
 * A journey is scoped to one (customer, client, branch) — that triple carries a
 * unique index — so onboarding an existing customer to another tenant leaves
 * that tenant with no journey to show. The customer's most recent journey is
 * cloned wholesale: every step, document, event, OCR payload and provider
 * response is preserved, and only the tenant fields are rewritten. The source
 * journey is never modified.
 *
 * `relationIndex` is re-pointed at the relations[] entry for THIS client rather
 * than copied — the index is positional, and the new relation sits at the end
 * of the array, not where the original one was.
 *
 * Only customers attached by this script are considered, so a customer who
 * legitimately belongs to the tenant already is never given a duplicate.
 */
async function copyJourneys(clientId, branchId) {
  const attached = await Customer.find({
    relations: { $elemMatch: { client: clientId, source: SEED_RELATION_SOURCE } },
  })
    .select("_id uid relations")
    .lean();

  if (!attached.length) {
    console.log("  Journeys: no attached customers to copy for");
    return;
  }

  const ids = attached.map((c) => c._id);

  // Newest first, so the reduce below keeps the most recent journey per customer.
  const sources = await OnboardingJourney.find({
    customer: { $in: ids },
    client: { $ne: clientId },
  })
    .sort({ updatedAt: -1 })
    .lean();

  const latest = new Map();
  for (const j of sources) {
    if (!latest.has(String(j.customer))) latest.set(String(j.customer), j);
  }

  // Skip customers that already hold a journey for this tenant, so re-running
  // is a no-op rather than a unique-index violation.
  const existing = new Set(
    (
      await OnboardingJourney.find({ customer: { $in: ids }, client: clientId })
        .select("customer")
        .lean()
    ).map((j) => String(j.customer))
  );

  let copied = 0;
  let missing = 0;

  for (const c of attached) {
    const key = String(c._id);
    if (existing.has(key)) continue;

    const src = latest.get(key);
    if (!src) {
      missing += 1;
      continue;
    }

    const relationIndex = c.relations.findIndex(
      (r) => String(r.client) === String(clientId) && r.source === SEED_RELATION_SOURCE
    );

    // Everything except identity, tenancy and the timestamps Mongoose owns.
    const { _id, __v, createdAt, updatedAt, client, branch, relationIndex: _ri, metadata, ...carried } = src;

    await persist(OnboardingJourney, {
      ...carried,
      client: clientId,
      branch: branchId,
      relationIndex: relationIndex >= 0 ? relationIndex : 0,
      metadata: {
        ...(metadata || {}),
        source: "seedCaseWorkflow",
        copiedFromJourney: String(_id),
        copiedFromClient: String(client),
        copiedAt: new Date(),
      },
    });

    copied += 1;
    bump("journeys");
  }

  console.log(
    `  Journeys: ${copied} copied` +
      (missing ? `, ${missing} customer(s) had none to copy` : "") +
      (existing.size ? `, ${existing.size} already had one for this client` : "")
  );
}

// ── AML screening ────────────────────────────────────────────────────────────

/**
 * UUID-shaped but deterministic, derived from the customer and the hit index.
 *
 * The provider's matchId is the upsert key with `customer`, so it must be
 * stable: a fresh random id on every run would insert a duplicate hit for the
 * same person rather than being recognised as already present.
 */
const stableMatchId = (customerId, index) => {
  const h = crypto.createHash("sha1").update(`${AML_SEED_MARKER}:${customerId}:${index}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * Provider hits in ComplyAdvantage Mesh shape, as Sumsub returns them.
 *
 * `disposition` is the analyst decision applied after the row is written — it
 * is deliberately NOT part of the hit, because the service treats those fields
 * as $setOnInsert only (a re-screen must never reset a review). Spreading the
 * variants across the customer base gives the screening queue a real mix:
 * resolved false positives, an unreviewed PEP, a confirmed sanctions hit, and
 * customers with no hits at all.
 */
const AML_HIT_TEMPLATES = [
  {
    weight: "adverse_media_resolved",
    build: (name) => ({
      name,
      entityType: "individual",
      riskLabels: ["adverseMedia"],
      sources: [
        { type: "watchlist", name: "ComplyAdvantage Adverse Media" },
        {
          type: "media",
          url: "https://www.thedailystar.net/business/news/central-bank-tightens-monitoring-cash-transactions-3012345",
          publishedDate: "2024-11-14 00:00:00",
          title: "Central bank tightens monitoring of large cash transactions",
          annotation:
            "Bangladesh Bank has instructed scheduled banks to report cash transactions above Tk 10 lakh within 24 hours. A person of the same name was cited in the reporting as an account holder at a branch under review; no allegation of wrongdoing was made against the individual.",
        },
        {
          type: "media",
          url: "https://www.newagebd.net/article/224411/court-clears-trader-of-import-duty-allegation",
          publishedDate: "2023-05-09 00:00:00",
          title: "Court clears trader of import duty allegation",
          annotation:
            "The court found no evidence supporting the allegation of under-invoicing and dismissed the case. The trader, who shares a common name with several other importers on the register, had been named in an earlier customs notice that was subsequently withdrawn.",
        },
      ],
      review: { matchStatus: "unknown", modifiedAt: ymd(new Date()) },
    }),
    disposition: {
      matchStatus: "false_positive",
      whitelisted: true,
      riskLevel: "",
      reviewStatus: "reviewed",
      reviewNote:
        "Common-name collision. Date of birth and national ID on the customer's file do not match the subject of the cited articles, and the reporting carries no allegation against the customer. Dismissed as a false positive and whitelisted so re-screening does not re-raise it.",
    },
  },
  {
    weight: "pep_unreviewed",
    build: (name) => ({
      name,
      entityType: "individual",
      riskLabels: ["pep"],
      categories: ["Pep Class 2"],
      sources: [
        { type: "watchlist", name: "ComplyAdvantage PEP" },
        {
          type: "media",
          url: "https://www.thefinancialexpress.com.bd/national/board-appointments-announced-for-state-owned-enterprises-1699887654",
          publishedDate: "2024-02-18 00:00:00",
          title: "Board appointments announced for state-owned enterprises",
          annotation:
            "The ministry confirmed the appointment of several directors to the boards of state-owned enterprises. Individuals holding such positions are treated as politically exposed persons for the duration of their appointment and for twelve months thereafter.",
        },
      ],
      review: { matchStatus: "unknown", modifiedAt: ymd(new Date()) },
    }),
    disposition: {
      matchStatus: "potential_match",
      whitelisted: false,
      riskLevel: "medium",
      reviewStatus: "pending",
      reviewNote: "",
    },
  },
  {
    weight: "sanctions_confirmed",
    build: (name) => ({
      name,
      entityType: "individual",
      riskLabels: ["sanctions", "adverseMedia"],
      categories: ["Sanctions", "ComplyAdvantage Adverse Media"],
      countries: ["Bangladesh", "United Arab Emirates"],
      aka: [name.split(" ").reverse().join(" "), name.toUpperCase()],
      sources: [
        { type: "watchlist", name: "DFAT Australia Consolidated Sanctions List" },
        { type: "watchlist", name: "OFAC Specially Designated Nationals (SDN) List" },
        {
          type: "media",
          url: "https://www.reuters.com/world/asia-pacific/sanctions-designations-trade-network-2024-09-11/",
          publishedDate: "2024-09-11 00:00:00",
          title: "Authorities designate individuals linked to a trade-based value transfer network",
          annotation:
            "The designations name individuals said to have moved value through over-invoiced commodity shipments routed via intermediaries in the Gulf. Financial institutions are required to freeze assets and refuse further dealings with the designated parties.",
        },
      ],
      review: { matchStatus: "unknown", modifiedAt: ymd(new Date()) },
    }),
    disposition: {
      matchStatus: "true_positive",
      whitelisted: false,
      riskLevel: "high",
      reviewStatus: "reviewed",
      reviewNote:
        "Confirmed match on name, date of birth and nationality against the DFAT and OFAC listings. Asset freeze obligations apply. Service delivery suspended, outbound transfers blocked, and the matter escalated to the Compliance Officer for a suspicious matter report decision.",
    },
  },
  {
    weight: "adverse_media_open",
    build: (name) => ({
      name,
      entityType: "individual",
      riskLabels: ["adverseMedia", "financialCrime"],
      sources: [
        { type: "watchlist", name: "ComplyAdvantage Adverse Media" },
        {
          type: "media",
          url: "https://www.dhakatribune.com/bangladesh/court/338822/three-charged-over-alleged-hundi-operation",
          publishedDate: "2025-03-27 00:00:00",
          title: "Three charged over alleged hundi operation",
          annotation:
            "Investigators allege the group received funds from overseas workers and settled them locally outside the formal banking channel. Charges have been filed and the matter is listed for hearing; the accused have not entered a plea.",
        },
        {
          type: "media",
          url: "https://www.tbsnews.net/economy/banking/regulator-flags-remittance-channel-irregularities-772210",
          publishedDate: "2025-01-30 00:00:00",
          title: "Regulator flags irregularities in informal remittance channels",
          annotation:
            "The regulator's review identified accounts receiving frequent inbound transfers from multiple unrelated senders followed by same-day cash withdrawal, a pattern it described as consistent with informal value transfer.",
        },
      ],
      review: { matchStatus: "unknown", modifiedAt: ymd(new Date()) },
    }),
    disposition: {
      matchStatus: "unknown",
      whitelisted: false,
      riskLevel: "medium",
      reviewStatus: "pending",
      reviewNote: "",
    },
  },
];

/**
 * A screening hit names a PERSON. Many customers in the base have no KYC name
 * captured yet, and "Customer CR_1782540513811" as the subject of an adverse
 * media article is nonsense, so those fall back to a plausible name instead of
 * the record id.
 */
const AML_FALLBACK_NAMES = [
  "Md. Rafiqul Islam", "Nasrin Akter", "Abdul Karim Chowdhury", "Shahana Begum",
  "Mizanur Rahman", "Farhana Yasmin", "Kamrul Hasan", "Rubina Sultana",
];

// Which templates each customer gets, by position in the customer list. Some
// slots are empty on purpose so `amlStatus: "clear"` is represented too.
const AML_ASSIGNMENT = [
  [0], [1], [2], [3], [], [0, 3], [1], [], [0], [3],
  [2, 0], [], [1], [0], [3], [], [0, 1], [2], [], [3], [0], [1], [],
];

/**
 * Screens the attached customers and writes their AmlMatch rows.
 *
 * Routed through amlMatchService rather than writing AmlMatch directly, so the
 * hits are normalised and the customer's amlStatus / isPep / sanction flags are
 * derived by the application's own rule ("effective" = not whitelisted and not
 * a false positive) instead of being asserted here. The analyst disposition is
 * applied in a second pass because the service writes those fields
 * $setOnInsert only — by design, so a re-screen never resets a review.
 */
async function seedAmlMatches(clientId, reviewerId) {
  const attached = await Customer.find({
    relations: { $elemMatch: { client: clientId, source: SEED_RELATION_SOURCE } },
  })
    .select("_id uid sumsubApplicantId personalKyc")
    .lean();

  if (!attached.length) {
    console.log("  AML: no attached customers to screen");
    return;
  }

  let inserted = 0;
  let screened = 0;
  let noHits = 0;

  for (let i = 0; i < attached.length; i++) {
    const c = attached[i];
    const kyc = c.personalKyc?.personal_form?.customer_details || {};
    const name =
      [kyc.given_name, kyc.surname].filter(Boolean).join(" ") ||
      AML_FALLBACK_NAMES[i % AML_FALLBACK_NAMES.length];

    const picks = AML_ASSIGNMENT[i % AML_ASSIGNMENT.length];
    const hits = picks.map((t, idx) => ({
      id: stableMatchId(c._id, idx),
      ...AML_HIT_TEMPLATES[t].build(name),
      // Cleanup handle. Lives in the provider payload because the model has no
      // other field that survives normalizeHit untouched.
      seedMarker: AML_SEED_MARKER,
    }));

    if (DRY_RUN) {
      screened += 1;
      inserted += hits.length;
      if (!hits.length) noHits += 1;
      continue;
    }

    // The service skips matchIds the customer already has — correct for a real
    // re-screen (never clobber a review), but it means a re-run of this seeder
    // could not correct its own output. Only rows this seeder wrote are cleared;
    // a genuine match from a real screen is never touched.
    await AmlMatch.deleteMany({ customer: c._id, "raw.seedMarker": AML_SEED_MARKER });

    if (hits.length) {
      inserted += await upsertMatchesForCustomer(c, hits);

      // Second pass — the analyst decision the service deliberately won't
      // overwrite on an existing row.
      for (let idx = 0; idx < picks.length; idx++) {
        const d = AML_HIT_TEMPLATES[picks[idx]].disposition;
        await AmlMatch.updateOne(
          { customer: c._id, matchId: hits[idx].id },
          {
            $set: {
              ...d,
              reviewedBy: d.reviewStatus === "reviewed" ? reviewerId : null,
              reviewedAt: d.reviewStatus === "reviewed" ? new Date() : null,
            },
          }
        );
      }
    } else {
      noHits += 1;
    }

    // Screening metadata on the customer itself. amlStatus / isPep / sanction
    // are left to recompute below — asserting them here would let this seeder
    // disagree with the application's own derivation.
    await Customer.updateOne(
      { _id: c._id },
      {
        $set: {
          amlHits: hits,
          amlRiskLabels: Array.from(new Set(hits.flatMap((h) => h.riskLabels || []))),
          amlCheckedAt: new Date(),
          amlVendor: "Powered by ComplyAdvantage CSOM",
          consentToScreen: true,
        },
      }
    );

    await recomputeCustomerAmlStatus(c._id);
    screened += 1;
  }

  console.log(
    `  AML: ${screened} customer(s) screened, ${inserted} match(es) written, ` +
      `${noHits} returned no hits${DRY_RUN ? " (dry run — nothing written)" : ""}`
  );
}

/**
 * Repoints the seeded relation's registeredAt at the customer's original
 * onboarding date.
 *
 * Relations written before attachCustomers carried the date over were stamped
 * with the run date, which rated every long-standing customer as a new
 * relationship in the CRA and contradicted their copied onboarding journey.
 * Idempotent — running it again sets the same value.
 */
async function syncRelationDates(clientId) {
  const attached = await Customer.find({
    relations: { $elemMatch: { client: clientId, source: SEED_RELATION_SOURCE } },
  })
    .select("_id relations")
    .lean();

  let fixed = 0;
  for (const c of attached) {
    const original = c.relations.find(
      (r) => String(r.client) !== String(clientId) && r.registeredAt
    );
    const seeded = c.relations.find(
      (r) => String(r.client) === String(clientId) && r.source === SEED_RELATION_SOURCE
    );
    if (!original || !seeded) continue;
    if (+new Date(seeded.registeredAt) === +new Date(original.registeredAt)) continue;

    if (!DRY_RUN) {
      await Customer.updateOne(
        { _id: c._id, relations: { $elemMatch: { client: clientId, source: SEED_RELATION_SOURCE } } },
        { $set: { "relations.$.registeredAt": new Date(original.registeredAt) } }
      );
    }
    fixed += 1;
  }

  if (fixed) console.log(`  Relations: ${fixed} onboarding date(s) aligned to the original relation`);
  return fixed;
}

// ── Accounts + CRA for attached customers ────────────────────────────────────

// Products are catalogued per reporting-entity type; Prime Bank scores against
// the "Banks & ADIs" catalogue. Rotated so the product factor varies.
const CRA_ENTITY_TYPE = "Banks & ADIs";
const CRA_PRODUCTS = [
  "Everyday transaction / savings account (personal)",
  "Domestic funds transfer / RTGS / OSKO",
  "Foreign currency exchange / FX services",
  "International wire transfer (SWIFT / correspondent)",
  "Personal loan / mortgage",
  "Private banking / HNW wealth management",
];

// Every value below is a live RiskFactorOption. A string the catalogue does not
// contain scores 0 silently, which would look like a working assessment while
// contributing nothing — so these are taken from the seeded options, not invented.
const CRA_OCCUPATIONS = [
  "Managers", "Professionals", "Business Owner", "Sales Workers",
  "Clerical and Administrative Workers", "Technicians and Trades Workers",
];
const CRA_INDUSTRIES = [
  "Wholesale Trade", "Retail Trade", "Construction", "Manufacturing",
  "Professional, Scientific and Technical Services", "Financial and Insurance Services",
];
const CRA_CHANNELS = ["in-branch", "mobile app", "web", "agent", "api"];

/**
 * Returns `raw` only when the factor catalogue actually contains it.
 *
 * The engine scores an unrecognised string as 0 without complaining, so a real
 * KYC value the catalogue does not carry — "Software Engineer" against an
 * ANZSCO-style occupation list, "IT" against the industry list — produces an
 * assessment that looks complete but has two factors contributing nothing.
 * Preferring the customer's own data is right; silently scoring it as zero is
 * not, so anything unmatched falls back to a catalogue value.
 */
const catalogueValue = (factor, raw, fallback) => {
  if (!raw) return fallback;
  const options = getCache().factors?.[factor] || [];
  const hit = options.some(
    (o) => String(o.value).trim().toLowerCase() === String(raw).trim().toLowerCase()
  );
  return hit ? raw : fallback;
};

/**
 * Builds the CRA input payload for one customer.
 *
 * The engine reads a customer-SHAPED object, but the CRA answers themselves
 * (pepStatus, sourceOfFunds, adverseMedia, product, entityType) are questionnaire
 * responses a compliance officer enters — they do not exist on a Customer
 * document, which is why scoring the raw record returns Low for everyone
 * including a sanctioned customer. This supplies those answers; the engine still
 * does the scoring.
 *
 * The EDD answers are derived from the AML screening already written, so the CRA
 * and the screening cannot contradict each other — a customer flagged by
 * screening scores as such here too.
 */
const buildCraPayload = (customer, relation, index) => {
  const kyc = customer.personalKyc?.personal_form || {};
  const funds = customer.personalKyc?.funds_wealth || {};

  const pepStatus = customer.isPep
    ? index % 5 === 2
      ? "Foreign PEP / close associate"
      : "Domestic PEP / close associate"
    : "Not a PEP";

  const labels = customer.amlRiskLabels || [];
  // Keyed off the SCREENING OUTCOME, not the raw labels: a hit dismissed as
  // mistaken identity leaves amlStatus "clear", and scoring that customer as
  // having adverse media would contradict the analyst who cleared them.
  const adverseMedia =
    customer.sanction || customer.amlStatus === "flagged"
      ? "Confirmed criminal connection"
      : customer.amlStatus === "yellow"
        ? labels.includes("adverseMedia")
          ? "Significant adverse media"
          : "Minor adverse media"
        : "No adverse media";

  // An unresolved or confirmed screening hit means the funds story is not
  // settled; a clear screen with KYC on file means it is.
  const sofTier =
    customer.sanction || customer.amlStatus === "flagged"
      ? "Cannot be explained / refuses"
      : customer.amlStatus === "yellow"
        ? "Plausible but unverified"
        : "Clearly established and verified";

  return {
    // Identity / tenancy the engine reads
    country: customer.country || "Bangladesh",
    entityType: CRA_ENTITY_TYPE,
    // relation.source is the seeder's provenance marker, which is not a channel
    // the catalogue knows — the real onboarding channel is substituted here so
    // the channel factor scores.
    relations: [
      {
        ...relation,
        source: CRA_CHANNELS[index % CRA_CHANNELS.length],
        type: relation.type || "individual",
      },
    ],
    personalKyc: {
      personal_form: {
        ...kyc,
        employment_details: {
          occupation: catalogueValue(
            "occupation",
            kyc.employment_details?.occupation,
            CRA_OCCUPATIONS[index % CRA_OCCUPATIONS.length]
          ),
          industry: catalogueValue(
            "industry",
            kyc.employment_details?.industry,
            CRA_INDUSTRIES[index % CRA_INDUSTRIES.length]
          ),
          employer_name: kyc.employment_details?.employer_name || "",
        },
      },
    },
    // CRA questionnaire answers
    pepStatus,
    adverseMedia,
    sourceOfFunds: sofTier,
    sourceOfWealth: sofTier,
    metadata: {
      entityType: CRA_ENTITY_TYPE,
      product: CRA_PRODUCTS[index % CRA_PRODUCTS.length],
      accountPurpose: funds.account_purpose || "Personal banking",
      expectedVolume: funds.estimated_trading_volume || "BDT 500,000 – 2,000,000 / month",
      source: "seedCaseWorkflow",
    },
  };
};

/**
 * Gives every attached customer a CustomerAccount and a CRA under this client.
 *
 * Both are tenant-scoped records, so onboarding a customer to a new client
 * leaves them without either — the account list and the risk register read
 * empty even though the customer is present.
 *
 * The CRA score is computed by the application's own engine
 * (buildRiskAssessmentFromCustomer) and stored with the same field mapping the
 * controller uses, including the CRA_CREATED audit entry. Nothing about the
 * score, the band, the ECDD gate or the review date is asserted here.
 */
async function seedAccountsAndCra(clientId, branchId, author) {
  // customerRetention is scored off the relation's registeredAt, so the dates
  // have to be right before anything is assessed.
  await syncRelationDates(clientId);

  const attached = await Customer.find({
    relations: { $elemMatch: { client: clientId, source: SEED_RELATION_SOURCE } },
  })
    .select("_id uid country personalKyc relations isPep sanction amlStatus amlRiskLabels")
    .lean();

  if (!attached.length) {
    console.log("  Accounts/CRA: no attached customers");
    return;
  }

  // The engine scores against CountryRisk + RiskFactorOption held in a module
  // cache the API warms at boot. A script has to warm it itself, or every
  // factor lookup misses and the whole assessment returns zero.
  await loadRiskCache();

  const haveAccount = new Set(
    (await CustomerAccount.find({ client: clientId, customer: { $in: attached.map((c) => c._id) } })
      .select("customer")
      .lean()).map((a) => String(a.customer))
  );
  const haveCra = new Set(
    (await IndividualRiskAssessment.find({ client: clientId, customer: { $in: attached.map((c) => c._id) } })
      .select("customer")
      .lean()).map((a) => String(a.customer))
  );

  let accounts = 0;
  let cras = 0;
  const bands = {};

  for (let i = 0; i < attached.length; i++) {
    const c = attached[i];
    const kyc = c.personalKyc?.personal_form || {};
    const details = kyc.customer_details || {};
    const name =
      [details.given_name, details.surname].filter(Boolean).join(" ") ||
      AML_FALLBACK_NAMES[i % AML_FALLBACK_NAMES.length];
    const relation =
      c.relations.find(
        (r) => String(r.client) === String(clientId) && r.source === SEED_RELATION_SOURCE
      ) || {};
    const openedAt = relation.registeredAt || new Date();

    // ── CustomerAccount ─────────────────────────────────────────────────────
    if (!haveAccount.has(String(c._id))) {
      await persist(CustomerAccount, {
        uid: uid("ACC"),
        client: clientId,
        branch: branchId,
        customer: c._id,
        accountType: i % 5 === 0 ? "current" : "savings",
        accountName: `${name} — ${i % 5 === 0 ? "Current" : "Savings"}`,
        accountNumber: `2151${String(1000000 + i * 3571).slice(0, 7)}`,
        productCode: i % 5 === 0 ? "CUR-STD" : "SAV-STD",
        currency: "BDT",
        bsb: "",
        swift: "PRBLBDDH",
        branchCode: "HO-001",
        balance: 350000 + i * 47500,
        availableBalance: 340000 + i * 47500,
        overdraftLimit: i % 5 === 0 ? 100000 : 0,
        dailyLimit: 500000,
        monthlyLimit: 5000000,
        accountHolderName: name,
        accountHolderType: relation.type === "company" ? "company" : "individual",
        accountHolderContact: {
          phone: kyc.contact_details?.phone || "",
          email: kyc.contact_details?.email || "",
          address: [kyc.residential_address?.address, kyc.residential_address?.suburb, kyc.residential_address?.country]
            .filter(Boolean)
            .join(", "),
        },
        linkedCards: [
          {
            cardId: `CARD-${STAMP}-${i}`,
            last4: String(4000 + i).slice(-4),
            brand: i % 3 === 0 ? "Mastercard" : "Visa",
            expiryMonth: 11,
            expiryYear: new Date().getFullYear() + 3,
            issuedAt: openedAt,
            status: "active",
            tokenMasked: `**** **** **** ${String(4000 + i).slice(-4)}`,
            metadata: { issuer: "Prime Bank PLC" },
          },
        ],
        accountStatus: c.sanction ? "suspended" : "active",
        isActive: !c.sanction,
        tags: ["seed", c.amlStatus || "unscreened"],
        flags: [c.isPep ? "pep" : null, c.sanction ? "watchlist" : null].filter(Boolean),
        openedAt,
        closedAt: null,
        lastActivityAt: new Date(),
        metadata: { source: "seedCaseWorkflow" },
        createdBy: author._id,
      });
      accounts += 1;
      bump("accounts");
    }

    // ── CRA ─────────────────────────────────────────────────────────────────
    if (haveCra.has(String(c._id))) continue;

    const payload = buildCraPayload(c, relation, i);
    const result = buildRiskAssessmentFromCustomer(payload);

    let nextReviewDate = null;
    if (result.reviewYears) {
      nextReviewDate = new Date();
      nextReviewDate.setFullYear(nextReviewDate.getFullYear() + result.reviewYears);
    }
    const ecddRequired = !!result.ecddRequired;

    const saved = await persist(IndividualRiskAssessment, {
      uid: uid("CRA"),
      client: clientId,
      branch: branchId,
      customer: c._id,
      customerUid: c.uid,
      customerName: name,
      inputSnapshot: payload,
      assessment: result.riskAssessment,
      riskScore: result.riskScore,
      riskLabel: result.riskLabel,
      entityType: CRA_ENTITY_TYPE,
      overrides: result.overrides || [],
      serviceBlocked: !!result.serviceBlocked,
      ecddRequired,
      cddGate: ecddRequired,
      ecddStatus: ecddRequired ? "Pending" : "",
      ecddDecision: "",
      ecddDecidedBy: null,
      ecddDecidedAt: null,
      ecddReviewDate: ecddRequired ? new Date(Date.now() + days(30)) : null,
      ecddReport: null,
      nextReviewDate,
      relationSummary: {
        maxScore: result.riskScore,
        averageScore: result.riskScore,
        highestLabel: result.riskLabel,
      },
      assessedAt: new Date(),
      assessedBy: author._id,
      source: "seed",
      version: 2, // CRA V2 scoring scale, same as the controller writes
      notes: `Customer risk assessment for ${name} under ${CRA_ENTITY_TYPE}.`,
    });

    // Section 4 — every CRA creation is an audit event.
    if (!DRY_RUN) {
      await logCraEvent({
        req: { user: { _id: author._id, name: author.name || "seed", role: "system" } },
        assessment: saved,
        action: "CRA_CREATED",
        after: {
          riskScore: saved.riskScore,
          riskLabel: saved.riskLabel,
          ecddRequired: saved.ecddRequired,
          cddGate: saved.cddGate,
          nextReviewDate: saved.nextReviewDate,
          overrides: saved.overrides,
        },
        target: name,
      });
    }

    bands[result.riskLabel] = (bands[result.riskLabel] || 0) + 1;
    cras += 1;
    bump("cra");
  }

  console.log(
    `  Accounts/CRA: ${accounts} account(s), ${cras} assessment(s) — bands ` +
      (Object.entries(bands).map(([k, v]) => `${k}:${v}`).join(" ") || "none") +
      (DRY_RUN ? " (dry run — nothing written)" : "")
  );
}

/**
 * Removes the synthetic customers created by --make-customers for one client,
 * together with every document that hangs off them.
 *
 * Deliberately keyed on the customer _ids rather than the SEED uid: chains
 * built on REAL customers (--attach-customers) carry SEED uids too, and a uid
 * sweep would delete those as well. Walking outwards from the synthetic
 * customers is the only way to scope the removal correctly.
 *
 * Real customers are never deleted — only the relations[] entry this script
 * added for the client is pulled, by cleanSeedData.
 */
async function dropSyntheticCustomers(clientId) {
  const synthetic = await Customer.find({
    uid: /^CR_SEED/,
    "relations.client": clientId,
  })
    .select("_id uid")
    .lean();

  if (!synthetic.length) {
    console.log("\n  No synthetic customers found for this client.");
    return;
  }

  const ids = synthetic.map((c) => c._id);
  console.log(`\n  Removing ${synthetic.length} synthetic customer(s) and their chains…`);

  // Cases first — CaseNote and AuditLog are reachable only through them.
  const cases = await Case.find({ linkedCustomers: { $in: ids } }).select("_id").lean();
  const caseIds = cases.map((c) => c._id);

  const drops = [
    ["CaseNote", CaseNote, { case: { $in: caseIds } }],
    ["AuditLog", AuditLog, { case: { $in: caseIds } }],
    ["OnboardingJourney", OnboardingJourney, { customer: { $in: ids } }],
    ["AmlMatch", AmlMatch, { customer: { $in: ids } }],
    ["EcddReport", EcddReport, { customer: { $in: ids } }],
    ["SMR", SMR, { customer: { $in: ids } }],
    ["TTR", TTR, { customer: { $in: ids } }],
    ["IFTI", IFTI, { customer: { $in: ids } }],
    ["GFS", GFS, { customer: { $in: ids } }],
    ["RFI", RFI, { customer: { $in: ids } }],
    ["Case", Case, { _id: { $in: caseIds } }],
    ["Alert", Alert, { customer: { $in: ids } }],
    // Transaction has no top-level customer — the link is on the party.
    ["Transaction", Transaction, { "sender.customer": { $in: ids } }],
    ["CustomerAccount", CustomerAccount, { customer: { $in: ids } }],
    ["CRA", IndividualRiskAssessment, { customer: { $in: ids } }],
    ["Customer", Customer, { _id: { $in: ids } }],
  ];

  for (const [name, Model, filter] of drops) {
    if (DRY_RUN) {
      console.log(`    · ${name.padEnd(16)} ${await Model.countDocuments(filter)} would be removed`);
      continue;
    }
    const { deletedCount } = await Model.deleteMany(filter);
    if (deletedCount) console.log(`    − ${name.padEnd(16)} ${deletedCount} removed`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Single write path for every document the seeder creates.
 *
 * Always validates first, so a cast/enum/required failure is reported against
 * the model that caused it. Under --dry-run the validated instance is returned
 * without saving — it still carries a generated _id, so the rest of the chain
 * (alert → case → reports) links up and gets validated too.
 */
const persist = async (Model, doc) => {
  const instance = new Model(doc);
  try {
    // Awaited rather than validateSync() so async validators (the unique-index
    // check added by mongoose-unique-validator) finish before we disconnect,
    // and so duplicate uids are caught too.
    await instance.validate();
  } catch (err) {
    err.message = `${Model.modelName}: ${err.message}`;
    throw err;
  }
  return DRY_RUN ? instance : Model.create(doc);
};

const displayName = (customer) => {
  const kyc = customer.personalKyc?.personal_form?.customer_details || {};
  const fromKyc = [kyc.given_name, kyc.surname].filter(Boolean).join(" ");
  return customer.user?.name || fromKyc || `Customer ${customer.uid || customer._id}`;
};

const days = (n) => n * 24 * 60 * 60 * 1000;
const iso = (d) => new Date(d);

// TTR's AddressSchema keys the street as `fullStreetAddress`…
const address = () => ({
  fullStreetAddress: "Level 12, 120 Collins Street",
  city: "Melbourne",
  state: "VIC",
  postcode: "3000",
  country: "Australia",
});

// …while SMR's uses `street`. Passing the wrong one is not an error — Mongoose
// drops the unknown key in strict mode and leaves the address blank — so the
// two shapes are kept separate deliberately.
const smrAddress = () => ({
  street: "Level 12, 120 Collins Street",
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
    offence: "Money laundering", likelyOffence: ["Money laundering"], suspicionType: "Structuring",
  },
  {
    txnType: "deposit", txnStatus: "completed", currency: "AUD",
    channel: "branch-counter", subtype: "cash", amount: 48000,
    riskScore: 55, riskFlags: ["cash-intensive"],
    narrative: "Large cash deposit inconsistent with stated occupation.",
    alertRisk: 55, alertLabel: "Medium", priority: "medium",
    caseStatus: "open", caseType: "AML", slaStatus: "on_time",
    ruleId: "RULE-CSH-021", ruleName: "Cash deposit inconsistent with customer profile",
    offence: "Proceeds of crime", likelyOffence: ["Proceeds of crime"], suspicionType: "Unusual cash activity",
  },
  {
    txnType: "transfer", txnStatus: "pending", currency: "USD",
    channel: "swift", subtype: "wire", amount: 265000,
    riskScore: 91, riskFlags: ["high-risk-jurisdiction", "rapid-movement"],
    narrative: "Outbound wire to a high-risk jurisdiction shortly after deposit.",
    alertRisk: 91, alertLabel: "Critical", priority: "high",
    caseStatus: "escalated", caseType: "TF", slaStatus: "at_risk",
    ruleId: "RULE-JUR-007", ruleName: "Funds transfer to high-risk jurisdiction",
    offence: "Terrorism financing", likelyOffence: ["Financing of terrorism"], suspicionType: "High-risk jurisdiction exposure",
  },
  {
    txnType: "withdrawal", txnStatus: "completed", currency: "AUD",
    channel: "atm", subtype: "cash", amount: 9500,
    riskScore: 42, riskFlags: ["threshold-avoidance"],
    narrative: "Repeated ATM withdrawals just under the reporting threshold.",
    alertRisk: 42, alertLabel: "Medium", priority: "low",
    caseStatus: "pending_review", caseType: "Fraud", slaStatus: "on_time",
    ruleId: "RULE-STR-002", ruleName: "Repeated sub-threshold ATM withdrawals",
    offence: "Fraud", likelyOffence: ["Offence against a Commonwealth, State or Territory law"], suspicionType: "Threshold avoidance",
  },
  {
    txnType: "exchange", txnStatus: "failed", currency: "EUR",
    channel: "online-banking", subtype: "fx", amount: 74000,
    riskScore: 66, riskFlags: ["rapid-movement"],
    narrative: "Currency exchange followed by immediate onward transfer.",
    alertRisk: 66, alertLabel: "High", priority: "medium",
    caseStatus: "under_investigation", caseType: "AML", slaStatus: "breached",
    ruleId: "RULE-LAY-033", ruleName: "Layering via rapid currency conversion",
    offence: "Money laundering", likelyOffence: ["Money laundering"], suspicionType: "Layering",
  },
  {
    txnType: "transfer", txnStatus: "cancelled", currency: "AUD",
    channel: "mobile-app", subtype: "p2p", amount: 18500,
    riskScore: 31, riskFlags: [],
    narrative: "Peer transfers reviewed and found consistent with the profile.",
    alertRisk: 31, alertLabel: "Low", priority: "low",
    caseStatus: "closed", caseType: "Compliance", slaStatus: "on_time",
    ruleId: "RULE-P2P-054", ruleName: "Elevated peer-to-peer transfer velocity",
    offence: "None identified", likelyOffence: [], suspicionType: "Transfer velocity",
    // Closure fields — only meaningful for a closed case.
    decision: "false_positive",
    closureReason: "Activity substantiated by payroll and rental records.",
  },
];

/**
 * Maps the monitoring engine's internal risk flags onto the AUSTRAC Part A
 * suspicion-reason labels the SMR form offers.
 *
 * The flags are engine vocabulary ("rapid-movement"); Part A is a fixed
 * checklist, so an unmapped flag renders as an unticked box and the reason
 * effectively disappears from the lodged report. Anything without a mapping
 * falls back to the closest general option rather than being written through
 * raw. Keep in step with ui/components/smr-parts/options.js.
 */
const SMR_REASON_BY_FLAG = {
  structuring: "Avoiding reporting obligations",
  "threshold-avoidance": "Avoiding reporting obligations",
  "high-value": "Unusually large transfer",
  "cash-intensive": "Unusual use/exchange of cash",
  "high-risk-jurisdiction": "Country/jurisdiction risk",
  "rapid-movement": "Unusual account activity",
};

const SMR_SUSPICION_REASONS = (flags = []) => {
  const mapped = flags
    .map((f) => SMR_REASON_BY_FLAG[f])
    .filter(Boolean);
  // De-duplicated: two flags can map to the same statutory reason.
  const unique = Array.from(new Set(mapped));
  return unique.length ? unique : ["Inconsistent with customer profile"];
};

/**
 * TTR has the strictest schema of the six — build its required parts in full.
 * Its metadata block is a closed sub-schema with no free-text slot, so the
 * report narrative goes in partA[].transactionConductDescription, which is the
 * only path on the model that takes prose.
 */
const buildTtrParts = (name, amount, reference, when, narrative) => ({
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
      transactionConductDescription:
        `Conducted in person at the branch counter. ${narrative || ""}`.trim(),
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

// ── AI narratives ────────────────────────────────────────────────────────────

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const money = (n) => `$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Pull the profile fields the narratives quote out of a Customer document. */
const profileOf = (customer) => {
  const form = customer.personalKyc?.personal_form || {};
  const res = form.residential_address || {};
  return {
    email: form.contact_details?.email || "customer@example.com",
    phone: form.contact_details?.phone || "+61 400 000 000",
    occupation: form.employment_details?.occupation || "Not stated",
    industry: form.employment_details?.industry || "Not stated",
    employer: form.employment_details?.employer_name || "Not stated",
    country: customer.country || res.country || "Australia",
    city: res.suburb || "Melbourne",
    dob: form.customer_details?.date_of_birth || null,
    sourceOfFunds: customer.personalKyc?.funds_wealth?.source_of_funds || "Not stated",
    sourceOfWealth: customer.personalKyc?.funds_wealth?.source_of_wealth || "Not stated",
    accountPurpose: customer.personalKyc?.funds_wealth?.account_purpose || "Not stated",
    volume: customer.personalKyc?.funds_wealth?.estimated_trading_volume || "Not stated",
    isPep: !!customer.isPep,
    sanction: !!customer.sanction,
  };
};

/**
 * Single source for every long-form field in the chain.
 *
 * The models each expose their own narrative slot — EcddReport.profileSummary /
 * transactionAnalysis / behavioralAnalysis / recommendation, SMR
 * partB.groundsForSuspicion, GFS.suspicionReason, IFTI.generatedReport, the RFI
 * body — and they are all written from one place so a single case reads as one
 * coherent analysis instead of six unrelated paragraphs. The same blocks are
 * mirrored onto Alert.metadata (ecddReport / smrReport / rfiReport / gfsReport),
 * which is the shape the ECDD/SMR/RFI/GFS API seeders produce and the UI reads.
 */
const buildNarratives = (ctx) => {
  const { name, customer, p, v, amount, currency, reference, when, onboardedAt, caseNumber } = ctx;

  const aud = currency === "AUD" ? amount : Math.round(amount * 1.52);
  const deposits = aud;
  const withdrawnAud = Math.round(aud * 0.78 * 100) / 100;
  const usdt = Math.round(aud * 0.42 * 100) / 100;
  const eth = Math.round(aud * 0.00042 * 10000) / 10000;
  const btc = Math.round(aud * 0.0000092 * 100000) / 100000;
  const suspicionAmount = Math.round(aud * 0.48 * 100) / 100;
  const uidStr = String(customer._id);
  const flags = v.riskFlags.length ? v.riskFlags.join(", ") : "no automated risk flags";
  const period = `${ymd(onboardedAt)} to ${ymd(when)}`;

  const pepLine = p.isPep
    ? "The customer is a recorded politically exposed person, which mandates enhanced due diligence and senior-management approval to continue the relationship."
    : "The customer is not recorded as a politically exposed person.";
  const sanctionLine = p.sanction
    ? "A positive sanctions screening match is recorded against this customer and service delivery is blocked pending resolution."
    : "No sanctions screening match is recorded against this customer.";

  const profileSummary =
    `The customer **${name}** (UID: **${uidStr}**) was onboarded on **${ymd(onboardedAt)}** through the ` +
    `**${p.channel || "Website"}** channel and is recorded as a **${p.occupation}** in the **${p.industry}** sector, ` +
    `employed by **${p.employer}**. The stated account purpose at onboarding was **${p.accountPurpose}**, with an ` +
    `expected turnover of **${p.volume}**. Declared source of funds is **${p.sourceOfFunds}** and source of wealth is ` +
    `**${p.sourceOfWealth}**. The customer is resident in **${p.country}**. ${pepLine} ${sanctionLine} ` +
    `An open-source media search returned ${p.isPep || p.sanction ? "material requiring analyst review" : "no adverse findings"}.`;

  const transactionAnalysis =
    `Between ${period} the account recorded AUD deposits of ${money(deposits)} against AUD withdrawals of ` +
    `${money(withdrawnAud)}, alongside digital-asset outflows of ${usdt} USDT, ${eth} ETH and ${btc} BTC. ` +
    `The reviewed transaction ${reference} is a **${v.txnType}** of ${money(amount)} ${currency} via **${v.channel}**, ` +
    `settled as **${v.txnStatus}**. ${v.narrative} The monitoring engine attached the following indicators: ${flags}. ` +
    `The ratio of outflow to inflow (${Math.round((withdrawnAud / Math.max(deposits, 1)) * 100)}%) combined with the ` +
    `short holding period is consistent with **${v.suspicionType.toLowerCase()}**: value enters the account and is ` +
    `moved onward before it settles into any recognisable savings or trading pattern. The volume observed materially ` +
    `exceeds the turnover stated at onboarding (${p.volume}), and no supporting commercial rationale has been provided ` +
    `by the customer to date.`;

  const behavioralAnalysis =
    `${name}'s activity diverges from the profile established at onboarding. The stated purpose was ` +
    `**${p.accountPurpose}**, yet the observed pattern is dominated by ${v.txnType} activity through the ` +
    `**${v.channel}** channel with counterparties outside the customer's declared business footprint. Transaction ` +
    `timing clusters outside normal business hours and originates from a small number of devices and IP ranges, ` +
    `three of which resolve to different jurisdictions within the review window. ${pepLine} The behavioural shift is ` +
    `recent — the preceding twelve months show no comparable activity — which raises the possibility of third-party ` +
    `control of the account or a change in the underlying source of funds that has not been disclosed.`;

  const recommendation =
    `Given the patterns observed for **${name}** (UID: **${uidStr}**) — ${v.narrative.replace(/\.$/, "")}, indicators ` +
    `of ${flags}, and turnover materially above the declared expectation — classify as **${v.alertLabel} Risk**. ` +
    `Immediate actions: apply enhanced ongoing monitoring for six months, obtain documentary source-of-funds and ` +
    `source-of-wealth evidence, and review all counterparties associated with ${reference}. ` +
    `${v.alertLabel === "Critical" || v.alertLabel === "High"
      ? `Suspend outbound transfers pending review, escalate to the AML/CTF Compliance Officer for a suspicious matter report decision under s41 of the AML/CTF Act, and notify senior management.`
      : `Retain the relationship under monitoring; no restriction on services is warranted on the present evidence.`}`;

  const depositDetails =
    `Total deposits of ${money(deposits)} AUD across the review period, received via ${v.channel} ` +
    `(${v.subtype}). The largest single credit was ${money(Math.round(deposits * 0.34 * 100) / 100)}; ` +
    `six further credits fell between ${money(8400)} and ${money(9800)}, each below the ${money(10000)} ` +
    `threshold reporting obligation.`;

  const withdrawalDetails =
    `Withdrawals summary:\n- AUD: ${money(withdrawnAud)} to external accounts.\n- USDT: ${usdt} to unhosted wallets.` +
    `\n- ETH: ${eth} to unhosted wallets.\n- BTC: ${btc} to a cluster previously associated with mixer activity.`;

  const groundsForSuspicion =
    `The reporting entity holds a suspicion on reasonable grounds that the activity of ${name} in relation to ` +
    `${reference} may be connected with **${v.offence.toLowerCase()}**. ${transactionAnalysis} ` +
    `The customer was asked to explain the source of the funds and has not provided evidence within the requested ` +
    `period. On the information available, the reporting entity is unable to satisfy itself that the transactions ` +
    `have a legitimate commercial purpose.`;

  const smrNarrative =
    `This matter is reported under s41 of the AML/CTF Act 2006. ${name} conducted a ${v.txnType} of ` +
    `${money(amount)} ${currency} (reference ${reference}) on ${ymd(when)} through the ${v.channel} channel. ` +
    `The transaction is one of a series exhibiting ${v.suspicionType.toLowerCase()}. Neither party is a sanctions ` +
    `match${p.isPep ? ", though the customer is a recorded politically exposed person" : ""}, but the absence of a ` +
    `screening hit does not displace the suspicion: the pattern itself — rapid inflow, immediate onward movement, and ` +
    `counterparties with no evident relationship to the customer's stated occupation as a ${p.occupation} — is the ` +
    `basis of this report. The reporting entity has been unable to establish a legitimate purpose for the transfers ` +
    `and considers that the funds may represent proceeds of an indictable offence. Further investigation by AUSTRAC ` +
    `is warranted to establish the ultimate beneficiary of the outbound value.`;

  const gfsSuspicionSummary =
    `Over the review period ${period} the account received ${money(deposits)} and released ${money(withdrawnAud)}, ` +
    `of which ${money(suspicionAmount)} is assessed as suspicious. The stated source of funds ` +
    `(${p.sourceOfFunds}) does not account for the observed turnover, and the account holds no balance ` +
    `consistent with an investment or savings purpose. The pattern — high pass-through, low residual balance and ` +
    `counterparties in ${p.country === "Australia" ? "a single jurisdiction with no commercial connection to the customer" : `a higher-risk jurisdiction (${p.country})`} — ` +
    `supports a finding of ${v.suspicionType.toLowerCase()}. Escalation to a suspicious matter report is recommended.`;

  const rfiItems = [
    `Please provide documentary evidence of the source of the funds credited to your account between ${period} (for example recent payslips, a contract of sale, or a bank statement showing the origin of the funds).`,
    `Please clarify the commercial purpose of transaction ${reference} for ${money(amount)} ${currency} and your relationship with the counterparty.`,
    `Please provide supporting invoices, contracts or shipping documentation for the international transfer.`,
    `Please confirm your current occupation and employer, and provide evidence of income where this differs from the details held (${p.occupation}, ${p.employer}).`,
    `Please provide documentation confirming your residential address (for example a utility bill dated within the last three months).`,
  ];

  const responseBy = new Date(new Date(when).getTime() + days(14));
  const rfiBody =
    `Hi ${name.split(" ")[0]},\n\n` +
    `As part of our standard review for ${name} (UID ${uidStr}, case ${caseNumber}), please provide the ` +
    `information below within 14 calendar days (by ${ymd(responseBy)}):\n\n` +
    rfiItems.map((t) => `• ${t}`).join("\n") +
    `\n\nYou can reply to compliance@example.com with documents or clarifications. If an item is unavailable, ` +
    `please note the reason and an expected date.\n\nKind regards,\nCompliance Team`;

  const iftiNarrative =
    `International funds transfer instruction ${reference} was accepted on ${ymd(when)} for ${money(amount)} ` +
    `${currency}. The ordering customer is ${name} (${p.country}); the beneficiary is Meridian Trade Solutions GmbH ` +
    `(Germany), with JP Morgan Chase Bank NA acting as intermediary. The stated reason for the transfer is supplier ` +
    `payment for imported goods. The instruction is reported under s45 of the AML/CTF Act. It is also the subject of ` +
    `case ${caseNumber}: the value transferred is not supported by the customer's declared turnover and the ` +
    `beneficiary has no established trading history with the customer.`;

  const ttrNarrative =
    `Threshold transaction report for ${money(amount)} ${currency} conducted by ${name} on ${ymd(when)} at the ` +
    `${v.channel} channel, reportable under s43 of the AML/CTF Act as a cash transaction at or above the ` +
    `${money(10000)} threshold. The transaction forms part of the activity examined under case ${caseNumber}.`;

  const alertExplanation =
    `${v.ruleName} fired on ${reference}. ${v.narrative} Observed indicators: ${flags}. Transaction value ` +
    `${money(amount)} ${currency} against a declared expectation of ${p.volume}, giving a model score of ` +
    `${v.alertRisk}/100 (${v.alertLabel}).`;

  const caseDescription =
    `Investigation into ${v.suspicionType.toLowerCase()} by ${name} (${uidStr}). ${v.narrative} ` +
    `Review period ${period}; ${money(deposits)} in, ${money(withdrawnAud)} out, ${money(suspicionAmount)} ` +
    `assessed as suspicious. Trigger: ${v.ruleName} (${v.ruleId}).`;

  return {
    figures: { aud, deposits, withdrawnAud, usdt, eth, btc, suspicionAmount },
    profileSummary, transactionAnalysis, behavioralAnalysis, recommendation,
    depositDetails, withdrawalDetails, groundsForSuspicion, smrNarrative,
    gfsSuspicionSummary, rfiItems, rfiBody, iftiNarrative, ttrNarrative,
    alertExplanation, caseDescription,
    additionalInfo:
      `Source-of-funds evidence requested from the customer on ${ymd(when)}; no response received at the time of ` +
      `writing. Device and IP telemetry retained. All figures in this report are derived from platform data for the ` +
      `period ${period} and have not been independently verified against external records.`,
  };
};

/**
 * The AI report bundle written to Alert.metadata. Mirrors the payload shape the
 * ECDD / SMR / RFI / GFS API seeders store, so the alert detail view renders the
 * same sections whether the data came from the model or from this seeder.
 */
const buildAlertReports = (ctx, n) => {
  const { name, customer, p, v, amount, currency, reference, when, onboardedAt, caseNumber } = ctx;
  const f = n.figures;
  const uidStr = String(customer._id);

  return {
    source: "ECDD_API",
    fetchedAt: when,
    ecddReport: {
      analyst_name: "Dooit analyst",
      position: "AML/CTF Compliance Officer",
      analysis_date: when,
      account_creation_date: onboardedAt,
      analysis_end_date: when,
      onboarding_date: onboardedAt,
      user_id: uidStr,
      name,
      email: p.email,
      account_purpose: p.accountPurpose,
      Expected_Trading_Volume: p.volume,
      annual_income: 180000,
      beneficial_owner: name,
      director_name: name,
      company_name: p.employer,
      abn: "51 824 753 556",
      pep_flag: p.isPep,
      sanction_flag: p.sanction,
      ip_address: "203.0.113.45",
      ip_geolocation: p.country,
      total_deposits_AUD: f.deposits,
      total_withdrawals_AUD: f.withdrawnAud,
      total_withdrawals_USDT: f.usdt,
      total_withdrawals_ETH: f.eth,
      total_withdrawals_BTC: f.btc,
      profile_summary: n.profileSummary,
      transaction_analysis: n.transactionAnalysis,
      behavioral_analysis: n.behavioralAnalysis,
      recommendation_type: v.caseType === "Compliance" ? "MONITOR" : "SMR",
      recommendation: n.recommendation,
      additional_information: n.additionalInfo,
      deposit_details: n.depositDetails,
      withdrawal_details: n.withdrawalDetails,
    },
    smrGeneratedAt: when,
    smrReport: {
      smr_id: `SMR_${caseNumber}_${ymd(when).replace(/-/g, "")}`,
      uid: caseNumber,
      report_date: ymd(when),
      name,
      dob: p.dob ? ymd(p.dob) : null,
      country_of_citizenship: p.country,
      contact_details: { residential_address: `${p.city}, ${p.country}`, mailing_address: `${p.city}, ${p.country}` },
      phone_numbers: [p.phone],
      email_address: p.email,
      occupation: p.occupation,
      transaction_details: {
        date_of_transaction: ymd(when),
        transaction_type: v.txnType,
        transaction_subtype: v.subtype,
        transaction_reference_number: reference,
        total_amount: amount,
        total_amount_aud: f.aud,
        currency,
        total_cash_involved: Math.round(amount / 2),
      },
      parties: {
        sender: { name, account: "AU-7842-0012-3345", institution: "Commonwealth Bank of Australia", country: p.country },
        beneficiary: { name: "Meridian Trade Solutions GmbH", account: "DE89370400440532013000", institution: "Deutsche Bank AG", country: "Germany" },
        drawer: name,
        issuer: "Commonwealth Bank of Australia",
        payee: "Meridian Trade Solutions GmbH",
      },
      suspicious_indicators: {
        linked_to_smr: true,
        suspicious_flag: true,
        pep_flag: p.isPep,
        sanctions_match: p.sanction,
      },
      narrative: n.smrNarrative,
      investigation_notes: "Under investigation",
      status: "Under Review",
    },
    rfiGeneratedAt: when,
    rfiReport: {
      rfi_id: `RFI_${caseNumber}_${ymd(when).replace(/-/g, "")}`,
      uid: caseNumber,
      case_number: caseNumber,
      customer_name: name,
      customer_uid: uidStr,
      customer_email: p.email,
      primary_contact_name: name,
      response_deadline: ymd(new Date(new Date(when).getTime() + days(14))),
      requested_items: n.rfiItems,
      reply_to_email: "compliance@example.com",
      client_name: "Dooit Financial Services Pty Ltd",
      created_date: ymd(when),
      Subject: `Request for information – ${caseNumber} (${name})`,
      body: n.rfiBody,
    },
    gfsGeneratedAt: when,
    gfsReport: {
      gfs_id: `GFS_${caseNumber}_${ymd(when).replace(/-/g, "")}`,
      uid: caseNumber,
      customerName: name,
      customerUID: uidStr,
      companyName: p.employer,
      customerAge: p.dob ? Math.floor((Date.now() - new Date(p.dob).getTime()) / days(365)) : null,
      accountOpeningDate: ymd(onboardedAt),
      sourceOfFunds: p.sourceOfFunds,
      sourceOfWealth: p.sourceOfWealth,
      accountOpeningPurpose: p.accountPurpose,
      reviewStartDate: ymd(onboardedAt),
      reviewEndDate: ymd(when),
      totalDeposited: f.deposits,
      totalWithdrawn: f.withdrawnAud,
      totalSuspicionAmount: f.suspicionAmount,
      transactions: [
        {
          tx_id: reference,
          date: ymd(when),
          type: v.txnType,
          subtype: v.subtype,
          amount,
          currency,
          status: v.txnStatus,
          counterparty: "Meridian Trade Solutions GmbH",
        },
      ],
      ofis: [{ institution_name: "Deutsche Bank AG", country: "Germany", bic: "DEUTDEDB" }],
      pois: [{ name: "Meridian Trade Solutions GmbH", relationship: "Counterparty", country: "Germany" }],
      cryptoAddresses: ["bc1qseeddemowallet00000000000000000000"],
      ipAddresses: [{ ip: "203.0.113.45", geolocation: p.country, risk_category: v.alertLabel }],
      customerCountry: p.country,
      riskRating: v.alertLabel,
      pepFlag: p.isPep,
      sanctionsFlag: p.sanction,
      linkedToSMR: true,
      behavioralChange: true,
      suspicionSummary: n.gfsSuspicionSummary,
    },
    // Only the resolved variant carries a dismissal rationale — an open case has
    // nothing to dismiss.
    ...(v.decision === "false_positive"
      ? {
          dismissalGeneratedAt: when,
          dismissalReport: {
            dismissal_type: "fi_d1",
            customer_industry: p.industry,
            narrative:
              `The activity of ${name} was reviewed against the customer's declared profile as a ${p.occupation} ` +
              `in the ${p.industry} sector. Payroll credits, rental statements and the counterparty relationship ` +
              `were verified and reconcile to the observed flows. The pattern that triggered ${v.ruleId} is ` +
              `explained by regular income and a scheduled property settlement, both consistent with the source of ` +
              `funds declared at onboarding. No further action is warranted and the alert is closed as a false ` +
              `positive. The customer remains under standard ongoing monitoring.`,
            generatedAt: when,
          },
        }
      : {}),
  };
};

// ── Customer provisioning (--make-customers) ─────────────────────────────────

/**
 * Profile pool for created customers. Spread across KYC states, screening
 * outcomes, occupations and jurisdictions so the customer list, the risk
 * filters and the CRA views all have a range to show rather than N identical
 * rows. Cycled when --make-customers exceeds the pool size.
 */
const CUSTOMER_PROFILES = [
  {
    given: "Rezaul", middle: "Ahmed", surname: "Karim", ageYears: 41,
    occupation: "Company Director", industry: "Import / Export",
    employer: "Apex Capital Holdings Pty Ltd",
    city: "Melbourne", state: "VIC", postcode: "3000", country: "Australia",
    channel: "In-Branch", kycStatus: "verified", amlStatus: "clear",
    amlLabels: [], isPep: false, sanction: false,
    riskScore: 34, riskLabel: "Low",
    sourceOfFunds: "Business income", sourceOfWealth: "Company dividends",
    accountPurpose: "Business trade settlement", volume: "AUD 50,000 – 100,000 / month",
  },
  {
    given: "Sadia", middle: "", surname: "Rahman", ageYears: 34,
    occupation: "Property Investor", industry: "Real Estate",
    employer: "Self-employed",
    city: "Sydney", state: "NSW", postcode: "2000", country: "Australia",
    channel: "Website", kycStatus: "verified", amlStatus: "clear",
    amlLabels: [], isPep: false, sanction: false,
    riskScore: 52, riskLabel: "Medium",
    sourceOfFunds: "Rental income", sourceOfWealth: "Property portfolio",
    accountPurpose: "Personal investment", volume: "AUD 100,000 – 250,000 / month",
  },
  {
    given: "Michael", middle: "Wei", surname: "Chen", ageYears: 57,
    occupation: "Former Government Minister", industry: "Public Administration",
    employer: "Retired",
    city: "Canberra", state: "ACT", postcode: "2600", country: "Australia",
    channel: "Agent", kycStatus: "in_review", amlStatus: "flagged",
    amlLabels: ["pep"], isPep: true, sanction: false,
    riskScore: 81, riskLabel: "High",
    sourceOfFunds: "Pension and consultancy fees", sourceOfWealth: "Public office and speaking engagements",
    accountPurpose: "Personal banking", volume: "AUD 25,000 – 50,000 / month",
  },
  {
    given: "Fatima", middle: "", surname: "Al-Sayed", ageYears: 38,
    occupation: "Precious Metals Trader", industry: "Bullion Dealing",
    employer: "Gulf Bullion Trading LLC",
    city: "Dubai", state: "Dubai", postcode: "00000", country: "United Arab Emirates",
    channel: "Mobile App", kycStatus: "verified", amlStatus: "yellow",
    amlLabels: ["adverseMedia"], isPep: false, sanction: false,
    riskScore: 76, riskLabel: "High",
    sourceOfFunds: "Bullion trading proceeds", sourceOfWealth: "Family trading business",
    accountPurpose: "Cross-border settlement", volume: "AUD 250,000 – 500,000 / month",
  },
  {
    given: "James", middle: "Patrick", surname: "O'Connor", ageYears: 46,
    occupation: "Logistics Contractor", industry: "Freight & Logistics",
    employer: "Sigma Logistics BV",
    city: "Brisbane", state: "QLD", postcode: "4000", country: "Australia",
    channel: "Website", kycStatus: "rejected", amlStatus: "flagged",
    amlLabels: ["sanctions", "adverseMedia"], isPep: false, sanction: true,
    riskScore: 94, riskLabel: "Critical",
    sourceOfFunds: "Contract payments", sourceOfWealth: "Unverified",
    accountPurpose: "Freight settlement", volume: "AUD 500,000+ / month",
  },
  {
    given: "Priya", middle: "", surname: "Nair", ageYears: 29,
    occupation: "Software Engineer", industry: "Technology",
    employer: "Northbridge Digital Pty Ltd",
    city: "Perth", state: "WA", postcode: "6000", country: "Australia",
    channel: "Mobile App", kycStatus: "pending", amlStatus: "pending",
    amlLabels: [], isPep: false, sanction: false,
    riskScore: 41, riskLabel: "Medium",
    sourceOfFunds: "Salary", sourceOfWealth: "Employment income",
    accountPurpose: "Personal remittance", volume: "AUD 5,000 – 25,000 / month",
  },
  {
    given: "Tanvir", middle: "", surname: "Hossain", ageYears: 36,
    occupation: "Restaurant Owner", industry: "Hospitality",
    employer: "Riverside Dining Group",
    city: "Adelaide", state: "SA", postcode: "5000", country: "Australia",
    channel: "In-Branch", kycStatus: "verified", amlStatus: "clear",
    amlLabels: [], isPep: false, sanction: false,
    riskScore: 63, riskLabel: "Medium",
    sourceOfFunds: "Cash takings", sourceOfWealth: "Hospitality business",
    accountPurpose: "Business deposits", volume: "AUD 50,000 – 100,000 / month",
  },
  {
    given: "Emma", middle: "Louise", surname: "Whitfield", ageYears: 51,
    occupation: "Chartered Accountant", industry: "Professional Services",
    employer: "Whitfield & Associates",
    city: "Hobart", state: "TAS", postcode: "7000", country: "Australia",
    channel: "Website", kycStatus: "verified", amlStatus: "clear",
    amlLabels: [], isPep: false, sanction: false,
    riskScore: 22, riskLabel: "Low",
    sourceOfFunds: "Professional fees", sourceOfWealth: "Practice earnings",
    accountPurpose: "Personal banking", volume: "AUD 5,000 – 25,000 / month",
  },
];

/**
 * Branch for the seeded customers to hang off. Reused when the tenant already
 * has one — Branch.name carries a global unique index, so creating a second
 * "<client> — Head Office" would be rejected rather than silently duplicated.
 */
async function ensureBranch(clientId, clientName) {
  const existing = await Branch.findOne({ client: clientId })
    .select("_id name")
    .lean();
  if (existing) {
    console.log(`  Branch: reusing ${existing.name}`);
    return existing._id;
  }

  const branch = await persist(Branch, {
    uid: uid("BR"),
    client: clientId,
    name: `${clientName} — Head Office`,
    branchCode: "HO-001",
    branchType: "Main",
    swiftCode: "PRBLBDDH",
    email: "headoffice@example.com",
    phone: "+880 2 9567265",
    address: {
      street: "Adamjee Court Annex Building 2, 119-120 Motijheel C/A",
      city: "Dhaka",
      state: "Dhaka",
      country: "Bangladesh",
      zipcode: "1000",
      geo: { type: "Point", coordinates: [90.4152, 23.7276] },
    },
    contacts: [
      { name: "Compliance Officer", title: "Chief Anti-Money Laundering Compliance Officer", email: "compliance@example.com", phone: "+880 2 9567266", primary: true },
    ],
    manager: { name: "Branch Manager", email: "manager@example.com", phone: "+880 2 9567267", employeeId: "EMP-0001" },
    services: ["Deposits", "Withdrawals", "Foreign Exchange", "Inward Remittance", "Trade Finance"],
    hasATM: true,
    atmDetails: { locationDescription: "Ground floor lobby, Motijheel C/A", cashAvailability: true },
    workingHours: {
      sunday: { open: "10:00", close: "18:00", closed: false },
      thursday: { open: "10:00", close: "18:00", closed: false },
      friday: { open: "", close: "", closed: true },
      saturday: { open: "", close: "", closed: true },
    },
    documents: [{ name: "Bangladesh Bank licence", url: "https://example.com/licence.pdf", mimeType: "application/pdf", type: "license" }],
    status: "Active",
    osintStatus: false,
    settings: { timezone: "Asia/Dhaka" },
    metadata: { source: "seedCaseWorkflow" },
  });
  console.log(`  Branch: created ${branch.name}`);
  return branch._id;
}

/**
 * Adds this client to the relations[] of Customers that already exist.
 *
 * A Customer belongs to a tenant through an entry in its own relations[] array,
 * so onboarding an existing customer to another client is a push onto that
 * array — not a new Customer document. Type and onboarding channel are carried
 * over from the customer's existing relation so the new entry describes the
 * same person the same way; everything else is fresh for this tenant.
 *
 * $push rather than load-modify-save: the update is surgical, and a legacy
 * document that no longer satisfies the current schema elsewhere would fail a
 * full save() for reasons that have nothing to do with the relation.
 *
 * @param {number} limit  how many to attach; 0 means every eligible customer
 */
async function attachCustomers(limit, clientId, branchId, author) {
  let query = Customer.find({ "relations.client": { $ne: clientId } })
    .select("_id uid relations personalKyc")
    .sort({ createdAt: 1 });
  if (limit > 0) query = query.limit(limit);

  const pool = await query.lean();
  if (!pool.length) {
    console.log("  Attach: no customers left without a relation to this client");
    return [];
  }

  console.log(`  Attaching this client to ${pool.length} existing customer(s)`);

  for (const c of pool) {
    // Mirror the customer's existing relation so the new entry is consistent
    // with how they are already described.
    const source = c.relations?.[0] || {};
    const type = RELATION_TYPES.includes(source.type) ? source.type : "individual";
    const now = new Date();

    // Carry the original onboarding date rather than stamping today. The CRA
    // scores customerRetention off this, and the copied onboarding journey is
    // dated from the original onboarding — a relation registered today would
    // both contradict that journey and rate a long-standing customer as new.
    const registeredAt = source.registeredAt ? new Date(source.registeredAt) : now;

    const relation = {
      client: clientId,
      branch: branchId,
      type,
      onboardingChannel: source.onboardingChannel || "In-Branch",
      registeredAt,
      source: SEED_RELATION_SOURCE,
      notes: "Existing customer onboarded to this client for demo data.",
      active: true,
      relationModel: "Customer",
      relationId: c._id,
      invitedBy: author._id,
      inviteToken: null,
      inviteTokenExpire: null,
      inviteCreatedAt: now,
    };


    if (!DRY_RUN) {
      // The $ne guard makes a re-run idempotent — a customer already holding a
      // relation to this client is never given a second one.
      await Customer.updateOne(
        { _id: c._id, "relations.client": { $ne: clientId } },
        { $push: { relations: relation } }
      );
    }

    // Kept in memory too, so --dry-run can feed the chain from customers whose
    // relation was never actually written.
    c.relations = [...(c.relations || []), relation];

    bump("attached");
    const kyc = c.personalKyc?.personal_form?.customer_details || {};
    const label = [kyc.given_name, kyc.surname].filter(Boolean).join(" ") || c.uid || String(c._id);
    console.log(`    ↳ ${label.padEnd(28)} ${c.uid || ""}  (${type})`);
  }

  return pool;
}

/**
 * Creates `count` Customers holding a relations[] entry for this client — the
 * tenant link that makes them visible to the client — plus a CustomerAccount
 * and a CRA each. Returns the created documents as plain objects so --dry-run
 * can feed them into the chain without anything having been written.
 */
async function makeCustomers(count, clientId, branchId, author) {
  const created = [];

  for (let i = 0; i < count; i++) {
    const p = CUSTOMER_PROFILES[i % CUSTOMER_PROFILES.length];
    // Second and later passes over the pool get a suffix so cycled rows are
    // still distinguishable in the UI.
    const pass = Math.floor(i / CUSTOMER_PROFILES.length);
    const surname = pass ? `${p.surname}-${pass + 1}` : p.surname;
    const fullName = `${p.given} ${surname}`;
    const email = `${p.given}.${surname}.${STAMP}${i}`.toLowerCase().replace(/[^a-z0-9.]/g, "") + "@example.com";
    const registeredAt = new Date(Date.now() - days(45 + i * 9));
    const dob = new Date(Date.now() - days(365 * p.ageYears));

    // relationId self-references the Customer for individuals, which is what
    // customerController does — so the _id has to exist before the insert.
    const _id = new mongoose.Types.ObjectId();

    const customer = await persist(Customer, {
      _id,
      uid: uid("CR"),
      user: null,
      relations: [
        {
          client: clientId,
          branch: branchId,
          type: "individual",
          onboardingChannel: p.channel,
          registeredAt,
          source: "seed",
          notes: `Seeded ${p.occupation} profile for demo data.`,
          active: true,
          relationModel: "Customer",
          relationId: _id,
          invitedBy: author._id,
          inviteCreatedAt: registeredAt,
        },
      ],
      personalKyc: {
        personal_form: {
          customer_details: {
            given_name: p.given,
            middle_name: p.middle,
            surname,
            date_of_birth: dob,
            other_names: `${p.given[0]}. ${surname}`,
            referral: "Existing customer referral",
          },
          contact_details: { email, phone: `+61 4${String(10000000 + i * 7919).slice(0, 8)}` },
          employment_details: { occupation: p.occupation, industry: p.industry, employer_name: p.employer },
          residential_address: {
            address: `${12 + i} Collins Street`,
            suburb: p.city,
            state: p.state,
            postcode: p.postcode,
            country: p.country,
          },
          mailing_address: {
            address: `PO Box ${400 + i}`,
            suburb: p.city,
            state: p.state,
            postcode: p.postcode,
            country: p.country,
          },
          identificationNo: `PA${1000000 + i * 13}`,
        },
        funds_wealth: {
          source_of_funds: p.sourceOfFunds,
          source_of_wealth: p.sourceOfWealth,
          account_purpose: p.accountPurpose,
          estimated_trading_volume: p.volume,
        },
        sole_trader: {
          is_sole_trader: i % 4 === 0,
          business_details: {
            business_name: p.employer,
            abn: "51 824 753 556",
            business_address: {
              address: "Level 12, 120 Collins Street",
              suburb: p.city,
              state: p.state,
              postcode: p.postcode,
              country: p.country,
            },
          },
        },
      },
      referrer: { name: "Partner Network", code: `REF-${100 + i}` },
      documents: [
        { name: "passport.pdf", url: "https://example.com/passport.pdf", mimeType: "application/pdf", type: "identity", docType: "passport", uploadedAt: registeredAt },
        { name: "utility-bill.pdf", url: "https://example.com/utility-bill.pdf", mimeType: "application/pdf", type: "address", docType: "proof_of_address", uploadedAt: registeredAt },
      ],
      country: p.country,
      kycStatus: p.kycStatus,
      kycNotes: p.kycStatus === "rejected" ? "Identity documents could not be verified." : "Documents received and checked.",
      kycHistory: [
        { status: "pending", note: "Onboarding started.", changedBy: author._id, changedAt: registeredAt },
        { status: p.kycStatus, note: "Automated verification completed.", changedBy: author._id, changedAt: new Date(registeredAt.getTime() + days(2)) },
      ],
      isPep: p.isPep,
      sanction: p.sanction,
      kycVerifiedAt: p.kycStatus === "verified" ? new Date(registeredAt.getTime() + days(2)) : null,
      kycRejectReason: p.kycStatus === "rejected" ? "Document authenticity check failed." : null,
      kycRawResult: { provider: "sumsub", reviewAnswer: p.kycStatus === "verified" ? "GREEN" : "RED" },
      amlStatus: p.amlStatus,
      amlRiskLabels: p.amlLabels,
      amlHits: p.amlLabels.map((label) => ({ label, matchStatus: "potential_match", score: p.riskScore })),
      amlCheckedAt: new Date(registeredAt.getTime() + days(2)),
      amlVendor: "Powered by ComplyAdvantage CSOM",
      consentToScreen: true,
      isActive: true,
      status: "Active",
      offboardedAt: null,
      offboardedBy: null,
      offboardReason: "",
      metadata: { source: "seedCaseWorkflow", profile: p.occupation },
      declaration: {
        declarations_accepted: true,
        signatory_name: fullName,
        signature: `/s/ ${fullName}`,
        date: registeredAt,
      },
      authorized: {
        company_name: p.employer,
        agent_name: fullName,
        title_relationship: "Self",
        agent_signature: `/s/ ${fullName}`,
        agent_date: registeredAt,
        documents_attested: true,
      },
      isDataEncrypted: false,
      osintStatus: false,
      checks: [
        { type: "dvs", provider: "DVS", result: p.kycStatus === "verified" ? "pass" : "review", checkedAt: registeredAt },
      ],
    });

    await persist(CustomerAccount, {
      uid: uid("ACC"),
      client: clientId,
      branch: branchId,
      customer: _id,
      accountType: "savings",
      accountName: `${fullName} — Everyday`,
      accountNumber: `AU-7842-${String(1000 + i).padStart(4, "0")}-3345`,
      productCode: "SAV-STD",
      currency: "AUD",
      iban: "AU89370400440532013000",
      bsb: "063-000",
      swift: "CTBAAU2S",
      branchCode: "HO-001",
      balance: 125000 + i * 4300,
      availableBalance: 120000 + i * 4300,
      overdraftLimit: 5000,
      dailyLimit: 25000,
      monthlyLimit: 250000,
      accountHolderName: fullName,
      accountHolderType: "individual",
      accountHolderContact: {
        phone: `+61 4${String(10000000 + i * 7919).slice(0, 8)}`,
        email,
        address: `${12 + i} Collins Street, ${p.city} ${p.state} ${p.postcode}`,
      },
      linkedCards: [
        {
          cardId: `CARD-${STAMP}-${i}`,
          last4: String(4000 + i).slice(-4),
          brand: "Visa",
          expiryMonth: 11,
          expiryYear: new Date().getFullYear() + 3,
          issuedAt: registeredAt,
          status: "active",
          tokenMasked: `**** **** **** ${String(4000 + i).slice(-4)}`,
          metadata: { issuer: "Dooit" },
        },
      ],
      accountStatus: "active",
      isActive: true,
      tags: ["seed", p.riskLabel.toLowerCase()],
      flags: [p.isPep ? "pep" : null, p.sanction ? "watchlist" : null].filter(Boolean),
      openedAt: registeredAt,
      closedAt: null,
      lastActivityAt: new Date(),
      metadata: { source: "seedCaseWorkflow" },
      createdBy: author._id,
    });

    await persist(IndividualRiskAssessment, {
      uid: uid("CRA"),
      client: clientId,
      branch: branchId,
      customer: _id,
      customerUid: customer.uid,
      customerName: fullName,
      inputSnapshot: {
        customerType: "individual",
        jurisdiction: p.country,
        occupation: p.occupation,
        industry: p.industry,
        pep: p.isPep,
        sanctions: p.sanction,
        channel: p.channel,
        sourceOfFunds: p.sourceOfFunds,
        sourceOfWealth: p.sourceOfWealth,
      },
      assessment: {
        customerType: { value: "individual", score: 10 },
        jurisdiction: { value: p.country, score: p.country === "Australia" ? 10 : 40 },
        customerRetention: { value: "New (<12 months)", score: 20 },
        product: { value: "Remittance", score: 30 },
        channel: { value: p.channel, score: p.channel === "In-Branch" ? 10 : 25 },
        occupation: { value: p.occupation, score: 20 },
        industry: { value: p.industry, score: 25 },
        pepStatus: { value: p.isPep ? "Domestic PEP" : "Not a PEP", score: p.isPep ? 60 : 0 },
        sourceOfFunds: { value: p.sourceOfFunds, score: 15 },
        sourceOfWealth: { value: p.sourceOfWealth, score: 15 },
        adverseMedia: { value: p.amlLabels.includes("adverseMedia") ? "Adverse media found" : "None", score: p.amlLabels.includes("adverseMedia") ? 40 : 0 },
      },
      riskScore: p.riskScore,
      riskLabel: p.riskLabel,
      entityType: "Financial Institution",
      overrides: p.isPep ? ["Domestic PEP — minimum HIGH"] : [],
      serviceBlocked: p.sanction,
      // Section 4 review cadence: Low +3y · Medium +2y · High +1y
      nextReviewDate: new Date(
        registeredAt.getTime() + days(365 * (p.riskLabel === "Low" ? 3 : p.riskLabel === "Medium" ? 2 : 1))
      ),
      relationSummary: { maxScore: p.riskScore, averageScore: p.riskScore, highestLabel: p.riskLabel },
      assessedAt: new Date(registeredAt.getTime() + days(2)),
      assessedBy: author._id,
      source: "onboarding",
      version: 1,
      notes:
        `Customer risk assessment completed at onboarding for ${fullName}, a ${p.occupation} in the ` +
        `${p.industry} sector resident in ${p.country}. The rating of ${p.riskScore}/100 (${p.riskLabel}) is ` +
        `driven primarily by ${p.isPep ? "politically exposed person status, which imposes a minimum HIGH rating regardless of other factors" : p.sanction ? "a positive sanctions screening match, which blocks service delivery pending resolution" : `the ${p.country === "Australia" ? "domestic" : "higher-risk"} jurisdiction exposure and the declared product and channel mix`}. ` +
        `Declared source of funds is ${p.sourceOfFunds} and source of wealth is ${p.sourceOfWealth}; both are ` +
        `consistent with the stated occupation and the expected turnover of ${p.volume}. ` +
        `${["High", "Critical"].includes(p.riskLabel)
          ? "Enhanced customer due diligence is required before service delivery continues, and the CDD gate is engaged pending Compliance Officer approval."
          : "Standard due diligence applies; no enhanced measures are required at this time."} ` +
        `Next scheduled review follows the Section 4 cadence for a ${p.riskLabel} rating.`,
      ecddRequired: ["High", "Critical"].includes(p.riskLabel),
      cddGate: ["High", "Critical"].includes(p.riskLabel),
      ecddStatus: ["High", "Critical"].includes(p.riskLabel) ? "Pending" : "",
      ecddDecision: "",
      ecddDecidedBy: null,
      ecddDecidedAt: null,
      ecddReviewDate: ["High", "Critical"].includes(p.riskLabel)
        ? new Date(registeredAt.getTime() + days(30))
        : null,
      ecddReport: null,
    });

    bump("customers");
    bump("accounts");
    bump("cra");

    const plain = typeof customer.toObject === "function" ? customer.toObject() : customer;
    created.push(plain);
    console.log(`    + ${fullName.padEnd(28)} ${plain.uid}  (${p.riskLabel})`);
  }

  return created;
}

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

  if (DROP_SYNTHETIC) {
    await dropSyntheticCustomers(clientId);
    await mongoose.disconnect();
    console.log("\n  Done.\n");
    return;
  }

  // Case.createdBy is required. Prefer the client's own user so the audit
  // trail stays inside the tenant; fall back to any user.
  const author =
    (clientDoc.user &&
      (await User.findById(clientDoc.user).select("_id name").lean())) ||
    (await User.findOne().select("_id name").lean());
  if (!author) throw new Error("No users found — cannot set Case.createdBy.");

  // A second user for reviewer / four-eyes fields, when one exists.
  const reviewer =
    (await User.findOne({ _id: { $ne: author._id } }).select("_id").lean()) ||
    author;

  // Provision the tenant's customer relationships first, so a client that has
  // never onboarded anyone still has a pool for the chain to build on.
  // Standalone journey copy / AML screen / accounts+CRA against customers
  // attached by an earlier run.
  if ((COPY_JOURNEYS || SEED_AML || SEED_ACCOUNTS) && ATTACH_CUSTOMERS === null) {
    if (COPY_JOURNEYS || SEED_ACCOUNTS) {
      const branchId = await ensureBranch(clientId, clientDoc.name || "Client");
      if (COPY_JOURNEYS) await copyJourneys(clientId, branchId);
      // AML first when both are asked for — the CRA's EDD answers are derived
      // from the screening result, so it has to exist by then.
      if (SEED_AML) await seedAmlMatches(clientId, reviewer._id);
      if (SEED_ACCOUNTS) await seedAccountsAndCra(clientId, branchId, author);
    } else if (SEED_AML) {
      await seedAmlMatches(clientId, reviewer._id);
    }
    await mongoose.disconnect();
    console.log("\n  Done.\n");
    return;
  }

  let seeded = [];
  if (ATTACH_CUSTOMERS !== null || MAKE_CUSTOMERS > 0) {
    const branchId = await ensureBranch(clientId, clientDoc.name || "Client");

    // Attach first: the real customer base is the preferred source for the
    // chain, and --make-customers only tops it up when asked for as well.
    if (ATTACH_CUSTOMERS !== null) {
      seeded = await attachCustomers(ATTACH_CUSTOMERS, clientId, branchId, author);
      // The journey belongs with the relation — an onboarded customer with no
      // journey leaves the tenant's onboarding view empty.
      await copyJourneys(clientId, branchId);
      // Order matters: the CRA's EDD answers are derived from the screening.
      await seedAmlMatches(clientId, reviewer._id);
      await seedAccountsAndCra(clientId, branchId, author);
    }
    if (MAKE_CUSTOMERS > 0) {
      console.log(`  Creating ${MAKE_CUSTOMERS} customer(s) for this client`);
      seeded = [...seeded, ...(await makeCustomers(MAKE_CUSTOMERS, clientId, branchId, author))];
    }
  }

  // Only customers onboarded under this client. The whole pool is loaded and
  // then cycled, so ROWS is not capped by the number of customers. Under
  // --dry-run nothing was written, so the just-built documents are prepended
  // by hand — otherwise the query already returns them.
  const stored = await Customer.find({ "relations.client": clientId })
    .populate("user", "name email")
    .lean();
  const customers = DRY_RUN ? [...seeded, ...stored] : stored;

  if (!customers.length) {
    throw new Error(
      `No customers found with a relation to client ${CLIENT_ID}. ` +
        `Pass --make-customers=N to create some.`
    );
  }
  console.log(`  Customers available: ${customers.length}`);

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

  console.log(`\n  Seeding ${ROWS} chain(s)\n`);

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
    const onboardedAt = relation.registeredAt || new Date(when.getTime() - days(60));

    // The Case is not created until step 3, but the narratives quote its uid —
    // so it is minted here and handed to the Case document unchanged.
    const caseNumber = uid("CA", "-");
    const p = { ...profileOf(customer), channel: relation.onboardingChannel };
    const ctx = { name, customer, p, v, amount, currency: v.currency, reference, when, onboardedAt, caseNumber };
    const n = buildNarratives(ctx);

    const txn = await persist(Transaction, {
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
    const alert = await persist(Alert, {
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
      explanation: n.alertExplanation,
      riskScore: v.alertRisk,
      riskLabel: v.alertLabel,
      priority: v.priority,
      status: "new",
      statusReason: "Auto-generated by the transaction monitoring engine.",
      closedAt: null,
      slaDeadline: new Date(when.getTime() + days(3)),
      slaStatus: v.slaStatus,
      // Has a unique index. The natural key (rule + customer + day) repeats
      // across cycled rows and across re-runs, so the row identity is appended
      // to keep every seeded alert distinct.
      deduplicationKey: `${v.ruleId}:${customer._id}:${when
        .toISOString()
        .slice(0, 10)}:${STAMP}-${i + 1}`,
      // One entry per AI section, so the alert timeline shows the same
      // narrative the report views render.
      activity: [
        {
          type: "activity",
          title: "Alert generated",
          message: n.alertExplanation,
          createdBy: author._id,
          createdAt: when,
        },
        {
          type: "activity",
          title: "ECDD Profile Summary",
          message: n.profileSummary,
          createdBy: author._id,
          createdAt: new Date(when.getTime() + 3600 * 1000),
        },
        {
          type: "activity",
          title: "Transaction Analysis",
          message: n.transactionAnalysis,
          createdBy: author._id,
          createdAt: new Date(when.getTime() + 5400 * 1000),
        },
        {
          type: "activity",
          title: "Behavioural Analysis",
          message: n.behavioralAnalysis,
          createdBy: author._id,
          createdAt: new Date(when.getTime() + 7200 * 1000),
        },
        {
          type: "activity",
          title: "SMR Narrative",
          message: n.smrNarrative,
          createdBy: author._id,
          createdAt: new Date(when.getTime() + 9000 * 1000),
        },
        {
          type: "activity",
          title: "GFS Suspicion Summary",
          message: n.gfsSuspicionSummary,
          createdBy: author._id,
          createdAt: new Date(when.getTime() + 10800 * 1000),
        },
        {
          type: "note",
          title: "Recommendation",
          message: n.recommendation,
          createdBy: author._id,
          createdAt: new Date(when.getTime() + 12600 * 1000),
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
      // The full AI report bundle — ecddReport / smrReport / rfiReport /
      // gfsReport — in the same shape the *AlertSeeder scripts persist.
      metadata: {
        source: "seedCaseWorkflow",
        engine: "rule-engine",
        ...buildAlertReports(ctx, n),
      },
      isDeleted: false,
      deletedAt: null,
    });
    bump("alerts");

    // 3 ── Case ───────────────────────────────────────────────────────────────
    const caseDoc = await persist(Case, {
      client,
      branch,
      uid: caseNumber,
      title: `${v.ruleName} — ${name}`,
      description: n.caseDescription,
      type: "transaction_monitoring",
      caseType: v.caseType,
      riskScore: v.alertRisk,
      riskLabel: v.alertLabel,
      priority: v.priority,
      status: v.caseStatus,
      closureReason: isClosed ? v.closureReason : null,
      closedAt: isClosed ? new Date(when.getTime() + days(4)) : null,
      customer: customer._id, // Primary customer (POI) — same person the chain is built on
      linkedCustomers: [customer._id],
      linkedAlerts: [alert._id],
      linkedTransactions: [txn._id],
      assignedTo: author._id,
      reviewer: reviewer._id,
      watchers: [reviewer._id],
      createdBy: author._id,
      decision: isClosed ? v.decision : null,
      decisionNotes: isClosed
        ? `${n.behavioralAnalysis}\n\nReviewed against payroll and rental records; the activity reconciles to ` +
          `declared income and the alert is closed as a false positive. ${n.recommendation}`
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
          "investigation.investigatorNotes": n.transactionAnalysis,
        },
      }
    );

    // Notes and the system event log live in their own collections — the Case
    // model documents this split rather than embedding them.
    await persist(CaseNote, {
      client,
      branch,
      case: caseDoc._id,
      author: author._id,
      content: `${n.transactionAnalysis}\n\n${n.recommendation}`,
      attachments: ["transaction-schedule.pdf"],
    });
    bump("caseNotes");

    await persist(AuditLog, {
      service: "case",
      action: "case_created",
      details: `Case opened from alert ${alert.uid} (${v.ruleName}).`,
      case: caseDoc._id,
      user: author._id,
      customer: customer._id,
      client,
      branch,
      actor: author._id,
      actorName: author.name || "Seed user",
      actorRole: "compliance_officer",
      status: "success",
      beforeValue: null,
      afterValue: { status: v.caseStatus, priority: v.priority },
      linkedMatterId: caseDoc.uid,
    });
    bump("auditLogs");

    const link = { ...tenant, alert: alert._id };

    // 4 ── Reports ────────────────────────────────────────────────────────────
    // ECDD and SMR key the hub as `caseId`…
    await persist(EcddReport, {
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
      accountPurpose: p.accountPurpose,
      expectedVolume: 50000,
      annualIncome: 180000,
      beneficialOwner: name,
      directors: name,
      isPEP: p.isPep ? "Yes" : "No",
      isSanctioned: p.sanction ? "Yes" : "No",
      relatedParty: "Meridian Trade Solutions GmbH (counterparty)",
      accountCreationDate: onboardedAt,
      analysisEndDate: when,
      totalDepositsAUD: n.figures.deposits,
      totalWithdrawalsUSDT: n.figures.usdt,
      totalWithdrawalsETH: n.figures.eth,
      totalWithdrawalsBTC: n.figures.btc,
      depositDetails: n.depositDetails,
      withdrawalDetails: n.withdrawalDetails,
      additionalInfo: n.additionalInfo,
      ipLocations: 3,
      registeredAddress: "Level 12, 120 Collins Street, Melbourne VIC 3000",
      profileSummary: n.profileSummary,
      transactionAnalysis: n.transactionAnalysis,
      behavioralAnalysis: n.behavioralAnalysis,
      recommendation: n.recommendation,
      status: "Pending",
      settings: { reviewCycleMonths: 6, autoEscalate: true },
      metadata: {
        source: "seedCaseWorkflow",
        caseUid: caseDoc.uid,
        // Same bundle as the alert, so the ECDD view can render every AI
        // section without re-reading the alert.
        ...buildAlertReports(ctx, n),
      },
    });
    bump("ecdd");

    await persist(SMR, {
      ...link,
      uid: uid("SMR"),
      caseId: caseDoc._id,
      caseNumber: alert.uid,
      status: "draft",
      partA: {
        serviceStatus: "provided",
        // Must match the SMR form's option labels exactly (ui/components/
        // smr-parts/options.js) — Part A is a checklist, and a value that is
        // not on the list renders unticked and reads as "not selected".
        designatedServices: ["Account/deposit taking services", "Currency exchange services"],
        suspicionReasons: SMR_SUSPICION_REASONS(v.riskFlags),
        otherReasons: [
          `Customer has not responded to the request for source-of-funds evidence issued on ${ymd(when)}.`,
          `Observed turnover is inconsistent with the expectation of ${p.volume} declared at onboarding.`,
        ],
      },
      // The s41 grounds — the substantive narrative AUSTRAC reads.
      partB: { groundsForSuspicion: n.groundsForSuspicion },
      partC: {
        personOrganisation: {
          name,
          otherNames: ["M. Hossain"],
          personDetails: { dateOfBirth: iso(Date.now() - days(365 * 34)), nationality: "Australian" },
          businessAddress: smrAddress(),
          phoneNumbers: ["+61 400 000 000"],
          emails: ["seed.customer@example.com"],
          accounts: [{ type: "transaction", number: "AU-7842-0012-3345", institution: "Commonwealth Bank of Australia" }],
          digitalWallets: [{ type: "BTC", identifier: "bc1qseeddemowallet00000000000000000000" }],
          occupation: "Company Director",
          beneficialOwners: [{ name, address: smrAddress() }],
          officeHolders: [{ name, position: "Director" }],
          documentation: "Passport, Driver Licence",
          identityVerification: {
            documents: [{ type: "Passport", number: "PA1234567", country: "Australia", expiry: iso(Date.now() + days(365 * 4)) }],
            electronicSources: [{ type: "Credit bureau", identifier: "EQ-88213" }],
            deviceIdentifiers: [{ type: "browser", identifier: "dev-chrome-win11-8f3c" }],
          },
          isCustomer: true,
          isAuthorisedAgent: false,
        },
      },
      partD: {
        hasOtherParties: true,
        otherParties: [{ name: "Meridian Trade Solutions GmbH", businessAddress: smrAddress(), isCustomer: false }],
      },
      partE: {
        hasUnidentifiedPersons: true,
        unidentifiedPersons: [
          { description: "Unidentified male depositing cash on the customer's behalf.", documentation: "Branch CCTV still" },
        ],
      },
      partF: {
        transactions: [
          {
            date: when,
            type: v.txnType,
            completed: v.txnStatus === "completed",
            referenceNumber: reference,
            totalAmount: { currencyCode: v.currency, amount },
            cashAmount: { currencyCode: "AUD", amount: Math.round(amount / 2) },
            foreignCurrencies: [{ currencyCode: "USD", amount: 5000 }],
            digitalCurrencies: [
              { type: "BTC", amount: 0.25, walletAddress: "bc1qseeddemowallet00000000000000000000" },
            ],
            sender: { name, institutions: [{ name: "Commonwealth Bank of Australia", address: smrAddress() }] },
            payee: { name: "Meridian Trade Solutions GmbH", institutions: [{ name: "Deutsche Bank AG", address: smrAddress() }] },
            beneficiary: { name: "Sigma Logistics BV", institutions: [{ name: "ABN AMRO Bank", address: smrAddress() }] },
          },
        ],
      },
      partG: {
        // Part G is a checklist against a fixed statutory list, so it takes the
        // canonical value — `v.offence` is the prose form used in narratives
        // ("connected with money laundering") and does not always match a
        // listed offence. The resolved variant ticks nothing, which is correct.
        likelyOffence: v.likelyOffence,
        previousReports: [{ date: new Date(when.getTime() - days(180)), referenceNumber: `SMR-PRIOR-${i + 1}` }],
        // Embedded documents, not strings — a bare string fails to cast.
        otherGovernmentBodies: [
          {
            name: "AUSTRAC",
            address: smrAddress(),
            dateReported: when,
            informationProvided: "Suspicious matter report lodged electronically.",
          },
          {
            name: "Australian Federal Police",
            address: smrAddress(),
            dateReported: when,
            informationProvided: "Referral of associated account activity.",
          },
        ],
        attachments: ["smr-transaction-schedule.pdf"],
      },
      partH: {
        reportingEntity: {
          name: "Dooit Financial Services Pty Ltd",
          address: smrAddress(),
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
            notes: n.smrNarrative,
          },
        ],
      },
    });
    bump("smr");

    // …TTR, IFTI, GFS and RFI key it as `case`.
    await persist(TTR, {
      ...link,
      uid: uid("TTR"),
      case: caseDoc._id,
      referenceNumber: alert.uid,
      status: "draft",
      completionDate: when,
      ...buildTtrParts(name, amount, reference, when, n.ttrNarrative),
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

    await persist(IFTI, {
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
        transferReason:
          `Supplier payment for imported goods, per the customer's instruction. ${n.iftiNarrative}`,
        completedBy: {
          name: "Compliance Officer",
          jobTitle: "AML/CTF Compliance Officer",
          phone: "+61 3 9000 0000",
          email: "compliance@example.com",
        },
      },
      attachments: ["ifti-instruction.pdf"],
      generatedReport: n.iftiNarrative,
      metadata: {
        version: "1.0",
        createdBy: String(author._id),
        caseUid: caseDoc.uid,
        narrative: n.iftiNarrative,
        transactionAnalysis: n.transactionAnalysis,
      },
    });
    bump("ifti");

    await persist(GFS, {
      ...link,
      uid: uid("GFS"),
      case: caseDoc._id,
      status: "draft",
      suspicionType: v.suspicionType,
      // The GFS narrative slot — full AI suspicion write-up, not a one-liner.
      suspicionReason: n.gfsSuspicionSummary,
      suspicionDates: `${ymd(new Date(when.getTime() - days(11)))} to ${ymd(when)}`,
      suspicionIntensity: v.alertLabel,
      suspicionBehaviour: n.behavioralAnalysis,
      customerName: name,
      customerUID: customer.uid,
      companyName: p.employer,
      customerAge: p.dob ? Math.floor((Date.now() - new Date(p.dob).getTime()) / days(365)) : 34,
      accountOpeningDate: onboardedAt,
      sourceOfFunds: p.sourceOfFunds,
      accountOpeningPurpose: p.accountPurpose,
      reviewStartDate: new Date(when.getTime() - days(30)),
      reviewEndDate: when,
      totalDeposited: n.figures.deposits,
      totalWithdrawn: n.figures.withdrawnAud,
      totalSuspicionAmount: n.figures.suspicionAmount,
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
      ipAddresses: [{ id: "IP-1", address: "203.0.113.45", country: p.country, date: when }],
      customerCountry: p.country,
      additionalNotes: n.additionalInfo,
      attachments: ["gfs-evidence-pack.pdf"],
      generatedReport: [
        `GRIFFITH / GFS REPORT — ${caseDoc.uid}`,
        ``,
        `1. CUSTOMER PROFILE`,
        n.profileSummary,
        ``,
        `2. TRANSACTION ANALYSIS`,
        n.transactionAnalysis,
        ``,
        `3. BEHAVIOURAL ANALYSIS`,
        n.behavioralAnalysis,
        ``,
        `4. SUSPICION SUMMARY`,
        n.gfsSuspicionSummary,
        ``,
        `5. RECOMMENDATION`,
        n.recommendation,
      ].join("\n"),
      metadata: {
        version: "1.0",
        createdBy: String(author._id),
        caseUid: caseDoc.uid,
        suspicionSummary: n.gfsSuspicionSummary,
        ...buildAlertReports(ctx, n),
      },
    });
    bump("gfs");

    await persist(RFI, {
      ...link,
      uid: uid("RFI"),
      case: caseDoc._id,
      status: "Sent",
      primaryContactName: name,
      replyToEmail: "compliance@example.com",
      // Rfi has no `message` field — the ask lives in requestedItems[].text,
      // and the composed email body is carried on metadata.
      requestedItems: n.rfiItems.map((text) => ({ text, txRef: reference })),
      responseDeadline: new Date(when.getTime() + days(14)),
      followupDeadline: new Date(when.getTime() + days(21)),
      finalDeadline: new Date(when.getTime() + days(28)),
      activityNote: [
        {
          note:
            `RFI issued to ${name} at ${p.email} on ${ymd(when)}, citing case ${caseDoc.uid}. ` +
            `Five items requested covering source of funds, the commercial purpose of ${reference}, ` +
            `supporting trade documentation, employment evidence and proof of address. ` +
            `Response due ${ymd(new Date(when.getTime() + days(14)))}; escalation to final notice if unanswered.`,
          uploadedAt: when,
          by: author._id,
        },
      ],
      sentAt: when,
      sentBy: author._id,
      settings: { remindersEnabled: true, reminderDays: 7 },
      metadata: {
        source: "seedCaseWorkflow",
        caseUid: caseDoc.uid,
        subject: `Request for information – ${caseDoc.uid} (${name})`,
        body: n.rfiBody,
      },
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
