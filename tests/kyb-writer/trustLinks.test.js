/**
 * Trust / Nominee / Minor pack (docs/65 Step 43; the entity-level
 * entity_type="trust" branch this originally also pinned was removed in
 * Step 45 — Trust is no longer an entity_type option, see the model/wizard
 * comments for why).
 *
 * Pins: shareholders with beneficially_held=false requiring a resolved
 * beneficial_arrangement (trust/nominee/minor); a "trust" arrangement
 * getting its own companion TrustKyc linked via the existing
 * holder_model/holder_entity polymorphic ref, independently per shareholder
 * row (docs/65 Step 44).
 *
 * Controllers are invoked directly (asyncHandler does not return the handler
 * promise; results are awaited via the mocked res.json/next).
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let controller;
let CompanyKyc;
let TrustKyc;

function call(handler, { user = {}, body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
      },
    };
    const next = (err) => resolve({ error: err });
    handler({ user, body, params, query }, res, next);
  });
}

const reviewer = {
  _id: new mongoose.Types.ObjectId(),
  userType: "client",
  role: "client",
  name: "Reviewer One",
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  controller = require("../../controllers/customerController");
  CompanyKyc = require("../../models/CompanyKyc");
  TrustKyc = require("../../models/TrustKyc");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("entity_type no longer accepts \"trust\" (docs/65 Step 45)", () => {
  test("entity_type: \"trust\" is rejected by the model's enum validator", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: { general_information: { legal_name: "No Longer A Trust Pty", entity_type: "trust" } },
    });
    expect(res.error?.name).toBe("ValidationError");
  });
});

describe("shareholders: beneficially_held=false requires a resolved arrangement", () => {
  test("rejects with no beneficial_arrangement.arrangement_type", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Nominee Co" },
        shareholders: [{ holder_name: "Jane Doe", beneficially_held: false }],
      },
    });
    expect(res.error?.statusCode).toBe(400);
  });

  test("nominee arrangement requires a named beneficiary; valid one persists with no TrustKyc created", async () => {
    const missing = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Nominee Co 2" },
        shareholders: [
          { holder_name: "Jane Doe", beneficially_held: false, beneficial_arrangement: { arrangement_type: "nominee" } },
        ],
      },
    });
    expect(missing.error?.statusCode).toBe(400);

    const before = await TrustKyc.countDocuments();
    const ok = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Nominee Co 3" },
        shareholders: [
          {
            holder_name: "Jane Doe",
            beneficially_held: false,
            beneficial_arrangement: {
              arrangement_type: "nominee",
              beneficiary_type: "individual",
              beneficiary: { full_name: "Mark Beneficiary" },
            },
          },
        ],
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.shareholders[0].beneficial_arrangement.beneficiary.full_name).toBe("Mark Beneficiary");
    expect(ok.body.data.shareholders[0].holder_model).toBeFalsy();
    expect(await TrustKyc.countDocuments()).toBe(before);
  });

  test("minor arrangement stores date_of_birth", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Minor Holder Co" },
        shareholders: [
          {
            holder_name: "Parent As Trustee For Child",
            beneficially_held: false,
            beneficial_arrangement: {
              arrangement_type: "minor",
              beneficiary_type: "individual",
              beneficiary: { full_name: "Tiny Kid", date_of_birth: "2018-01-01" },
            },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.shareholders[0].beneficial_arrangement.arrangement_type).toBe("minor");
    expect(new Date(res.body.data.shareholders[0].beneficial_arrangement.beneficiary.date_of_birth).getUTCFullYear()).toBe(2018);
  });

  // docs/65 Step 66 — the old shape had one free-text name field, so a
  // nominee holding for a COMPANY could only be recorded as a string.
  test("nominee for an entity beneficiary is named by entity_name", async () => {
    const missing = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Entity Beneficiary Co 1" },
        shareholders: [
          {
            holder_name: "Custodian Nominees Ltd",
            beneficially_held: false,
            // full_name doesn't satisfy an entity beneficiary — entity_name does.
            beneficial_arrangement: {
              arrangement_type: "nominee",
              beneficiary_type: "entity",
              beneficiary: { full_name: "Wrong Field Pty Ltd" },
            },
          },
        ],
      },
    });
    expect(missing.error?.statusCode).toBe(400);

    const ok = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Entity Beneficiary Co 2" },
        shareholders: [
          {
            holder_name: "Custodian Nominees Ltd",
            beneficially_held: false,
            beneficial_arrangement: {
              arrangement_type: "nominee",
              beneficiary_type: "entity",
              beneficiary: { entity_name: "Beneficial Holdings Pty Ltd" },
            },
          },
        ],
      },
    });
    expect(ok.status).toBe(201);
    const ba = ok.body.data.shareholders[0].beneficial_arrangement;
    expect(ba.beneficiary_type).toBe("entity");
    expect(ba.beneficiary.entity_name).toBe("Beneficial Holdings Pty Ltd");
  });

  test("a person beneficiary may be given as split name parts instead of full_name", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Split Name Co" },
        shareholders: [
          {
            holder_name: "Jane Doe",
            beneficially_held: false,
            beneficial_arrangement: {
              arrangement_type: "nominee",
              beneficiary_type: "individual",
              beneficiary: { first_name: "Mark", middle_name: "J", last_name: "Beneficiary" },
            },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.shareholders[0].beneficial_arrangement.beneficiary.last_name).toBe("Beneficiary");
  });

  test("trust arrangement requires trust.trust_details.full_trust_name and links a companion TrustKyc via holder_entity", async () => {
    const missing = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Trust Holder Co" },
        shareholders: [
          { holder_name: "ATF Doe Family Trust", beneficially_held: false, beneficial_arrangement: { arrangement_type: "trust" } },
        ],
      },
    });
    expect(missing.error?.statusCode).toBe(400);

    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Trust Holder Co 2" },
        shareholders: [
          {
            holder_name: "ATF Doe Family Trust",
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            trust: {
              trust_details: { full_trust_name: "Doe Family Trust", trust_type: { selected_type: "unregulated_trust" } },
            },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const sh = res.body.data.shareholders[0];
    expect(sh.holder_model).toBe("TrustKyc");
    expect(sh.holder_entity).toBeDefined();
    const linkedTrust = await TrustKyc.findById(sh.holder_entity);
    expect(linkedTrust.trust_details.full_trust_name).toBe("Doe Family Trust");
  });

  test("a trust arrangement persists every TrustKyc property the wizard now captures (docs/65 Step 46)", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Full Capture Trust Holder Co" },
        shareholders: [
          {
            holder_name: "ATF Everything Family Trust",
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            trust: {
              trust_details: {
                full_trust_name: "Everything Family Trust",
                country_of_establishment: "Australia",
                settlor_name: "Alex Settlor",
                industry: "Digital currency exchange (VASP)",
                nature_of_business: "Holding",
                annual_income: "$500,000 - $1,000,000",
                estimated_trading_volume: "$50,000 per month",
                principal_address: { address: "1 Main St", suburb: "Box Hill", state: "VIC", postcode: "3128", country: "Australia" },
                postal_address: { different_from_principal: true, address: "PO Box 9", suburb: "Melbourne", state: "VIC", postcode: "3000", country: "Australia" },
                contact_information: { email: "trustee@example.com", phone: "0400000000", website: "https://example.com" },
                trust_type: {
                  selected_type: "unregulated_trust",
                  unregulated_trust: { registration_number: "REG123", type_description: "Discretionary trust", is_registered: true, regulatory_body: "ASIC" },
                },
                account_purpose: { digital_currency_exchange: true, peer_to_peer: false, fx: true, other: false },
              },
              individual_trustees: {
                trustees: [
                  { full_name: "John Trustee", date_of_birth: "1980-01-01", residential_address: { street: "2 Trustee Rd", suburb: "Richmond", state: "VIC", postcode: "3121", country: "Australia" } },
                ],
                has_additional_trustees: true,
              },
              company_trustees: {
                has_company_trustees: true,
                company_details: [{ company_name: "Trustee Co Pty Ltd", registration_number: "ACN123456" }],
              },
              beneficiaries: [{ named_beneficiaries: "Jane Smith", beneficiary_classes: "Grandchildren" }],
              documents: [{ name: "trust-deed.pdf", url: "https://files.example.com/trust-deed.pdf", mimeType: "application/pdf", docType: "Trust Deed" }],
            },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const sh = res.body.data.shareholders[0];
    const linked = await TrustKyc.findById(sh.holder_entity);

    expect(linked.trust_details.industry).toBe("Digital currency exchange (VASP)");
    expect(linked.trust_details.nature_of_business).toBe("Holding");
    expect(linked.trust_details.annual_income).toBe("$500,000 - $1,000,000");
    expect(linked.trust_details.estimated_trading_volume).toBe("$50,000 per month");
    expect(linked.trust_details.principal_address.suburb).toBe("Box Hill");
    expect(linked.trust_details.postal_address.different_from_principal).toBe(true);
    expect(linked.trust_details.postal_address.suburb).toBe("Melbourne");
    expect(linked.trust_details.contact_information.email).toBe("trustee@example.com");
    expect(linked.trust_details.trust_type.unregulated_trust.type_description).toBe("Discretionary trust");
    expect(linked.trust_details.trust_type.unregulated_trust.is_registered).toBe(true);
    expect(linked.trust_details.trust_type.unregulated_trust.regulatory_body).toBe("ASIC");
    expect(linked.trust_details.account_purpose.digital_currency_exchange).toBe(true);
    expect(linked.trust_details.account_purpose.fx).toBe(true);
    expect(linked.individual_trustees.trustees[0].residential_address.suburb).toBe("Richmond");
    expect(linked.individual_trustees.has_additional_trustees).toBe(true);
    expect(linked.company_trustees.has_company_trustees).toBe(true);
    expect(linked.company_trustees.company_details[0].company_name).toBe("Trustee Co Pty Ltd");
    expect(linked.documents).toHaveLength(1);
    expect(linked.documents[0].url).toBe("https://files.example.com/trust-deed.pdf");
  });

  test("the Step 55 schema expansion persists: identification, settlor, controllers, AML, richer beneficiaries/company trustees/documents", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Expanded Trust Holder Co" },
        shareholders: [
          {
            holder_name: "ATF Expanded Family Trust",
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            trust: {
              trust_details: {
                full_trust_name: "Expanded Family Trust",
                governing_law: "VIC",
                settled_sum: { amount: 10, currency: "aud" },
                trust_identification: {
                  abn: "11222333444",
                  acn: "222333444",
                  registration_number: "TR-0099",
                  tfn: "123456789",
                  tax_residency: "Australia",
                  date_established: "2020-03-01",
                  date_of_deed: "2024-11-07",
                },
              },
              settlor: {
                full_name: "Yang Li",
                date_of_birth: "1970-05-05",
                residential_address: { street: "7 Settlor St", suburb: "Bentleigh", state: "VIC", postcode: "3204", country: "Australia" },
                country_of_residence: "Australia",
                is_company: false,
              },
              company_trustees: {
                has_company_trustees: true,
                company_details: [
                  {
                    company_name: "STRIKEO PTY LTD",
                    registration_number: "682153091",
                    abn: "99888777666",
                    registered_address: { street: "1 Corp Rd", suburb: "Docklands", state: "VIC", postcode: "3008", country: "Australia" },
                    directors: [{ full_name: "Dana Director" }, { full_name: "Sam Second" }],
                  },
                ],
              },
              controllers: {
                authorised_representatives: [{ full_name: "Rita Rep", role: "Accountant" }],
                controlling_persons: [{ full_name: "Pat Appointor", role: "appointor", pep_status: "cleared", sanctions_status: "cleared" }],
              },
              appointors: ["Pat Appointor"],
              aml_kyc: { source_of_funds: "Business income", source_of_wealth: "Accumulated profits" },
              beneficiaries: [
                { named_beneficiaries: "Kid One", beneficiary_classes: "Children", beneficiary_type: "individual", beneficial_interest_percent: 40, date_of_birth: "2010-02-02" },
              ],
              documents: [
                { name: "deed.pdf", url: "https://files.example.com/deed.pdf", mimeType: "application/pdf", docType: "Trust Deed", expiry_date: "2030-01-01" },
              ],
            },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const linked = await TrustKyc.findById(res.body.data.shareholders[0].holder_entity);

    const ti = linked.trust_details.trust_identification;
    expect(ti.abn).toBe("11222333444");
    expect(ti.acn).toBe("222333444");
    expect(ti.registration_number).toBe("TR-0099");
    expect(ti.tfn).toBe("123456789");
    expect(ti.tax_residency).toBe("Australia");
    // Dates moved from trust_identification up to trust_details in Step 59
    // (a date isn't an identifier). Sent here on the legacy path, so this
    // also proves the model promotes it rather than stranding it.
    expect(new Date(linked.trust_details.date_of_deed).getUTCFullYear()).toBe(2024);
    expect(linked.trust_details.governing_law).toBe("VIC");
    // settled_sum: the deed's nominal constituting amount; currency is
    // normalised to upper case by the schema setter.
    expect(linked.trust_details.settled_sum.amount).toBe(10);
    expect(linked.trust_details.settled_sum.currency).toBe("AUD");

    expect(linked.settlor.full_name).toBe("Yang Li");
    expect(linked.settlor.is_company).toBe(false);
    expect(linked.settlor.residential_address.suburb).toBe("Bentleigh");
    expect(linked.settlor.country_of_residence).toBe("Australia");

    const ct = linked.company_trustees.company_details[0];
    expect(ct.abn).toBe("99888777666");
    expect(ct.registered_address.suburb).toBe("Docklands");
    expect(ct.directors.map((d) => d.full_name)).toEqual(["Dana Director", "Sam Second"]);

    expect(linked.controllers.controlling_persons[0].role).toBe("appointor");
    expect(linked.controllers.controlling_persons[0].pep_status).toBe("cleared");
    expect(linked.controllers.authorised_representatives[0].full_name).toBe("Rita Rep");
    expect(linked.appointors).toEqual(["Pat Appointor"]);

    expect(linked.aml_kyc.source_of_funds).toBe("Business income");
    expect(linked.aml_kyc.source_of_wealth).toBe("Accumulated profits");

    expect(linked.beneficiaries[0].beneficiary_type).toBe("individual");
    expect(linked.beneficiaries[0].beneficial_interest_percent).toBe(40);
    expect(new Date(linked.beneficiaries[0].date_of_birth).getUTCFullYear()).toBe(2010);

    expect(linked.documents[0]._id).toBeDefined(); // rows are individually referenceable (Step 55)
    expect(new Date(linked.documents[0].expiry_date).getUTCFullYear()).toBe(2030);
  });

  test("review workflow fields are server-owned — a client payload can't set them", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Forged Trust Review Co" },
        shareholders: [
          {
            holder_name: "ATF Forge Trust",
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            trust: {
              trust_details: { full_trust_name: "Forge Trust" },
              review_status: "approved",
              review_history: [{ status: "approved", note: "self-approved" }],
              next_review_date: "2099-01-01",
            },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const linked = await TrustKyc.findById(res.body.data.shareholders[0].holder_entity);
    expect(linked.review_status).toBeUndefined();
    expect(linked.review_history).toHaveLength(0);
    expect(linked.next_review_date).toBeUndefined();
  });

  test("multiple shareholders each with a trust arrangement get distinct, independently-linked TrustKyc records", async () => {
    const before = await TrustKyc.countDocuments();
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Multi Trust Holder Co" },
        shareholders: [
          {
            holder_name: "ATF Doe Family Trust",
            units_held: 60,
            percent_held: 60,
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            trust: { trust_details: { full_trust_name: "Doe Family Trust", trust_type: { selected_type: "unregulated_trust" } } },
          },
          {
            holder_name: "ATF Ray Family Trust",
            units_held: 40,
            percent_held: 40,
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            trust: { trust_details: { full_trust_name: "Ray Family Trust", trust_type: { selected_type: "unregulated_trust" } } },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const [sh0, sh1] = res.body.data.shareholders;
    expect(sh0.holder_model).toBe("TrustKyc");
    expect(sh1.holder_model).toBe("TrustKyc");
    expect(String(sh0.holder_entity)).not.toBe(String(sh1.holder_entity));
    expect(await TrustKyc.countDocuments()).toBe(before + 2);

    const trust0 = await TrustKyc.findById(sh0.holder_entity);
    const trust1 = await TrustKyc.findById(sh1.holder_entity);
    expect(trust0.trust_details.full_trust_name).toBe("Doe Family Trust");
    expect(trust1.trust_details.full_trust_name).toBe("Ray Family Trust");

    // Re-save (edit) with both rows referencing their already-linked TrustKyc
    // by id (as the wizard would send back on edit) — each row must update
    // its OWN linked doc, not the other's, and no new TrustKyc may be created.
    const updated = await call(controller.updateCompanyKyc, {
      user: reviewer,
      params: { id: res.body.data._id },
      body: {
        general_information: { legal_name: "Multi Trust Holder Co" },
        shareholders: [
          {
            holder_name: "ATF Doe Family Trust",
            units_held: 60,
            percent_held: 60,
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            holder_model: "TrustKyc",
            holder_entity: String(sh0.holder_entity),
            trust: { id: String(sh0.holder_entity), trust_details: { full_trust_name: "Doe Family Trust (Updated)", trust_type: { selected_type: "unregulated_trust" } } },
          },
          {
            holder_name: "ATF Ray Family Trust",
            units_held: 40,
            percent_held: 40,
            beneficially_held: false,
            beneficial_arrangement: { arrangement_type: "trust" },
            holder_model: "TrustKyc",
            holder_entity: String(sh1.holder_entity),
            trust: { id: String(sh1.holder_entity), trust_details: { full_trust_name: "Ray Family Trust (Updated)", trust_type: { selected_type: "unregulated_trust" } } },
          },
        ],
      },
    });
    expect(updated.status).toBe(200);
    expect(await TrustKyc.countDocuments()).toBe(before + 2);
    expect((await TrustKyc.findById(sh0.holder_entity)).trust_details.full_trust_name).toBe("Doe Family Trust (Updated)");
    expect((await TrustKyc.findById(sh1.holder_entity)).trust_details.full_trust_name).toBe("Ray Family Trust (Updated)");
  });

  test("beneficially_held=true (default case) needs no arrangement at all", async () => {
    const res = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        general_information: { legal_name: "Plain Holder Co" },
        shareholders: [{ holder_name: "Jane Doe", beneficially_held: true }],
      },
    });
    expect(res.status).toBe(201);
  });
});
