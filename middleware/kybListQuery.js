/**
 * KYB list-query middleware (docs/65 Step 68) — company & trust list pages.
 *
 * WHY A DEDICATED MIDDLEWARE, AND NOT `advancedResults`:
 * The generic `advancedResults` JSON.stringify's whatever is left in
 * req.query, regex-replaces `gt|gte|lt|lte|in|text|search|regex|options` into
 * `$`-operators, and JSON.parse's the result straight into `model.find()`.
 * Every unrecognised query param therefore becomes a Mongo filter key on a
 * KYB collection — a client could filter by `customer`, or inject `$regex` /
 * `$in`, and enumerate records that the UI never exposes. It also cannot
 * express the `$or` search these lists need, doesn't whitelist `sort`, and
 * was removed from /company/all in Step 30 because it ran a second, discarded
 * query per call.
 *
 * This follows the *good* precedent instead — `advancedCustomerResultsQueryOnly`
 * (docs/49): an explicit field whitelist and an explicit sort whitelist.
 *
 * It BUILDS ONLY. It does not execute, so:
 *  - there is exactly one query per request (the controller's),
 *  - each controller keeps its own response shape (the company list's
 *    `{ total, page, pages }` contract is unchanged), and
 *  - `build()` is unit-testable with no database.
 */

// User input is a literal, not a pattern — "A+B (Holdings)" must match itself
// rather than throw or mis-match (docs/65 Step 30).
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isEmpty = (v) => v === undefined || v === null || v === "" || v === "null";

// Only stored, sensibly-indexable scalars. Anything else falls back to the
// default: an unrecognised sort used to reach the query planner verbatim,
// which silently returned an arbitrary order and could force a collection
// scan on a large tenant.
const SORTABLE = {
  company: new Set([
    "createdAt",
    "updatedAt",
    "uid",
    "sequence",
    "review_status",
    "general_information.legal_name",
    "general_information.country_of_incorporation",
    "general_information.registration_date",
    "general_information.entity_type",
    "general_information.status",
  ]),
  trust: new Set([
    "createdAt",
    "updatedAt",
    "uid",
    "sequence",
    "review_status",
    "trust_details.full_trust_name",
    "trust_details.country_of_establishment",
  ]),
};

// query param -> document path. Exact-match facets only; anything not listed
// here is ignored rather than passed through to the query.
const EXACT_FILTERS = {
  company: {
    client: "client",
    branch: "branch",
    customer: "customer",
    uid: "uid",
    review_status: "review_status",
    entity_type: "general_information.entity_type",
    status: "general_information.status",
    country: "general_information.country_of_incorporation",
    reg: "general_information.registration_number",
  },
  trust: {
    client: "client",
    branch: "branch",
    customer: "customer",
    uid: "uid",
    review_status: "review_status",
    trust_type: "trust_details.trust_type.selected_type",
    country: "trust_details.country_of_establishment",
    reg: "trust_details.trust_type.unregulated_trust.registration_number",
    abn: "trust_details.trust_type.self_managed_super_fund.abn",
  },
};

// Free-text search targets — the fields a reviewer actually types into a
// search box (a name, a registration number, a UID off a linked-trust card).
const SEARCH_FIELDS = {
  company: [
    "general_information.legal_name",
    "general_information.trading_names",
    "general_information.registration_number",
    "uid",
    "identifiers.value",
  ],
  trust: ["trust_details.full_trust_name", "uid"],
};

const parseSort = (raw, kind) => {
  if (isEmpty(raw)) return "-createdAt";
  const value = String(raw).trim();
  const field = value.startsWith("-") ? value.slice(1) : value;
  return SORTABLE[kind].has(field) ? value : "-createdAt";
};

/**
 * @param {"company"|"trust"} kind
 * @param {object} query  req.query
 * @returns {{ filter: object, sort: string, page: number, limit: number, skip: number }}
 */
function build(kind, query = {}) {
  const filter = {};

  Object.entries(EXACT_FILTERS[kind]).forEach(([param, path]) => {
    if (!isEmpty(query[param])) filter[path] = String(query[param]).trim();
  });

  // sequence is the one numeric facet — a non-numeric value would otherwise
  // cast-error the whole query.
  if (!isEmpty(query.sequence) && !Number.isNaN(Number(query.sequence))) {
    filter.sequence = Number(query.sequence);
  }

  if (!isEmpty(query.search)) {
    const rx = new RegExp(escapeRegExp(String(query.search).trim()), "i");
    filter.$or = SEARCH_FIELDS[kind].map((path) => ({ [path]: rx }));
  }

  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  // Cap page size — an unbounded ?limit= dumped the whole collection.
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 200);

  return { filter, sort: parseSort(query.sort, kind), page, limit, skip: (page - 1) * limit };
}

const kybListQuery = (kind) => (req, res, next) => {
  req.kybQuery = build(kind, req.query);
  next();
};

module.exports = kybListQuery;
module.exports.build = build;
