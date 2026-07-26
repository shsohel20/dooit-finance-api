/**
 * Phase-2 workflow pack (docs/65 Step 31).
 *
 * Pins the KYB review lifecycle (server-owned review_status + review_history,
 * decision endpoint semantics mirroring updateCustomerKycStatus), the audit
 * trail (service "kyb" AuditLog entries with per-register diffs), and the
 * company documents endpoints (rows now carry _id; add/remove with dedup).
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
let AuditLog;

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

const minimal = (name, reg) => ({
  general_information: { legal_name: name, registration_number: reg },
});

const createCompany = (name, reg) =>
  call(controller.createCompanyKyc, { user: reviewer, body: minimal(name, reg) });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  controller = require("../../controllers/customerController");
  CompanyKyc = require("../../models/CompanyKyc");
  AuditLog = require("../../models/AuditLog");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("review lifecycle (server-owned)", () => {
  test("create lands in_review with an attributed initial history entry", async () => {
    const r = await createCompany("Lifecycle Pty Ltd", "700100700");
    expect(r.status).toBe(201);
    const doc = await CompanyKyc.findById(r.body.data._id).lean();
    expect(doc.review_status).toBe("in_review");
    expect(doc.review_history).toHaveLength(1);
    expect(doc.review_history[0].status).toBe("in_review");
    expect(String(doc.review_history[0].changedBy)).toBe(String(reviewer._id));
  });

  test("forged review_status/review_history in the create body are ignored", async () => {
    const r = await call(controller.createCompanyKyc, {
      user: reviewer,
      body: {
        ...minimal("Forged Review Pty Ltd", "700200700"),
        review_status: "approved",
        review_history: [{ status: "approved", note: "self-approved" }],
      },
    });
    expect(r.status).toBe(201);
    const doc = await CompanyKyc.findById(r.body.data._id).lean();
    expect(doc.review_status).toBe("in_review");
    expect(doc.review_history).toHaveLength(1);
    expect(doc.review_history[0].note).toBe("Submitted for review");
  });

  test("approve transition: 200, status + appended history + prevStatus in response", async () => {
    const created = await createCompany("Approve Me Pty Ltd", "700300700");
    const id = created.body.data._id;

    const r = await call(controller.updateCompanyReviewStatus, {
      user: reviewer,
      params: { id },
      body: { status: "approved" },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body.data.prevStatus).toBe("in_review");
    expect(r.body.data.review_status).toBe("approved");

    const doc = await CompanyKyc.findById(id).lean();
    expect(doc.review_status).toBe("approved");
    expect(doc.review_history).toHaveLength(2);
    expect(doc.review_history[1].note).toBe("Approved by reviewer");
  });

  test("same-status transition -> 400; invalid status -> 400; unknown id -> 404", async () => {
    const created = await createCompany("No-Op Pty Ltd", "700400700");
    const id = created.body.data._id;

    const same = await call(controller.updateCompanyReviewStatus, {
      user: reviewer,
      params: { id },
      body: { status: "in_review" },
    });
    expect(same.error?.statusCode).toBe(400);

    const invalid = await call(controller.updateCompanyReviewStatus, {
      user: reviewer,
      params: { id },
      body: { status: "banana" },
    });
    expect(invalid.error?.statusCode).toBe(400);

    const missing = await call(controller.updateCompanyReviewStatus, {
      user: reviewer,
      params: { id: new mongoose.Types.ObjectId().toString() },
      body: { status: "approved" },
    });
    expect(missing.error?.statusCode).toBe(404);
  });

  test("escalate/decline require a note; escalate with note succeeds", async () => {
    const created = await createCompany("Escalate Me Pty Ltd", "700500700");
    const id = created.body.data._id;

    const bare = await call(controller.updateCompanyReviewStatus, {
      user: reviewer,
      params: { id },
      body: { status: "escalated" },
    });
    expect(bare.error?.statusCode).toBe(400);

    const withNote = await call(controller.updateCompanyReviewStatus, {
      user: reviewer,
      params: { id },
      body: { status: "escalated", note: "Escalated to SMR from KYB review" },
    });
    expect(withNote.status).toBe(200);
    const doc = await CompanyKyc.findById(id).lean();
    expect(doc.review_status).toBe("escalated");
    expect(doc.review_history[1].note).toBe("Escalated to SMR from KYB review");
  });
});

describe("audit trail (service 'kyb')", () => {
  test("create writes KYB_CREATED with the company ref and actor", async () => {
    const r = await createCompany("Audited Pty Ltd", "700600700");
    const id = r.body.data._id;

    const entries = await AuditLog.find({ service: "kyb", companyKyc: id }).lean();
    const created = entries.find((e) => e.action === "KYB_CREATED");
    expect(created).toBeDefined();
    expect(created.actorName).toBe("Reviewer One");
    expect(created.afterValue.general_information.legal_name).toBe("Audited Pty Ltd");
  });

  test("update writes KYB_UPDATED with only the changed registers; no-change update writes nothing", async () => {
    const r = await createCompany("Diff Pty Ltd", "700700700");
    const id = r.body.data._id;

    await call(controller.updateCompanyKyc, {
      user: reviewer,
      params: { id },
      body: {
        general_information: {
          legal_name: "Diff Pty Ltd",
          registration_number: "700700700",
          annual_income: "$1M-$5M",
        },
      },
    });

    let updates = await AuditLog.find({
      service: "kyb",
      companyKyc: id,
      action: "KYB_UPDATED",
    }).lean();
    expect(updates).toHaveLength(1);
    expect(updates[0].afterValue.general_information.annual_income).toBe("$1M-$5M");
    // only the changed key is captured — untouched registers aren't in the diff
    expect(updates[0].afterValue.identifiers).toBeUndefined();
    expect(updates[0].beforeValue.general_information).toBeDefined();

    // identical payload again -> no new audit row
    await call(controller.updateCompanyKyc, {
      user: reviewer,
      params: { id },
      body: {
        general_information: {
          legal_name: "Diff Pty Ltd",
          registration_number: "700700700",
          annual_income: "$1M-$5M",
        },
      },
    });
    updates = await AuditLog.find({
      service: "kyb",
      companyKyc: id,
      action: "KYB_UPDATED",
    }).lean();
    expect(updates).toHaveLength(1);
  });

  test("review decision writes KYB_REVIEW_<STATUS>; audit endpoint returns the trail newest-first", async () => {
    const r = await createCompany("Trail Pty Ltd", "700800700");
    const id = r.body.data._id;

    await call(controller.updateCompanyReviewStatus, {
      user: reviewer,
      params: { id },
      body: { status: "approved" },
    });

    const audit = await call(controller.getCompanyKycAudit, {
      user: reviewer,
      params: { id },
    });
    expect(audit.status).toBe(200);
    const actions = audit.body.data.map((e) => e.action);
    expect(actions[0]).toBe("KYB_REVIEW_APPROVED"); // newest first
    expect(actions).toContain("KYB_CREATED");
    expect(audit.body.data[0].beforeValue.review_status).toBe("in_review");

    const missing = await call(controller.getCompanyKycAudit, {
      user: reviewer,
      params: { id: new mongoose.Types.ObjectId().toString() },
    });
    expect(missing.error?.statusCode).toBe(404);
  });
});

describe("company documents", () => {
  test("add attaches rows (now with _id), dedups by url, requires a url", async () => {
    const r = await createCompany("Docs Pty Ltd", "700900700");
    const id = r.body.data._id;

    const added = await call(controller.addCompanyDocuments, {
      user: reviewer,
      params: { id },
      body: {
        documents: [
          { name: "Constitution.pdf", url: "https://files.test/constitution.pdf", docType: "constitution", category: "charter_formation" },
        ],
      },
    });
    expect(added.status).toBe(200);
    expect(added.body.data).toHaveLength(1);
    expect(added.body.data[0]._id).toBeDefined(); // rows are referenceable now

    const dup = await call(controller.addCompanyDocuments, {
      user: reviewer,
      params: { id },
      body: { documents: [{ name: "Again", url: "https://files.test/constitution.pdf" }] },
    });
    expect(dup.error?.statusCode).toBe(400);

    const noUrl = await call(controller.addCompanyDocuments, {
      user: reviewer,
      params: { id },
      body: { documents: [{ name: "No URL" }] },
    });
    expect(noUrl.error?.statusCode).toBe(400);
  });

  test("remove works by docId and by url; audit rows written for both operations", async () => {
    const r = await createCompany("Doc Remove Pty Ltd", "701000700");
    const id = r.body.data._id;

    await call(controller.addCompanyDocuments, {
      user: reviewer,
      params: { id },
      body: {
        documents: [
          { name: "A.pdf", url: "https://files.test/a.pdf" },
          { name: "B.pdf", url: "https://files.test/b.pdf" },
        ],
      },
    });

    const doc = await CompanyKyc.findById(id).select("documents").lean();
    const removeById = await call(controller.removeCompanyDocument, {
      user: reviewer,
      params: { id },
      query: { docId: String(doc.documents[0]._id) },
    });
    expect(removeById.status).toBe(200);
    expect(removeById.body.data).toHaveLength(1);

    const removeByUrl = await call(controller.removeCompanyDocument, {
      user: reviewer,
      params: { id },
      query: { url: "https://files.test/b.pdf" },
    });
    expect(removeByUrl.status).toBe(200);
    expect(removeByUrl.body.data).toHaveLength(0);

    const gone = await call(controller.removeCompanyDocument, {
      user: reviewer,
      params: { id },
      query: { url: "https://files.test/b.pdf" },
    });
    expect(gone.error?.statusCode).toBe(404);

    const actions = (
      await AuditLog.find({ service: "kyb", companyKyc: id }).lean()
    ).map((e) => e.action);
    expect(actions).toContain("KYB_DOCUMENT_ADDED");
    expect(actions.filter((a) => a === "KYB_DOCUMENT_REMOVED")).toHaveLength(2);
  });

  test("updateCompanyDocument sets verification_status/expiry_date, validates input, audits", async () => {
    const r = await createCompany("Doc Verify Pty Ltd", "701100700");
    const id = r.body.data._id;

    await call(controller.addCompanyDocuments, {
      user: reviewer,
      params: { id },
      body: { documents: [{ name: "Constitution.pdf", url: "https://files.test/verify.pdf" }] },
    });
    const stored = await CompanyKyc.findById(id).select("documents").lean();
    const docId = String(stored.documents[0]._id);

    const invalid = await call(controller.updateCompanyDocument, {
      user: reviewer,
      params: { id, docId },
      body: { verification_status: "approved" },
    });
    expect(invalid.error?.statusCode).toBe(400);

    const empty = await call(controller.updateCompanyDocument, {
      user: reviewer,
      params: { id, docId },
      body: {},
    });
    expect(empty.error?.statusCode).toBe(400);

    const verified = await call(controller.updateCompanyDocument, {
      user: reviewer,
      params: { id, docId },
      body: { verification_status: "verified", expiry_date: "2027-01-01" },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.data.verification_status).toBe("verified");
    expect(new Date(verified.body.data.expiry_date).getUTCFullYear()).toBe(2027);

    const missingDoc = await call(controller.updateCompanyDocument, {
      user: reviewer,
      params: { id, docId: new mongoose.Types.ObjectId().toString() },
      body: { verification_status: "rejected" },
    });
    expect(missingDoc.error?.statusCode).toBe(404);

    const actions = (
      await AuditLog.find({ service: "kyb", companyKyc: id }).lean()
    ).map((e) => e.action);
    expect(actions).toContain("KYB_DOCUMENT_VERIFIED");
  });
});
