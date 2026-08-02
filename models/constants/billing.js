// models/constants/billing.js
//
// Shared vocabulary for the billing & subscription module.
// Imported by every billing model, service and seeder so the API, the seed data
// and the UI filter dropdowns cannot drift apart.
//
// Reference: docs/billingmodule/mongoose-schema.md §C.0

// ── Products ─────────────────────────────────────────────────────────────────
// Drives the spend-by-category grouping and the category chips in the UI.
const PRODUCT_CATEGORIES = [
  "Platform",
  "Verification",
  "Screening",
  "Biometrics",
  "Monitoring",
  "Risk",
  "Data",
  "Notifications",
];

// What one billable unit of a product is. Shown on invoice lines.
const PRODUCT_UNITS = [
  "check",
  "event",
  "form",
  "message",
  "call",
  "account",
  "session",
  "applicant",
];

// Where meter events originate — lets ingestion validate the producer.
const METER_SOURCES = ["dooit", "dvs", "internal", "blockchain", "manual"];

const PRODUCT_STATUS = ["active", "inactive"];

// ── Money ────────────────────────────────────────────────────────────────────
// Single-currency today. The field exists so that stays a deliberate choice.
const CURRENCIES = ["AUD"];

// ── Plans ────────────────────────────────────────────────────────────────────
const PRICING_MODELS = ["flat", "usage", "tiered", "hybrid"];
const BILLING_CYCLES = ["monthly", "quarterly", "yearly", "custom"];
const PLAN_STATUS = ["draft", "published", "archived"];
const PLAN_VISIBILITY = ["public", "private"];

// Service guarantees advertised on a plan — the "Limits & support" section of
// the Plan Builder, and two rows of the feature comparison matrix.
const SLA_TARGETS = ["none", "99.5%", "99.9%", "99.99%"];
const SUPPORT_LEVELS = [
  "community",
  "email",
  "priority",
  "dedicated_csm",
  "white_glove",
];

// ── Subscriptions ────────────────────────────────────────────────────────────
const SUBSCRIPTION_STATUS = [
  "pending",
  "active",
  "paused",
  "cancelled",
  "expired",
];
const SUBSCRIPTION_CHANGE_TYPES = ["new", "upgrade", "downgrade", "renewal"];

// A negotiated discount held ON THE SUBSCRIPTION, not on the plan.
//
// It is deliberately NOT part of priceSnapshot. The snapshot freezes the plan's
// published commercials so an old invoice reproduces; a discount is a term of
// this one deal that dooit must be able to renegotiate mid-life. Freezing it
// would make "give this customer 10% from next month" impossible without
// re-subscribing them.
//
// Invoices stay reproducible anyway, because each one copies the discount it
// applied into its own line items at close time.
const DISCOUNT_TYPES = ["none", "percentage", "fixed"];

// ── Usage ────────────────────────────────────────────────────────────────────
const USAGE_STATUS = ["recorded", "billed", "excluded", "reversed"];

// ── Invoicing ────────────────────────────────────────────────────────────────
const INVOICE_STATUS = ["draft", "open", "paid", "void", "overdue"];
const LINE_TYPES = [
  "base",
  "usage",
  "overage",
  "adjustment",
  "discount",
  "tax",
];

// ── Payments ─────────────────────────────────────────────────────────────────
const PAYMENT_STATUS = ["pending", "paid", "failed", "refunded"];
const PAYMENT_TYPES = ["payment", "refund"];
const PAYMENT_METHODS = [
  "card",
  "bank_transfer",
  "payid",
  "wire",
  "credit_note",
  "manual",
];

// ── User types (from UserType.userType) ──────────────────────────────────────
// The billing module only cares about these two. Note the discriminator lives on
// the UserType collection, NOT on Users — see mongoose-schema.md §0.
const USER_TYPE_DOOIT = "dooit";
const USER_TYPE_CLIENT = "client";

module.exports = {
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
  METER_SOURCES,
  PRODUCT_STATUS,
  CURRENCIES,
  PRICING_MODELS,
  BILLING_CYCLES,
  PLAN_STATUS,
  PLAN_VISIBILITY,
  SLA_TARGETS,
  SUPPORT_LEVELS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_CHANGE_TYPES,
  DISCOUNT_TYPES,
  USAGE_STATUS,
  INVOICE_STATUS,
  LINE_TYPES,
  PAYMENT_STATUS,
  PAYMENT_TYPES,
  PAYMENT_METHODS,
  USER_TYPE_DOOIT,
  USER_TYPE_CLIENT,
};
