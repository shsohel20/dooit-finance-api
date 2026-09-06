// seeds/classify-rule-applies-to.js
//
// Phase 3 of RuleEngine data quality work — fix `appliesTo` and the condition
// field names.
//
// Two problems in the imported corpus:
//
//   1. Every rule was stamped `appliesTo: 'transaction'` (the schema default)
//      regardless of what it evaluates. Roughly a quarter is really about the
//      *customer* (PEP, KYC documents, UBO, business profile, device/session
//      fingerprints, source of funds …) and has nothing to resolve against on
//      a Transaction document.
//
//   2. `conditions[].field` / `logic` leaves use analyst labels ("Amount",
//      "Industry", "Source of funds") instead of schema paths, so an evaluator
//      cannot read them off a document.
//
// Subjects are limited to the two the engine supports:
//
//   transaction — rule reads money/party/channel/crypto fields; evaluated once
//                 per Transaction. Customer fields are reachable through the
//                 `customer.` prefix (doc 72 §3.3 alias map).
//   customer    — rule reads only profile / KYC / screening / device fields;
//                 evaluated against the Customer, never per transaction.
//
// Decision order (first match wins):
//   1. any transaction signal in fields or condition text → transaction
//      (mixed rules like "Occupation = UNEMPLOYED AND amount > 50,000" are
//      transaction rules that *consult* the customer)
//   2. any customer signal                                → customer
//   3. nothing recognisable                               → transaction,
//      flagged `review=yes` in the report so a human can look.
//
// Field renaming is conservative: only labels in FIELD_ALIASES are rewritten.
// Anything else (derived metrics, flags with no backing column, Sardine
// session paths) is left exactly as-is and listed in the `unmapped` column.
//
// Usage:
//   node seeds/classify-rule-applies-to.js                  # dry-run from DB + CSV report
//   node seeds/classify-rule-applies-to.js --apply          # write appliesTo + field names
//   node seeds/classify-rule-applies-to.js --client=<id>    # limit to one tenant
//   node seeds/classify-rule-applies-to.js --csv=<export>   # offline preview from a
//                                                           # Mongo CSV export, no DB

require("dotenv").config({ path: "./config/config.env" });
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const RuleEngine = require("../models/RuleEngine");

// ── CLI flags ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const CLIENT_ID = flag("client");
const CSV_PATH = flag("csv");

// ── Signal vocabularies ──────────────────────────────────────────────────────
// Matched case-insensitively against: every condition field name, the
// ruleCondition text and the ruleName. Keep these lists readable — when a new
// vocabulary shows up in an import, add a word here rather than special-casing.

const TRANSACTION_SIGNALS = new RegExp(
  [
    // money
    "\\bamount\\b", "convertedAmountAUD", "\\bcurrency\\b", "\\bcash",
    // transaction typing / lifecycle
    "\\btransactions?\\b", "\\btx\\b", "\\btransfer", "\\bpayment", "\\bremittance",
    "\\bdeposit\\b", "\\bwithdraw", "\\bchannel\\b", "\\bsubtype\\b",
    "\\bpurpose\\b", "\\bnarrative\\b", "\\breference\\b", "\\briskScore\\b",
    // bare "type" (not "Business type" / "Sender type" / "Document type")
    "^type$", "(?<!business |sender |beneficiary |document |counterparty |phone )\\btype\\s*=",
    // parties on a transaction
    "\\bsender\\b", "\\bbeneficiary\\b", "\\breceiver\\b", "\\bcounterparty\\b",
    "\\binstitution", "\\bbic\\b", "\\bcorridor\\b", "\\bsending\\b", "\\bmerchant\\b",
    "\\bfunders?\\b", "\\bfunds\\b",
    // crypto / travel rule
    "\\bcrypto", "\\bwallet", "\\bvasp\\b", "travelRule", "travel rule", "\\bhops\\b",
    "\\bmixer\\b", "\\bbridge\\b", "\\bblockchain\\b", "\\bnft\\b", "\\bdex\\b",
    "\\bstablecoin\\b", "privacy coin",
    // sector-specific transaction types
    "\\bbullion\\b", "\\bcasino\\b", "\\bbet", "\\bpurchase\\b", "\\bsettlement\\b",
    "\\bloan\\b", "\\bpremium\\b", "\\bclaim", "\\bdonation", "\\bfees?\\b",
    "\\binvoice\\b", "\\bgoods\\b", "\\bship", "\\brouting\\b",
    // message / filing
    "\\bswift\\b", "message direction", "message status", "message ttl",
    "\\bttr\\b", "\\bsmr\\b", "\\bifti\\b",
    // already-canonical Transaction sub-document paths
    "^forensic\\.", "^investigation\\.", "^bullion\\.",
    // dotted DSL namespaces that live on the transaction
    "^Transaction\\.", "^PaymentMethod\\.", "^Recipient\\.",
  ].join("|"),
  "i"
);

const CUSTOMER_SIGNALS = new RegExp(
  [
    // screening
    "\\bpep\\b", "sanction", "adverse media", "watchlist", "\\bofac\\b", "\\bunsc\\b",
    "\\bmatch(?:ed|es)? with\\b", "\\blist\\b", "aml model",
    // KYC / identity
    "\\bkyc\\b", "\\bkyb\\b", "\\bcustomer\\b", "\\bclient\\b", "\\bidentity\\b",
    "\\bid (?:expiry|issued)\\b", "\\bdocument", "residence proof", "\\bdob\\b",
    "date of birth", "\\bage\\b", "\\bpassport\\b", "\\bocr\\b", "\\bgender\\b",
    "citizenship", "nationality", "\\bcountry\\b",
    // profile
    "occupation", "employment", "\\bindustry\\b", "industry sector", "source of funds",
    "source of wealth", "\\bsof\\b", "\\bsow\\b", "tax (?:info|residence)",
    "\\bwealth\\b", "declared income",
    // business / legal entity
    "\\bubo\\b", "beneficial owner", "\\bdirector\\b", "business (?:address|structure|type)",
    "\\bshell\\b", "\\bentity\\b", "\\bfirm\\b", "registration", "\\bnfp\\b",
    "\\bcasp\\b", "\\bmsb\\b", "authori[sz]ation", "supervised", "compliance officer",
    // account lifecycle (belongs to the customer, not a single txn)
    "account (?:open|status|age|limit)", "\\bdormant\\b", "new account", "synthetic",
    "password", "behaviou?ral",
    // contact / device / session fingerprints
    "phone", "\\bemail\\b", "\\bdevice\\b", "\\bsession\\b", "\\bbiometric\\b",
    "\\bip\\b", "user.agent", "geolocation", "timezone", "mouse", "typing", "\\bbot\\b",
    "\\brooted\\b", "fingerprint",
    // data-protection / governance rules are about the data subject
    "\\bgdpr\\b", "\\bapp lawful\\b", "\\bpii", "privacy", "lawful basis", "\\bdpia\\b",
    "legal hold", "retention", "anonymi", "profiling", "consent",
    // dotted DSL namespaces that live on the customer/session
    "^Device\\.", "^Email\\.", "^Phone\\.", "^IP\\.", "^TrueIP\\.", "^TrueLocation\\.",
    "^Session\\.", "^User\\.", "^Biometric\\.", "^CustomerSession\\.", "^GPS\\.",
  ].join("|"),
  "i"
);

// ── Field alias map ──────────────────────────────────────────────────────────
// analyst label (lower-case, single-spaced)  →  { on: 'transaction'|'customer', path }
//
// `on: 'customer'` paths are relative to the Customer document. When the rule
// itself applies to a transaction they are prefixed with `customer.` so the
// evaluator knows to hop to the subject customer (doc 72 §3.3).
//
// Only add entries that map 1:1 onto a real schema path. Derived metrics
// ("Account open days", "Sender age") and flags with no backing column
// ("Crypto transaction = YES") stay unmapped on purpose.
const KYC = "personalKyc.personal_form";
const FIELD_ALIASES = {
  // ── transaction ──
  amount: { on: "transaction", path: "amount" },
  currency: { on: "transaction", path: "currency" },
  channel: { on: "transaction", path: "channel" },
  type: { on: "transaction", path: "type" },
  subtype: { on: "transaction", path: "subtype" },
  status: { on: "transaction", path: "status" },
  purpose: { on: "transaction", path: "purpose" },
  narrative: { on: "transaction", path: "narrative" },
  reference: { on: "transaction", path: "reference" },
  hops: { on: "transaction", path: "crypto.hops" },
  "deposit method": { on: "transaction", path: "channel" },
  "transaction": { on: "transaction", path: "type" },
  "travel rule version": { on: "transaction", path: "travelRule.protocol" },
  "originator vasp api endpoint": { on: "transaction", path: "travelRule.originatorVaspId" },
  "beneficiary vasp api endpoint": { on: "transaction", path: "travelRule.beneficiaryVaspId" },

  // ── customer: screening ──
  pep: { on: "customer", path: "isPep" },
  sanction: { on: "customer", path: "sanction" },
  customer: { on: "customer", path: "uid" },
  "consent to screen": { on: "customer", path: "consentToScreen" },
  "aml model alert": { on: "customer", path: "amlStatus" },
  "customer.amlriskLabels": { on: "customer", path: "amlRiskLabels" },

  // ── customer: profile ──
  occupation: { on: "customer", path: `${KYC}.employment_details.occupation` },
  employment: { on: "customer", path: `${KYC}.employment_details.occupation` },
  industry: { on: "customer", path: `${KYC}.employment_details.industry` },
  "industry sector": { on: "customer", path: `${KYC}.employment_details.industry` },
  "phone number": { on: "customer", path: `${KYC}.contact_details.phone` },
  "source of funds": { on: "customer", path: "personalKyc.funds_wealth.source_of_funds" },
  "source of wealth": { on: "customer", path: "personalKyc.funds_wealth.source_of_wealth" },
  "purpose of account": { on: "customer", path: "personalKyc.funds_wealth.account_purpose" },
  "business address": { on: "customer", path: "personalKyc.sole_trader.business_details.business_address.address" },
  "document type": { on: "customer", path: "documents.docType" },
  "country of citizenship": { on: "customer", path: "country" },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const normalise = (label) => String(label || "").trim().toLowerCase().replace(/\s+/g, " ");

/** Walk a `logic` tree ({logic, children[]} or leaf {field}) and collect field names. */
function collectLogicFields(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.field) out.push(String(node.field));
  if (Array.isArray(node.children)) node.children.forEach((c) => collectLogicFields(c, out));
  return out;
}

/** All text worth inspecting for one rule: field names + condition + name. */
function signalTexts(rule) {
  const fields = [
    ...(rule.conditions || []).map((c) => c && c.field).filter(Boolean),
    ...collectLogicFields(rule.logic),
  ];
  return { fields, text: `${rule.ruleCondition || ""} ${rule.ruleName || ""}` };
}

/**
 * Decide the subject of one rule.
 * Returns { appliesTo: 'transaction'|'customer', review: boolean, why: string }
 */
function classify(rule) {
  const { fields, text } = signalTexts(rule);
  const haystacks = [...fields, text];

  const txHit = haystacks.find((h) => TRANSACTION_SIGNALS.test(h));
  if (txHit) {
    return { appliesTo: "transaction", review: false, why: `tx signal in "${txHit.slice(0, 40)}"` };
  }

  const custHit = haystacks.find((h) => CUSTOMER_SIGNALS.test(h));
  if (custHit) {
    return { appliesTo: "customer", review: false, why: `customer signal in "${custHit.slice(0, 40)}"` };
  }

  return { appliesTo: "transaction", review: true, why: "no recognisable signal — default" };
}

/**
 * Canonical schema path for one analyst label, given the rule's subject.
 * Returns null when the label is unknown (caller leaves it untouched).
 */
function canonicalField(label, appliesTo) {
  const alias = FIELD_ALIASES[normalise(label)];
  if (!alias) return null;
  if (alias.on === "customer" && appliesTo === "transaction") return `customer.${alias.path}`;
  return alias.path;
}

/**
 * Rewrite every field name in `conditions[]` and the `logic` tree.
 * Returns { conditions, logic, mapped: ['Amount→amount', …], unmapped: ['Sender age', …] }
 */
function remapFields(rule, appliesTo) {
  const mapped = new Set();
  const unmapped = new Set();

  const rename = (field) => {
    // Already a schema path (dotted, or an exact top-level name) → leave alone.
    const next = canonicalField(field, appliesTo);
    if (next === null) {
      if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/.test(field)) unmapped.add(field);
      return field;
    }
    if (next !== field) mapped.add(`${field}→${next}`);
    return next;
  };

  const conditions = (rule.conditions || []).map((c) => (c && c.field ? { ...c, field: rename(c.field) } : c));

  const walk = (node) => {
    if (!node || typeof node !== "object") return node;
    const copy = { ...node };
    if (copy.field) copy.field = rename(copy.field);
    if (Array.isArray(copy.children)) copy.children = copy.children.map(walk);
    return copy;
  };
  const logic = rule.logic ? walk(rule.logic) : rule.logic;

  return { conditions, logic, mapped: [...mapped], unmapped: [...unmapped] };
}

// ── Offline CSV source (Mongo Compass / mongoexport flat CSV) ───────────────

/** Tiny RFC-4180 parser — enough for a Compass export (quotes, commas, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** Re-hydrate the flat `logic.children[0].field` / `conditions[1].field` columns. */
function rulesFromCsv(file) {
  const [header, ...lines] = parseCsv(fs.readFileSync(file, "utf8"));
  const col = (name) => header.indexOf(name);
  return lines
    .filter((r) => r.length > 5)
    .map((r) => {
      const get = (name) => (col(name) >= 0 ? r[col(name)] : "");
      const leavesAt = (prefix) =>
        [0, 1, 2, 3]
          .map((i) => ({ field: get(`${prefix}[${i}].field`), operator: get(`${prefix}[${i}].operator`), value: get(`${prefix}[${i}].value`) }))
          .filter((l) => l.field);
      const children = leavesAt("logic.children");
      return {
        _id: get("_id"),
        client: get("client"),
        ruleId: get("ruleId"),
        ruleName: get("ruleName"),
        ruleCondition: get("ruleCondition"),
        appliesTo: get("appliesTo"),
        conditions: leavesAt("conditions"),
        logic: get("logic.field")
          ? { field: get("logic.field"), operator: get("logic.operator"), value: get("logic.value") }
          : children.length ? { logic: get("logic.logic") || "AND", children } : null,
      };
    });
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function run() {
  const mode = CSV_PATH ? "CSV-PREVIEW" : APPLY ? "APPLY" : "DRY-RUN";
  console.log(`[appliesTo] mode=${mode}${CLIENT_ID ? ` client=${CLIENT_ID}` : ""}`);

  // 1. Load rules — from the export CSV (offline) or the live collection.
  let rules;
  if (CSV_PATH) {
    rules = rulesFromCsv(path.resolve(CSV_PATH));
  } else {
    await mongoose.connect(process.env.MONGO_URI);
    const filter = CLIENT_ID ? { client: CLIENT_ID } : {};
    rules = await RuleEngine.find(filter, {
      client: 1, ruleId: 1, ruleName: 1, ruleCondition: 1, appliesTo: 1, conditions: 1, logic: 1,
    }).lean();
  }
  if (CLIENT_ID && CSV_PATH) rules = rules.filter((r) => String(r.client) === CLIENT_ID);

  // 2. Classify + remap.
  const counts = { transaction: 0, customer: 0, review: 0, subjectChanged: 0, fieldsChanged: 0, unmappedRules: 0 };
  const report = [];
  for (const rule of rules) {
    const { appliesTo, review, why } = classify(rule);
    const { conditions, logic, mapped, unmapped } = remapFields(rule, appliesTo);

    const subjectChanged = (rule.appliesTo || "transaction") !== appliesTo;
    const fieldsChanged = mapped.length > 0;
    counts[appliesTo]++;
    if (review) counts.review++;
    if (subjectChanged) counts.subjectChanged++;
    if (fieldsChanged) counts.fieldsChanged++;
    if (unmapped.length) counts.unmappedRules++;

    report.push({
      ruleId: rule.ruleId, previous: rule.appliesTo || "", next: appliesTo, review, why,
      mapped: mapped.join("; "), unmapped: unmapped.join("; "), ruleCondition: rule.ruleCondition || "",
    });

    // 3. Persist — only real changes, only in --apply mode against the DB.
    if (APPLY && !CSV_PATH && (subjectChanged || fieldsChanged)) {
      const $set = { appliesTo };
      if (fieldsChanged) {
        if (rule.conditions) $set.conditions = conditions;
        if (rule.logic) $set.logic = logic;
      }
      await RuleEngine.updateOne({ _id: rule._id }, { $set });
    }
  }

  // 4. CSV report — always written, for the audit trail / eyeballing.
  const reportPath = path.resolve(__dirname, "../tmp/applies-to-report.csv");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const q = (s) => JSON.stringify(s || "");
  const csv = [
    "ruleId,previous,next,review,why,mappedFields,unmappedFields,ruleCondition",
    ...report.map((r) => [r.ruleId, r.previous, r.next, r.review ? "yes" : "", q(r.why), q(r.mapped), q(r.unmapped), q(r.ruleCondition)].join(",")),
  ].join("\n");
  fs.writeFileSync(reportPath, csv);

  const verb = APPLY && !CSV_PATH ? "updated" : "would update";
  console.log(`[appliesTo] scanned=${rules.length} transaction=${counts.transaction} customer=${counts.customer} needs-review=${counts.review}`);
  console.log(`[appliesTo] ${verb}: subject=${counts.subjectChanged} fields=${counts.fieldsChanged} | rules with unmapped labels=${counts.unmappedRules}`);
  console.log(`[appliesTo] report=${reportPath}`);
  if (!APPLY) console.log("[appliesTo] nothing written — check the report (review=yes rows first), then re-run with --apply.");

  if (!CSV_PATH) await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[appliesTo] failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
