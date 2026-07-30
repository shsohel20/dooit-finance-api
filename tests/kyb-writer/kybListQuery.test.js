/**
 * KYB list-query middleware (docs/65 Step 68).
 *
 * Pins the two things this middleware exists to guarantee: only whitelisted
 * params reach the Mongo filter, and only whitelisted paths reach .sort().
 * Pure query building — no database.
 */
const kybListQuery = require("../../middleware/kybListQuery");
const { build } = kybListQuery;

describe("filter whitelist", () => {
  test("maps company facets onto their document paths", () => {
    const { filter } = build("company", {
      review_status: "approved",
      entity_type: "proprietary_limited",
      status: "active",
      country: "Australia",
      reg: " 123456789 ",
    });
    expect(filter).toEqual({
      review_status: "approved",
      "general_information.entity_type": "proprietary_limited",
      "general_information.status": "active",
      "general_information.country_of_incorporation": "Australia",
      "general_information.registration_number": "123456789",
    });
  });

  test("maps trust facets onto their document paths", () => {
    const { filter } = build("trust", {
      review_status: "in_review",
      trust_type: "self_managed_super_fund",
      country: "Australia",
      abn: "51824753556",
    });
    expect(filter).toEqual({
      review_status: "in_review",
      "trust_details.trust_type.selected_type": "self_managed_super_fund",
      "trust_details.country_of_establishment": "Australia",
      "trust_details.trust_type.self_managed_super_fund.abn": "51824753556",
    });
  });

  test("ignores unknown params — they must never become filter keys", () => {
    // This is the whole reason for not using generic advancedResults: there,
    // any leftover query param lands in model.find().
    const { filter } = build("company", {
      "general_information.legal_name": "Acme",
      $where: "1==1",
      password: "x",
      review_status: { $ne: null },
      nonsense: "y",
    });
    // review_status is whitelisted but an object value is stringified, so it
    // can never smuggle an operator through.
    expect(Object.keys(filter)).toEqual(["review_status"]);
    expect(typeof filter.review_status).toBe("string");
    expect(filter.$where).toBeUndefined();
  });

  test("blank / null-ish values do not become filters that match nothing", () => {
    const { filter } = build("company", { country: "", review_status: "null", uid: undefined, status: null });
    expect(filter).toEqual({});
  });

  test("sequence is numeric, and junk never reaches the query as NaN", () => {
    expect(build("company", { sequence: "42" }).filter.sequence).toBe(42);
    expect(build("company", { sequence: "abc" }).filter).toEqual({});
  });
});

describe("search", () => {
  test("company search is an $or across name, trading name, reg no, uid and identifiers", () => {
    const { filter } = build("company", { search: "acme" });
    expect(filter.$or.map((c) => Object.keys(c)[0])).toEqual([
      "general_information.legal_name",
      "general_information.trading_names",
      "general_information.registration_number",
      "uid",
      "identifiers.value",
    ]);
    expect(filter.$or[0]["general_information.legal_name"]).toBeInstanceOf(RegExp);
  });

  test("trust search covers the trust name and the uid", () => {
    const { filter } = build("trust", { search: "family" });
    expect(filter.$or.map((c) => Object.keys(c)[0])).toEqual(["trust_details.full_trust_name", "uid"]);
  });

  test("regex metacharacters are escaped — a literal, not a pattern", () => {
    const { filter } = build("company", { search: "A+B (Holdings)" });
    const rx = filter.$or[0]["general_information.legal_name"];
    expect(rx.test("A+B (Holdings) Pty Ltd")).toBe(true);
    expect(rx.test("AAAB Holdings")).toBe(false); // would match if "+" were a quantifier
  });
});

describe("sort whitelist", () => {
  test("accepts whitelisted fields in both directions", () => {
    expect(build("company", { sort: "general_information.legal_name" }).sort).toBe("general_information.legal_name");
    expect(build("company", { sort: "-review_status" }).sort).toBe("-review_status");
    expect(build("trust", { sort: "-trust_details.full_trust_name" }).sort).toBe("-trust_details.full_trust_name");
  });

  test("rejects anything else, falling back to newest-first", () => {
    ["companyName", "ubos", "{}", "-__proto__", "general_information.contact_email"].forEach((bad) => {
      expect(build("company", { sort: bad }).sort).toBe("-createdAt");
    });
  });

  test("a company-only sort field is not accepted for trusts", () => {
    expect(build("trust", { sort: "general_information.legal_name" }).sort).toBe("-createdAt");
  });
});

describe("pagination", () => {
  test("defaults to page 1 / 25", () => {
    expect(build("company", {})).toMatchObject({ page: 1, limit: 25, skip: 0 });
  });

  test("computes skip and caps the page size", () => {
    expect(build("company", { page: "3", limit: "10" })).toMatchObject({ page: 3, limit: 10, skip: 20 });
    expect(build("company", { limit: "100000" }).limit).toBe(200);
    expect(build("company", { page: "-5", limit: "0" })).toMatchObject({ page: 1, limit: 25 });
  });
});

describe("middleware wiring", () => {
  test("attaches req.kybQuery and calls next once", () => {
    const req = { query: { search: "acme", page: "2" } };
    const next = jest.fn();
    kybListQuery("company")(req, {}, next);
    expect(req.kybQuery).toMatchObject({ page: 2, sort: "-createdAt" });
    expect(req.kybQuery.filter.$or).toHaveLength(5);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
