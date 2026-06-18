const request  = require("supertest");
const mongoose = require("mongoose");
const { connect, disconnect, clearAll } = require("./setup");

// ── mock auth BEFORE app is required ──────────────────────────────────────────
let mockCurrentUser = null;

jest.mock("../../middleware/auth", () => ({
  protect: (req, _res, next) => {
    if (!mockCurrentUser) {
      return next(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));
    }
    req.user = mockCurrentUser;
    next();
  },
  authorize: (...roles) => (req, _res, next) => {
    if (!req.user) return next(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));
    if (roles.length && !roles.includes(req.user.role))
      return next(Object.assign(new Error("Forbidden"), { statusCode: 403 }));
    next();
  },
}));

// ── mock external I/O ─────────────────────────────────────────────────────────
jest.mock("../../utils/sendEmail",      () => jest.fn().mockResolvedValue(true));
jest.mock("../../utils/rawUserFields",  () => ({
  getRawEmail: jest.fn().mockResolvedValue("alice.smith@dooit.com"),
}));

// ── mock Sumsub service (all external calls) ──────────────────────────────────
const mockEnsure     = jest.fn();
const mockSubmitDocs = jest.fn();
const mockSync       = jest.fn();
const mockTrigger    = jest.fn();

jest.mock("../../services/staffSumsubService", () => ({
  ensureStaffApplicant:     (...a) => mockEnsure(...a),
  submitStaffDocuments:     (...a) => mockSubmitDocs(...a),
  syncStaffApplicantStatus: (...a) => mockSync(...a),
  triggerStaffAmlCheck:     (...a) => mockTrigger(...a),
}));

// ── mock advancedStaffResults (avoid tenant-scoping complexity in tests) ──────
jest.mock("../../middleware/advancedStaffResults", () =>
  (Model) => async (req, res, next) => {
    try {
      const data = await Model.find({}).lean();
      res.advancedResults = { success: true, count: data.length, data };
      next();
    } catch (e) { next(e); }
  },
);

// ── require app AFTER all mocks are registered ────────────────────────────────
const app = require("./app");

// ── shared fixtures ───────────────────────────────────────────────────────────
const adminId = new mongoose.Types.ObjectId();
const ADMIN = {
  _id: adminId, id: adminId, name: "Admin User",
  email: "admin@test.com", role: "admin",
  client: null, branch: {}, permissions: [],
};

function as(user) { mockCurrentUser = user; }
const api = (method, url) => request(app)[method](url);

const BASE_PAYLOAD = () => ({
  personal: {
    role:        "admin",
    firstName:   "Alice",
    lastName:    "Smith",
    dateOfBirth: "1990-05-15",
    nationality: "BGD",
  },
  contact: {
    workEmail:           "alice.smith@dooit.com",
    phone:               "+8801712345678",
    residentialAddress:  "123 Main St, Dhaka",
  },
  employment: {
    startDate:      "2024-01-10",
    department:     "compliance",
    jobTitle:       "kyc_analyst",
    employmentType: "full_time",
  },
});

// Helper: create one staff and return the staff object
async function seedStaff(overrides = {}) {
  as(ADMIN);
  const payload = { ...BASE_PAYLOAD(), ...overrides };
  const res = await api("post", "/api/v1/staff").send(payload);
  if (res.status !== 201) throw new Error(`seedStaff failed: ${JSON.stringify(res.body)}`);
  return res.body.data.staff;
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
beforeAll(async () => { await connect(); });
afterAll(async () => { await disconnect(); });
afterEach(async () => {
  await clearAll();
  mockCurrentUser = null;
  jest.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. CREATE STAFF  POST /api/v1/staff
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /api/v1/staff — createStaff", () => {
  it("201 — creates staff + user and returns both", async () => {
    as(ADMIN);
    const res = await api("post", "/api/v1/staff").send(BASE_PAYLOAD());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.staff._id).toBeDefined();
    expect(res.body.data.staff.personal.firstName).toBe("Alice");
    expect(res.body.data.staff.personal.nationality).toBe("BGD");
    expect(res.body.data.user._id).toBeDefined();
    expect(res.body.data.user.role).toBe("admin");
  });

  it("201 — resolves nationality full name to alpha-3", async () => {
    as(ADMIN);
    const payload = BASE_PAYLOAD();
    payload.personal.nationality = "Bangladesh";
    const res = await api("post", "/api/v1/staff").send(payload);

    expect(res.status).toBe(201);
    expect(res.body.data.staff.personal.nationality).toBe("BGD");
  });

  it("201 — sends welcome email", async () => {
    const sendEmail = require("../../utils/sendEmail");
    as(ADMIN);
    await api("post", "/api/v1/staff").send(BASE_PAYLOAD());

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      subject: expect.stringContaining("Dooit"),
    });
  });

  it("400 — missing personal.role", async () => {
    as(ADMIN);
    const payload = BASE_PAYLOAD();
    delete payload.personal.role;
    const res = await api("post", "/api/v1/staff").send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("400 — missing personal.firstName", async () => {
    as(ADMIN);
    const payload = BASE_PAYLOAD();
    delete payload.personal.firstName;
    const res = await api("post", "/api/v1/staff").send(payload);

    expect(res.status).toBe(400);
  });

  it("400 — missing contact.workEmail", async () => {
    as(ADMIN);
    const payload = BASE_PAYLOAD();
    delete payload.contact.workEmail;
    const res = await api("post", "/api/v1/staff").send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workEmail/i);
  });

  it("400 — invalid email format", async () => {
    as(ADMIN);
    const payload = BASE_PAYLOAD();
    payload.contact.workEmail = "not-an-email";
    const res = await api("post", "/api/v1/staff").send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("400 — unrecognized nationality", async () => {
    as(ADMIN);
    const payload = BASE_PAYLOAD();
    payload.personal.nationality = "Westeros";
    const res = await api("post", "/api/v1/staff").send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nationality/i);
  });

  it("409 — duplicate workEmail on second create", async () => {
    await seedStaff();
    as(ADMIN);
    // second request with identical workEmail
    const res = await api("post", "/api/v1/staff").send(BASE_PAYLOAD());

    expect(res.status).toBe(409);
  });

  it("401 — unauthenticated request", async () => {
    mockCurrentUser = null;
    const res = await api("post", "/api/v1/staff").send(BASE_PAYLOAD());
    expect(res.status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. UPDATE STAFF  PUT /api/v1/staff/:staffId
// ═════════════════════════════════════════════════════════════════════════════
describe("PUT /api/v1/staff/:staffId — updateStaff", () => {
  it("200 — partial update of personal fields", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("put", `/api/v1/staff/${staff._id}`).send({
      personal: { firstName: "Alicia", yearsInCompliance: "5" },
      additionalNotes: "Updated note",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.staff.personal.firstName).toBe("Alicia");
    // lastName untouched
    expect(res.body.data.staff.personal.lastName).toBe("Smith");
  });

  it("200 — resolves updated nationality from full name", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("put", `/api/v1/staff/${staff._id}`).send({
      personal: { nationality: "United Kingdom" },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.staff.personal.nationality).toBe("GBR");
  });

  it("200 — updates employment sub-doc", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("put", `/api/v1/staff/${staff._id}`).send({
      employment: { department: "risk" },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.staff.employment.department).toBe("risk");
    expect(res.body.data.staff.employment.jobTitle).toBe("kyc_analyst"); // unchanged
  });

  it("400 — invalid nationality on update", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("put", `/api/v1/staff/${staff._id}`).send({
      personal: { nationality: "Nowhere" },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nationality/i);
  });

  it("404 — staff not found", async () => {
    as(ADMIN);
    const fakeId = new mongoose.Types.ObjectId();
    const res = await api("put", `/api/v1/staff/${fakeId}`).send({
      personal: { firstName: "Ghost" },
    });

    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. GET SINGLE STAFF  GET /api/v1/staff/:staffId
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /api/v1/staff/:staffId — getStaff", () => {
  it("200 — returns staff with populated fields", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("get", `/api/v1/staff/${staff._id}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(staff._id);
    expect(res.body.data.contact.workEmail).toBe("alice.smith@dooit.com");
  });

  it("404 — unknown id", async () => {
    as(ADMIN);
    const fakeId = new mongoose.Types.ObjectId();
    const res = await api("get", `/api/v1/staff/${fakeId}`);

    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. LIST STAFF  GET /api/v1/staff
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /api/v1/staff — getStaffs", () => {
  it("200 — returns empty list when no staff exist", async () => {
    as(ADMIN);
    const res = await api("get", "/api/v1/staff");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.data).toEqual([]);
  });

  it("200 — returns all staff via advancedResults middleware", async () => {
    await seedStaff();
    // second staff with different email
    const p2 = BASE_PAYLOAD();
    p2.contact.workEmail = "bob.jones@dooit.com";
    as(ADMIN);
    await api("post", "/api/v1/staff").send(p2);

    as(ADMIN);
    const res = await api("get", "/api/v1/staff");

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. REVIEW STAFF  PATCH /api/v1/staff/:staffId/review
// ═════════════════════════════════════════════════════════════════════════════
describe("PATCH /api/v1/staff/:staffId/review — reviewStaff", () => {
  it("200 — approve → status=approved, kycStatus=verified", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("patch", `/api/v1/staff/${staff._id}/review`).send({
      status: "approved",
      note: "All docs verified",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");
    expect(res.body.data.kycStatus).toBe("verified");
    expect(res.body.data.reviewedAt).toBeDefined();
  });

  it("200 — reject with reason → records rejectionReason", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("patch", `/api/v1/staff/${staff._id}/review`).send({
      status: "rejected",
      rejectionReason: "Suspicious document",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("rejected");
    expect(res.body.data.kycStatus).not.toBe("verified");
  });

  it("200 — mark under_review", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("patch", `/api/v1/staff/${staff._id}/review`).send({
      status: "under_review",
      note: "Compliance team reviewing",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("under_review");
  });

  it("200 — mark pending_docs", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("patch", `/api/v1/staff/${staff._id}/review`).send({
      status: "pending_docs",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("pending_docs");
  });

  it("400 — reject without rejectionReason", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("patch", `/api/v1/staff/${staff._id}/review`).send({
      status: "rejected",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rejectionReason/i);
  });

  it("400 — invalid status value", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("patch", `/api/v1/staff/${staff._id}/review`).send({
      status: "godmode",
    });

    expect(res.status).toBe(400);
  });

  it("400 — missing status field", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("patch", `/api/v1/staff/${staff._id}/review`).send({});

    expect(res.status).toBe(400);
  });

  it("404 — staff not found", async () => {
    as(ADMIN);
    const fakeId = new mongoose.Types.ObjectId();
    const res = await api("patch", `/api/v1/staff/${fakeId}/review`).send({
      status: "approved",
    });

    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. INIT SUMSUB APPLICANT  POST /api/v1/staff/:staffId/sumsub/applicant
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /api/v1/staff/:staffId/sumsub/applicant — initStaffApplicant", () => {
  it("201 — creates new applicant and returns applicantId", async () => {
    const staff = await seedStaff();
    mockEnsure.mockResolvedValueOnce({
      created:         true,
      applicantId:     "app_abc123",
      inspectionId:    "insp_xyz",
      reviewStatus:    "pending",
      requiredDocSets: [],
    });

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/applicant`).send({});

    expect(res.status).toBe(201);
    expect(res.body.data.applicantId).toBe("app_abc123");
    expect(mockEnsure).toHaveBeenCalledTimes(1);
  });

  it("200 — returns existing applicant", async () => {
    const staff = await seedStaff();
    mockEnsure.mockResolvedValueOnce({
      created:      false,
      applicantId:  "app_existing",
      inspectionId: "insp_existing",
    });

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/applicant`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.applicantId).toBe("app_existing");
  });

  it("502 — screening engine error is forwarded", async () => {
    const staff = await seedStaff();
    mockEnsure.mockRejectedValueOnce(new Error("Sumsub connection refused"));

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/applicant`).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Sumsub connection refused/);
  });

  it("404 — staff not found", async () => {
    as(ADMIN);
    const fakeId = new mongoose.Types.ObjectId();
    const res = await api("post", `/api/v1/staff/${fakeId}/sumsub/applicant`).send({});

    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. SYNC SUMSUB STATUS  GET /api/v1/staff/:staffId/sumsub/status
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /api/v1/staff/:staffId/sumsub/status — syncStaffStatus", () => {
  it("400 — no applicantId linked to staff", async () => {
    const staff = await seedStaff();
    as(ADMIN);
    const res = await api("get", `/api/v1/staff/${staff._id}/sumsub/status`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/applicant/i);
  });

  it("200 — syncs and returns KYC + AML status", async () => {
    // seed then manually set sumsubApplicantId
    const staff = await seedStaff();
    const Staff = mongoose.model("Staff");
    await Staff.findByIdAndUpdate(staff._id, { sumsubApplicantId: "app_linked" });

    mockSync.mockResolvedValueOnce({ kycStatus: "verified", amlStatus: "clear" });

    as(ADMIN);
    const res = await api("get", `/api/v1/staff/${staff._id}/sumsub/status`);

    expect(res.status).toBe(200);
    expect(res.body.data.kycStatus).toBe("verified");
    expect(res.body.data.amlStatus).toBe("clear");
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it("404 — staff not found", async () => {
    as(ADMIN);
    const fakeId = new mongoose.Types.ObjectId();
    const res = await api("get", `/api/v1/staff/${fakeId}/sumsub/status`);

    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. RUN AML APPLICANT  POST /api/v1/staff/:staffId/sumsub/run-aml
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /api/v1/staff/:staffId/sumsub/run-aml — runAmlApplicant", () => {
  const defaultEnsureResult = {
    created: false, applicantId: "app_run", inspectionId: "insp_run",
  };
  const defaultDocsResult = {
    submitted: 1, skipped: 0,
    results: [{ docType: "national_id", idDocSubType: "FRONT_SIDE", status: "submitted", imageId: "img_1" }],
  };
  const defaultSyncResult = {
    kycStatus: "in_review", amlStatus: "pending",
  };

  it("200 — full flow: ensure applicant → submit docs → sync status", async () => {
    const staff = await seedStaff();
    mockEnsure.mockResolvedValueOnce(defaultEnsureResult);
    mockSubmitDocs.mockResolvedValueOnce(defaultDocsResult);
    mockSync.mockResolvedValueOnce(defaultSyncResult);

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/run-aml`).send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.kycStatus).toBe("in_review");
    expect(res.body.data.amlStatus).toBe("pending");
    expect(res.body.data.documents.submitted).toBe(1);
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockSubmitDocs).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it("200 — message reflects newly created applicant", async () => {
    const staff = await seedStaff();
    mockEnsure.mockResolvedValueOnce({ ...defaultEnsureResult, created: true });
    mockSubmitDocs.mockResolvedValueOnce(defaultDocsResult);
    mockSync.mockResolvedValueOnce(defaultSyncResult);

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/run-aml`).send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/registered/i);
  });

  it("200 — message reflects existing applicant found", async () => {
    const staff = await seedStaff();
    mockEnsure.mockResolvedValueOnce({ ...defaultEnsureResult, created: false });
    mockSubmitDocs.mockResolvedValueOnce(defaultDocsResult);
    mockSync.mockResolvedValueOnce(defaultSyncResult);

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/run-aml`).send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/located/i);
  });

  it("200 — doc submission failure is non-fatal, still syncs status", async () => {
    const staff = await seedStaff();
    mockEnsure.mockResolvedValueOnce(defaultEnsureResult);
    mockSubmitDocs.mockRejectedValueOnce(new Error("Download timeout"));
    mockSync.mockResolvedValueOnce(defaultSyncResult);

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/run-aml`).send({});

    // doc error is swallowed — status sync still returns 200
    expect(res.status).toBe(200);
    expect(res.body.data.documents.submitted).toBe(0);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it("200 — no documents on staff → submitted: 0", async () => {
    const staff = await seedStaff();
    mockEnsure.mockResolvedValueOnce(defaultEnsureResult);
    mockSubmitDocs.mockResolvedValueOnce({ submitted: 0, skipped: 0, results: [] });
    mockSync.mockResolvedValueOnce(defaultSyncResult);

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/run-aml`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.documents.submitted).toBe(0);
  });

  it("502 — screening engine error on applicant creation", async () => {
    const staff = await seedStaff();
    mockEnsure.mockRejectedValueOnce(new Error("Identity service unavailable"));

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/run-aml`).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Screening engine/i);
    expect(mockSubmitDocs).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("502 — status sync failure after applicant and docs succeed", async () => {
    const staff = await seedStaff();
    mockEnsure.mockResolvedValueOnce(defaultEnsureResult);
    mockSubmitDocs.mockResolvedValueOnce(defaultDocsResult);
    mockSync.mockRejectedValueOnce(new Error("Timeout fetching AML data"));

    as(ADMIN);
    const res = await api("post", `/api/v1/staff/${staff._id}/sumsub/run-aml`).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/screening intelligence/i);
  });

  it("404 — staff not found", async () => {
    as(ADMIN);
    const fakeId = new mongoose.Types.ObjectId();
    const res = await api("post", `/api/v1/staff/${fakeId}/sumsub/run-aml`).send({});

    expect(res.status).toBe(404);
  });
});
