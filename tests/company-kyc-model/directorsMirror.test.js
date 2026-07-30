/**
 * CompanyKyc KYB Phase-1 registers + directors-mirror pre-save hook (docs/75).
 *
 * appointments[] is authoritative once populated; this hook mirrors its
 * director rows into the legacy directors_beneficial_owner.directors[] on
 * every save, so no writer has to remember to do it by hand. These tests pin
 * the exact non-destructive rules, and also validate that the full register
 * set (identifiers, appointments, share_capital, shareholders,
 * related_entities, name_history, ubos virtual) persists correctly.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let CompanyKyc;

// directors_beneficial_owner.directors[] has no { _id: false }, so Mongoose
// stamps each entry with an _id — strip it before comparing.
const strip = (arr) => arr.map(({ given_name, surname }) => ({ given_name, surname }));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  CompanyKyc = require("../../models/CompanyKyc");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test("mirrors only director-role appointments, ignoring other roles", async () => {
  const doc = await CompanyKyc.create({
    general_information: { legal_name: "Mirror Test Pty Ltd" },
    appointments: [
      { role: "director", given_name: "Ben", surname: "Brockliss" },
      { role: "secretary", given_name: "Matt", surname: "Pook" },
      { role: "director", given_name: "Jane", surname: "Doe" },
    ],
  });
  expect(strip(doc.directors_beneficial_owner.directors)).toEqual([
    { given_name: "Ben", surname: "Brockliss" },
    { given_name: "Jane", surname: "Doe" },
  ]);
  expect(doc.directors_beneficial_owner.number_of_directors).toBe(2);
});

test("client-sent directors_beneficial_owner.directors is overwritten by the mirror, not merged", async () => {
  const doc = await CompanyKyc.create({
    general_information: { legal_name: "Overwrite Test Pty Ltd" },
    appointments: [{ role: "director", given_name: "Real", surname: "Director" }],
    directors_beneficial_owner: {
      directors: [{ given_name: "Forged", surname: "Entry" }],
    },
  });
  expect(strip(doc.directors_beneficial_owner.directors)).toEqual([
    { given_name: "Real", surname: "Director" },
  ]);
});

test("appointments with no director-role rows does not clear an existing directors[] (non-destructive)", async () => {
  const doc = await CompanyKyc.create({
    general_information: { legal_name: "No Directors Yet Pty Ltd" },
    directors_beneficial_owner: {
      directors: [{ given_name: "Legacy", surname: "Entry" }],
    },
    appointments: [{ role: "secretary", given_name: "Matt", surname: "Pook" }],
  });
  expect(strip(doc.directors_beneficial_owner.directors)).toEqual([
    { given_name: "Legacy", surname: "Entry" },
  ]);
});

test("pre-Phase-1 record with no appointments at all is untouched", async () => {
  const doc = await CompanyKyc.create({
    general_information: { legal_name: "Legacy Only Pty Ltd" },
    directors_beneficial_owner: {
      directors: [{ given_name: "Old", surname: "Record" }],
    },
  });
  expect(strip(doc.directors_beneficial_owner.directors)).toEqual([
    { given_name: "Old", surname: "Record" },
  ]);
  expect(doc.appointments).toEqual([]);
});

test("full Phase-1 register set persists and cross-cutting virtuals/hooks work (Layer 8 fixture)", async () => {
  const doc = await CompanyKyc.create({
    general_information: {
      legal_name: "Layer 8 Networks Pty Ltd",
      registration_number: "626832559",
      country_of_incorporation: "Australia",
      industry: "Digital currency exchange (VASP)",
      entity_type: "proprietary_limited",
      registration_date: new Date("2018-06-15"),
      status: "active",
      class_subclass: "Limited By Shares · Proprietary",
    },
    identifiers: [{ id_type: "acn", value: "626 832 559", jurisdiction: "Australia" }],
    appointments: [
      {
        role: "director",
        given_name: "Benjamin",
        surname: "Brockliss",
        date_appointed: new Date("2023-10-26"),
        date_of_birth: new Date("1988-03-12"),
        birth_place: "Melbourne, VIC",
        residential_address: {
          street: "14 Riverside Ave",
          suburb: "Richmond",
          state: "VIC",
          postcode: "3121",
          country: "Australia",
        },
        screening_status: "pending",
      },
    ],
    directors_beneficial_owner: {
      beneficial_owners: [
        { full_name: "J Smith", ownership_percent: 40, control_type: "ownership" },
      ],
    },
    share_capital: [
      { security_class: "Ordinary", amount_issued: 20, total_paid: 20, total_unpaid: 0, voting: true },
    ],
    shareholders: [
      {
        holder_name: "CF Offshore Holdings LLC",
        units_held: 20,
        percent_held: 100,
        beneficially_held: false,
        fully_paid: true,
      },
    ],
    related_entities: [
      { relation: "parent", name: "CF Offshore Holdings LLC", percent_interest: 100, jurisdiction: "Delaware, US" },
    ],
  });

  const fresh = await CompanyKyc.findById(doc._id).lean();
  expect(fresh.general_information.class_subclass).toBe("Limited By Shares · Proprietary");
  expect(fresh.identifiers[0].value).toBe("626 832 559");
  expect(fresh.share_capital[0].total_paid).toBe(20);
  expect(fresh.shareholders[0].fully_paid).toBe(true);
  expect(fresh.asic_filings).toBeUndefined(); // standing decision — never re-add
  expect(fresh.general_information.asic_document_no).toBeUndefined();
  expect(fresh.entity_profile).toBeUndefined(); // merged into general_information, docs/65 Step 22

  const full = await CompanyKyc.findById(doc._id);
  expect(full.ubos).toHaveLength(1); // 40% ownership clears the 25% test
  expect(full.name_history).toHaveLength(1);
  expect(strip(full.directors_beneficial_owner.directors)).toEqual([
    { given_name: "Benjamin", surname: "Brockliss" },
  ]);
});

test("re-save after adding a new director appointment updates the mirror", async () => {
  const doc = await CompanyKyc.create({
    general_information: { legal_name: "Update Test Pty Ltd" },
    appointments: [{ role: "director", given_name: "First", surname: "Director" }],
  });
  expect(doc.directors_beneficial_owner.directors).toHaveLength(1);

  doc.appointments.push({ role: "director", given_name: "Second", surname: "Director" });
  await doc.save();

  const fresh = await CompanyKyc.findById(doc._id).lean();
  expect(strip(fresh.directors_beneficial_owner.directors)).toEqual([
    { given_name: "First", surname: "Director" },
    { given_name: "Second", surname: "Director" },
  ]);
  expect(fresh.directors_beneficial_owner.number_of_directors).toBe(2);
});
