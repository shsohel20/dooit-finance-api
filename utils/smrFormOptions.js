/**
 * Canonical Part A / Part G option lists for the AUSTRAC suspicious matter
 * report, as rendered on the lodged form.
 *
 * Duplicated from ui/components/smr-parts/options.js because the UI and the API
 * are separate packages with no shared module. Keep the two in step: the PDF
 * prints the full checklist, so a label that drifts here prints an unticked box
 * for a reason the report actually recorded.
 */
"use strict";

const DESIGNATED_SERVICES = [
  "AFSL holder arranging a designated service",
  "Account/deposit taking services",
  "Chequebook access facilities",
  "Currency exchange services",
  "Custodial/depository services",
  "Debit card access facilities",
  "Debt instruments",
  "Digital currency exchange services",
  "Electronic funds transfers",
  "Lease/hire purchase services",
  "Life insurance services",
  "Loan services",
  "Money/postal orders",
  "Payroll services",
  "Pension/annuity services",
  "Remittance services (money transfers)",
  "Retirement savings accounts",
  "Securities market/investment services",
  "Stored value cards",
  "Superannuation/approved deposit funds",
  "Traveller's cheque exchange services",
  "Bullion dealing",
  "Betting",
  "Betting accounts",
  "Chips/currency exchange",
  "Games of chance or skill",
  "Gaming machines",
];

const SUSPICION_REASONS = [
  "ATM/cheque fraud",
  "Advanced fee/scam",
  "Avoiding reporting obligations",
  "Corporate/investment fraud",
  "Counterfeit currency",
  "Country/jurisdiction risk",
  "Credit card fraud",
  "Credit/loan facility fraud",
  "Currency not declared at border",
  "DFAT watch list",
  "False name/identity or documents",
  "Immigration related issue",
  "Inconsistent with customer profile",
  "Internet fraud",
  "National security concern",
  "Other watch list",
  "Phishing",
  "Refusal to show identification",
  "Social security issue",
  "Suspected/known criminal",
  "Suspicious behaviour",
  "Unauthorised account transactions",
  "Unusual account activity",
  "Unusual financial instrument",
  "Unusual gambling activity",
  "Unusual use/exchange of cash",
  "Unusually large FX transaction",
  "Unusually large cash transaction",
  "Unusually large transfer",
];

const OFFENCE_TYPES = [
  "Financing of terrorism",
  "Money laundering",
  "Offence against a Commonwealth, State or Territory law",
  "Person/agent is not who they claim to be",
  "Proceeds of crime",
  "Tax evasion",
];

const SERVICE_STATUSES = [
  { value: "provided", label: "Provided" },
  { value: "requested", label: "Requested" },
  { value: "enquired", label: "Enquired about" },
];

/**
 * Splits stored values into the canonical options that were ticked and any
 * values that are not on the list.
 *
 * A value written outside the list would otherwise print as an unticked box and
 * vanish from the lodged report; the extras are returned so the caller can
 * print them separately instead of losing them.
 */
const splitAgainstOptions = (options, values = []) => {
  const stored = Array.isArray(values) ? values.filter(Boolean) : [];
  const normalise = (s) => String(s).trim().toLowerCase();
  const optionByKey = new Map(options.map((o) => [normalise(o), o]));

  const selected = new Set();
  const extras = [];

  for (const value of stored) {
    const match = optionByKey.get(normalise(value));
    if (match) selected.add(match);
    else extras.push(value);
  }

  return { selected, extras };
};

module.exports = {
  DESIGNATED_SERVICES,
  SUSPICION_REASONS,
  OFFENCE_TYPES,
  SERVICE_STATUSES,
  splitAgainstOptions,
};
