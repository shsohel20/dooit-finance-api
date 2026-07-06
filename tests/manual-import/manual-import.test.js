const request = require("supertest");
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
jest.mock("../../utils/sendEmail", () => jest.fn().mockResolvedValue(true));
jest.mock("../../utils/sendSms", () => jest.fn().mockResolvedValue(true));

// ── mock Sumsub service + HTTP client (no network) ────────────────────────────
const mockEnsure = jest.fn(async (customer) => {
  customer.sumsubApplicantId = "app_test_1";
  await customer.save();
  return { created: true, applicantId: "app_test_1" };
});
const mockUpload = jest.fn(async () => ({ status: 200, data: {} }));
const mockRequestCheck = jest.fn(async () => ({ status: 200, data: {} }));
const mockSyncOcr = jest.fn();

// ── mock face verification (AFC Face API — no network / no image download) ─────
const mockVerifyDocFace = jest.fn(async () => ({
  verificationStatus: 1,
  similarity: 87.5,
  model: "afc-face-v1",
  apiCode: 200,
  apiErrors: null,
  upstreamStatus: 200,
  rawResponse: { data: { result: { verification_status: 1, similarity: 87.5 } } },
  stepStatus: "approved",
  rejectionReason: undefined,
}));

jest.mock("../../services/faceVerifyService", () => ({
  verifyDocFace: (...a) => mockVerifyDocFace(...a),
  pickFaceVerifyPair: jest.fn(),
  SIMILARITY_THRESHOLD: 40,
  DOC_TYPES: [],
  SELFIE_TYPES: [],
}));

jest.mock("../../services/sumsubService", () => ({
  resolveCustomerByToken: jest.fn(),
  buildApplicantPayload: jest.fn(),
  ensureSumsubApplicant: (...a) => mockEnsure(...a),
  requestPendingReview: (...a) => mockRequestCheck(...a),
  getApplicant: jest.fn(),
  triggerAmlCheck: jest.fn().mockResolvedValue(true),
  handleKycResult: jest.fn(),
  handleAmlResult: jest.fn(),
  syncApplicantFromOcr: (...a) => mockSyncOcr(...a),
  buildIdDocMetadata: jest.fn(),
  uploadDocToSumsub: (...a) => mockUpload(...a),
  pushOcrDocsToSumsub: jest.fn(),
}));

jest.mock("../../utils/sumsubClient", () => ({
  sumsubPatch: jest.fn(),
  sumsubPost: jest.fn(),
  sumsubGet: jest.fn(),
  sumsubPostForm: jest.fn(),
  buildDocFormData: jest.fn(),
  downloadBuffer: jest.fn(async () => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/jpeg",
  })),
}));

// ── require app AFTER all mocks are registered ────────────────────────────────
const app = require("./app");

const Customer = require("../../models/Customer");
const OnboardingJourney = require("../../models/OnboardingJourney");
const Branch = require("../../models/Branch");
const User = require("../../models/User");
const UserType = require("../../models/UserType");
const { hashForSearch } = require("../../utils/encryption");

// ── shared fixtures ───────────────────────────────────────────────────────────
const clientId1 = new mongoose.Types.ObjectId();
const clientId2 = new mongoose.Types.ObjectId();
const staffId = new mongoose.Types.ObjectId();

const CLIENT_USER = {
  _id: staffId, id: staffId, name: "Client Staff",
  role: "client", client: { _id: clientId1 }, branch: null, permissions: [],
};
const CLIENT2_USER = {
  ...CLIENT_USER, role: "client", client: { _id: clientId2 },
};
const ADMIN_NO_TENANT = {
  _id: staffId, id: staffId, name: "Platform Admin",
  role: "admin", client: null, branch: null, permissions: [],
};

function as(user) { mockCurrentUser = user; }
const post = (body) =>
  request(app).post("/api/v1/customer/manual-import").send(body);

const PAYLOAD = (over = {}) => ({
  personalKyc: {
    personal_form: {
      customer_details: { given_name: "Rahim", surname: "Uddin", date_of_birth: "1990-01-15" },
      contact_details: { email: "rahim@test.com", phone: "+8801711111111" },
      employment_details: { occupation: "Engineer" },
      residential_address: {
        address: "12 Lake Rd", suburb: "Dhanmondi", state: "Dhaka",
        postcode: "1209", country: "Bangladesh",
      },
      identificationNo: "NID-12345",
    },
    funds_wealth: { source_of_funds: "Salary" },
  },
  documents: [
    { url: "https://cdn.test/id_front.jpg", type: "front", docType: "national_id" },
    { url: "https://cdn.test/id_back.jpg", type: "back", docType: "national_id" },
    { url: "https://cdn.test/selfie.jpg", type: "front", docType: "selfie" },
  ],
  country: "Bangladesh",
  notes: "walk-in customer",
  ...over,
});

// Wait until the background Sumsub chain reaches `cond`, or time out.
async function waitFor(cond, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const flush = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// ── lifecycle ─────────────────────────────────────────────────────────────────
beforeAll(async () => { await connect(); });
afterAll(async () => { await disconnect(); });
afterEach(async () => {
  await flush(50); // let any straggling background chain finish before wiping
  await clearAll();
  mockCurrentUser = null;
  jest.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/v1/customer/manual-import
// ═════════════════════════════════════════════════════════════════════════════

describe("manual import — happy path", () => {
  it("201 — creates customer, journey, and runs the Sumsub chain", async () => {
    as(CLIENT_USER);
    const res = await post(PAYLOAD());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sumsub).toBe("queued");
    expect(res.body.data.uid).toMatch(/^CR_/);
    const customerId = res.body.data.customerId;

    // background chain: applicant → 3 uploads → request check → in_review
    await waitFor(() => mockRequestCheck.mock.calls.length > 0);
    await waitFor(async () => true); // yield once more for the final save
    await flush(100);

    const customer = await Customer.findById(customerId);
    expect(customer.kycStatus).toBe("in_review");
    expect(customer.sumsubApplicantId).toBe("app_test_1");

    // portal user created FIRST and linked, with tenant-scoped membership
    expect(res.body.data.userCreated).toBe(true);
    const portalUser = await User.findOne({
      emailHash: hashForSearch("rahim@test.com"),
    });
    expect(portalUser).toBeTruthy();
    expect(portalUser.isActive).toBe(false); // no login until invite/OTP
    expect(String(customer.user)).toBe(String(portalUser._id));
    expect(String(res.body.data.userId)).toBe(String(portalUser._id));
    const membership = await UserType.findOne({
      user: portalUser._id, userType: "customer", role: "customer",
    });
    expect(membership).toBeTruthy();
    expect(String(membership.clientBelongs)).toBe(String(clientId1));

    expect(customer.relations).toHaveLength(1);
    expect(customer.relations[0].source).toBe("manual");
    expect(customer.relations[0].onboardingChannel).toBe("In-Branch");
    expect(customer.relations[0].type).toBe("individual");
    expect(String(customer.relations[0].client)).toBe(String(clientId1));
    expect(customer.documents).toHaveLength(3);
    expect(
      customer.kycHistory.map((h) => h.status),
    ).toEqual(["pending", "in_review"]);

    // journey audit trail
    const journey = await OnboardingJourney.findOne({ customer: customerId });
    expect(journey).toBeTruthy();
    // face verify flips both reviewable steps (id_document + selfie) to the verdict
    const stepTypes = journey.steps.map((s) => `${s.type}:${s.status}`);
    expect(stepTypes).toEqual(
      expect.arrayContaining([
        "personal_form:submitted",
        "id_document:approved",
        "selfie:approved",
      ]),
    );
    const actions = journey.events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "manual_import",
        "doc_face_verified",
        "applicant_created",
        "doc_uploaded",
        "check_requested",
      ]),
    );
    expect(journey.providerRef).toBe("app_test_1");
  });

  it("uploads FRONT before BACK, selfie last, with correct Sumsub metadata", async () => {
    as(CLIENT_USER);
    // deliberately shuffled order: back, selfie, front
    const res = await post(
      PAYLOAD({
        documents: [
          { url: "https://cdn.test/id_back.jpg", type: "back", docType: "national_id" },
          { url: "https://cdn.test/selfie.jpg", type: "front", docType: "selfie" },
          { url: "https://cdn.test/id_front.jpg", type: "front", docType: "national_id" },
        ],
      }),
    );
    expect(res.status).toBe(201);

    await waitFor(() => mockUpload.mock.calls.length === 3);
    const metas = mockUpload.mock.calls.map((c) => c[4]); // 5th arg = metadata
    expect(metas[0]).toMatchObject({ idDocType: "ID_CARD", idDocSubType: "FRONT_SIDE" });
    expect(metas[1]).toMatchObject({ idDocType: "ID_CARD", idDocSubType: "BACK_SIDE" });
    expect(metas[2]).toMatchObject({ idDocType: "SELFIE" });
    expect(metas[2].idDocSubType).toBeUndefined(); // single-sided — no sub-type
    expect(metas[0].country).toBe("BGD"); // alpha-3 conversion
  });

  it("maps passport docType without a side sub-type", async () => {
    as(CLIENT_USER);
    const res = await post(
      PAYLOAD({
        documents: [
          { url: "https://cdn.test/passport.jpg", type: "front", docType: "passport" },
        ],
      }),
    );
    expect(res.status).toBe(201);
    await waitFor(() => mockUpload.mock.calls.length === 1);
    const meta = mockUpload.mock.calls[0][4];
    expect(meta.idDocType).toBe("PASSPORT");
    expect(meta.idDocSubType).toBeUndefined();
  });

  it("201 with sumsub skipped when runSumsubCheck=false", async () => {
    as(CLIENT_USER);
    const res = await post(PAYLOAD({ runSumsubCheck: false }));
    expect(res.status).toBe(201);
    expect(res.body.data.sumsub).toBe("skipped");

    await flush();
    expect(mockEnsure).not.toHaveBeenCalled();
    const customer = await Customer.findById(res.body.data.customerId);
    expect(customer.kycStatus).toBe("pending");
  });

  it("does not request the check when every document upload fails", async () => {
    const failed = async () => ({ status: 400, data: { errors: ["bad image"] } });
    mockUpload
      .mockImplementationOnce(failed)
      .mockImplementationOnce(failed)
      .mockImplementationOnce(failed);

    as(CLIENT_USER);
    const res = await post(PAYLOAD());
    expect(res.status).toBe(201);

    await waitFor(() => mockUpload.mock.calls.length === 3);
    await flush();
    expect(mockRequestCheck).not.toHaveBeenCalled();

    const customer = await Customer.findById(res.body.data.customerId);
    expect(customer.kycStatus).toBe("pending"); // never moved to in_review
  });
});

describe("manual import — OCR & avatar", () => {
  it("persists the OCR extraction onto the id_document step", async () => {
    as(CLIENT_USER);
    const res = await post(
      PAYLOAD({
        runSumsubCheck: false,
        ocr: {
          cardType: "NID",
          detectedType: "national_id",
          fields: { full_name: "Rahim Uddin", document_number: "NID-12345" },
        },
      }),
    );
    expect(res.status).toBe(201);

    const journey = await OnboardingJourney.findOne({ customer: res.body.data.customerId });
    const idStep = journey.steps.find((s) => s.type === "id_document");
    expect(idStep.data.ocr.fields.full_name).toBe("Rahim Uddin");
    expect(idStep.data.ocr.fields.document_number).toBe("NID-12345");
    expect(idStep.data.ocr.cardType).toBe("NID");
  });

  it("uses the uploaded selfie as the portal user's avatar", async () => {
    as(CLIENT_USER);
    const res = await post(PAYLOAD({ runSumsubCheck: false }));
    expect(res.status).toBe(201);

    const portalUser = await User.findById(res.body.data.userId);
    expect(portalUser.photoUrl).toBe("https://cdn.test/selfie.jpg");
  });

  it("does not overwrite an existing user's custom avatar", async () => {
    const existingUser = await User.create({
      name: "Rahim Existing",
      userName: "rahim.existing",
      email: "rahim@test.com",
      password: "secret123",
      photoUrl: "https://cdn.test/their-own-photo.jpg",
    });

    as(CLIENT_USER);
    const res = await post(PAYLOAD({ runSumsubCheck: false }));
    expect(res.status).toBe(201);

    const reloaded = await User.findById(existingUser._id);
    expect(reloaded.photoUrl).toBe("https://cdn.test/their-own-photo.jpg");
  });

  it("syncs OCR person-data to the Sumsub applicant (mirrors the invite flow)", async () => {
    as(CLIENT_USER);
    const res = await post(
      PAYLOAD({
        ocr: {
          cardType: "NID",
          fields: { full_name: "Rahim Uddin", date_of_birth: "15 Jan 1990" },
        },
      }),
    );
    expect(res.status).toBe(201);

    await waitFor(() => mockSyncOcr.mock.calls.length > 0);
    const [applicantId, fields] = mockSyncOcr.mock.calls[0];
    expect(applicantId).toBe("app_test_1");
    expect(fields.full_name).toBe("Rahim Uddin");
    await flush(100); // let the rest of the chain settle before teardown
  });

  it("does not sync the applicant when no OCR data was provided", async () => {
    as(CLIENT_USER);
    const res = await post(PAYLOAD()); // no ocr block
    expect(res.status).toBe(201);

    await waitFor(() => mockRequestCheck.mock.calls.length > 0);
    await flush(100);
    expect(mockSyncOcr).not.toHaveBeenCalled();
  });
});

describe("manual import — face verification (doc vs selfie)", () => {
  it("writes the face-match verdict onto both reviewable steps (id_document + selfie)", async () => {
    as(CLIENT_USER);
    const res = await post(PAYLOAD({ runSumsubCheck: false }));
    expect(res.status).toBe(201);
    expect(res.body.data.faceVerify).toBe("queued");

    await waitFor(() => mockVerifyDocFace.mock.calls.length > 0);
    await flush(100);

    // face API is called with the FRONT id doc + the selfie
    const [{ docUrl, selfieUrl }] = mockVerifyDocFace.mock.calls[0];
    expect(docUrl).toBe("https://cdn.test/id_front.jpg");
    expect(selfieUrl).toBe("https://cdn.test/selfie.jpg");

    const journey = await OnboardingJourney.findOne({ customer: res.body.data.customerId });
    const idStep = journey.steps.find((s) => s.type === "id_document");
    const selfieStep = journey.steps.find((s) => s.type === "selfie");
    expect(idStep.status).toBe("approved");
    expect(idStep.data.similarity).toBe(87.5);
    expect(idStep.data.verificationStatus).toBe(1);
    // selfie step carries the same verdict — it's independently reviewable in the UI
    expect(selfieStep.status).toBe("approved");
    expect(selfieStep.data.similarity).toBe(87.5);
    expect(journey.events.map((e) => e.action)).toContain("doc_face_verified");
  });

  it("rejects both reviewable steps when similarity is below threshold", async () => {
    mockVerifyDocFace.mockResolvedValueOnce({
      verificationStatus: 0,
      similarity: 22.1,
      model: "afc-face-v1",
      apiCode: 200,
      apiErrors: null,
      upstreamStatus: 200,
      rawResponse: {},
      stepStatus: "rejected",
      rejectionReason: "Face similarity too low (22.1% < 60%)",
    });

    as(CLIENT_USER);
    const res = await post(PAYLOAD({ runSumsubCheck: false }));
    expect(res.status).toBe(201);

    await waitFor(() => mockVerifyDocFace.mock.calls.length > 0);
    await flush(100);

    const journey = await OnboardingJourney.findOne({ customer: res.body.data.customerId });
    const idStep = journey.steps.find((s) => s.type === "id_document");
    const selfieStep = journey.steps.find((s) => s.type === "selfie");
    expect(idStep.status).toBe("rejected");
    expect(idStep.rejectionReason).toMatch(/similarity too low/i);
    // both steps carry the rejection — each is independently reviewable so a
    // reviewer can clear the selfie/liveness separately from the document
    expect(selfieStep.status).toBe("rejected");
    expect(selfieStep.rejectionReason).toMatch(/similarity too low/i);
  });

  it("preserves OCR data on the id_document step (face-verify merges, not replaces)", async () => {
    as(CLIENT_USER);
    const res = await post(
      PAYLOAD({
        runSumsubCheck: false,
        ocr: { cardType: "NID", fields: { full_name: "Rahim Uddin" } },
      }),
    );
    expect(res.status).toBe(201);

    await waitFor(() => mockVerifyDocFace.mock.calls.length > 0);
    await flush(100);

    const journey = await OnboardingJourney.findOne({ customer: res.body.data.customerId });
    const idStep = journey.steps.find((s) => s.type === "id_document");
    expect(idStep.data.ocr.fields.full_name).toBe("Rahim Uddin"); // OCR kept
    expect(idStep.data.similarity).toBe(87.5); // face-match added
  });

  it("skips face verify when no selfie was uploaded", async () => {
    as(CLIENT_USER);
    const res = await post(
      PAYLOAD({
        runSumsubCheck: false,
        documents: [
          { url: "https://cdn.test/id_front.jpg", type: "front", docType: "national_id" },
          { url: "https://cdn.test/id_back.jpg", type: "back", docType: "national_id" },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.faceVerify).toBe("skipped");

    await flush(100);
    expect(mockVerifyDocFace).not.toHaveBeenCalled();
  });
});

describe("manual import — dedupe", () => {
  it("409 — same email under the same client/branch", async () => {
    as(CLIENT_USER);
    const first = await post(PAYLOAD());
    expect(first.status).toBe(201);
    await flush(); // let the first chain settle

    const dup = await post(PAYLOAD());
    expect(dup.status).toBe(409);
    expect(dup.body.success).toBe(false);
    expect(String(dup.body.data.customerId)).toBe(String(first.body.data.customerId));

    expect(await Customer.countDocuments()).toBe(1);
  });

  it("200 — same customer under a NEW client appends a relation, no Sumsub re-run", async () => {
    as(CLIENT_USER);
    const first = await post(PAYLOAD());
    expect(first.status).toBe(201);
    await waitFor(() => mockRequestCheck.mock.calls.length > 0);
    jest.clearAllMocks();

    as(CLIENT2_USER);
    const res = await post(PAYLOAD());
    expect(res.status).toBe(200);
    expect(res.body.data.relationAdded).toBe(true);
    expect(res.body.data.sumsub).toBe("skipped");

    await flush();
    expect(mockEnsure).not.toHaveBeenCalled();

    const customer = await Customer.findById(res.body.data.customerId);
    expect(customer.relations).toHaveLength(2);
    expect(String(customer.relations[1].client)).toBe(String(clientId2));
    expect(await Customer.countDocuments()).toBe(1);

    // portal membership extended to the new tenant, no duplicate user
    expect(await User.countDocuments()).toBe(1);
    expect(
      await UserType.countDocuments({ user: customer.user, userType: "customer" }),
    ).toBe(2);
  });
});

describe("manual import — portal user", () => {
  it("links an existing user by email instead of creating a duplicate", async () => {
    const existingUser = await User.create({
      name: "Rahim Existing",
      userName: "rahim.existing",
      email: "rahim@test.com",
      password: "secret123",
    });

    as(CLIENT_USER);
    const res = await post(PAYLOAD({ runSumsubCheck: false }));
    expect(res.status).toBe(201);
    expect(res.body.data.userCreated).toBe(false);
    expect(String(res.body.data.userId)).toBe(String(existingUser._id));

    const customer = await Customer.findById(res.body.data.customerId);
    expect(String(customer.user)).toBe(String(existingUser._id));
    expect(await User.countDocuments()).toBe(1);
  });

  it("phone-only import cannot create a user (email required) — user stays null", async () => {
    as(CLIENT_USER);
    const payload = PAYLOAD({ runSumsubCheck: false });
    payload.personalKyc.personal_form.contact_details = { phone: "+8801733333333" };
    const res = await post(payload);

    expect(res.status).toBe(201);
    expect(res.body.data.userId).toBeNull();
    expect(res.body.data.userCreated).toBe(false);

    const customer = await Customer.findById(res.body.data.customerId);
    expect(customer.user).toBeNull();
    expect(await User.countDocuments()).toBe(0);
  });

  it("finds a phone-only match on an existing user record", async () => {
    const existingUser = await User.create({
      name: "Phone Match",
      userName: "phone.match",
      email: "phone.match@test.com",
      phone: "+8801744444444",
      password: "secret123",
    });

    as(CLIENT_USER);
    const payload = PAYLOAD({ runSumsubCheck: false });
    payload.personalKyc.personal_form.contact_details = { phone: "+8801744444444" };
    const res = await post(payload);

    expect(res.status).toBe(201);
    expect(String(res.body.data.userId)).toBe(String(existingUser._id));
    expect(res.body.data.userCreated).toBe(false);
  });
});

describe("manual import — validation & tenancy", () => {
  it("400 — missing given_name", async () => {
    as(CLIENT_USER);
    const payload = PAYLOAD();
    delete payload.personalKyc.personal_form.customer_details.given_name;
    const res = await post(payload);
    expect(res.status).toBe(400);
  });

  it("400 — no contact email and no phone", async () => {
    as(CLIENT_USER);
    const payload = PAYLOAD();
    payload.personalKyc.personal_form.contact_details = {};
    const res = await post(payload);
    expect(res.status).toBe(400);
  });

  it("400 — tenant-less session without body clientId", async () => {
    as(ADMIN_NO_TENANT);
    const res = await post(PAYLOAD());
    expect(res.status).toBe(400);
  });

  it("201 — tenant-less admin may pass clientId explicitly", async () => {
    as(ADMIN_NO_TENANT);
    const res = await post(PAYLOAD({ clientId: clientId1.toString(), runSumsubCheck: false }));
    expect(res.status).toBe(201);
    const customer = await Customer.findById(res.body.data.customerId);
    expect(String(customer.relations[0].client)).toBe(String(clientId1));
  });

  it("400 — branchId that belongs to another client is rejected", async () => {
    const foreignBranch = await Branch.create({
      client: clientId2, name: "Other HQ", branchCode: "OT-001",
    });
    as(CLIENT_USER); // session client = clientId1
    const res = await post(
      PAYLOAD({ branchId: foreignBranch._id.toString(), runSumsubCheck: false }),
    );
    expect(res.status).toBe(400);
  });

  it("201 — client staff may target one of their own branches", async () => {
    const ownBranch = await Branch.create({
      client: clientId1, name: "Own HQ", branchCode: "OWN-001",
    });
    as(CLIENT_USER);
    const res = await post(
      PAYLOAD({ branchId: ownBranch._id.toString(), runSumsubCheck: false }),
    );
    expect(res.status).toBe(201);
    const customer = await Customer.findById(res.body.data.customerId);
    expect(String(customer.relations[0].branch)).toBe(String(ownBranch._id));
  });

  it("403 — customer role is not allowed", async () => {
    as({ ...CLIENT_USER, role: "customer" });
    const res = await post(PAYLOAD());
    expect(res.status).toBe(403);
  });
});
