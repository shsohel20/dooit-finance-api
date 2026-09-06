/**
 * TBML screening — submission, background polling and the API-level cache.
 *
 *   services/tbmlScreening   submitScreening · refreshReport · readReport · sweepPendingReports
 *   POST /tbml/cases/:caseId/screen     new upload · stored document · vault-first ordering
 *   GET  /tbml/cases/:caseId/reports    headlines from our own database
 *   GET  /tbml/reports/:reportId        cached run, refreshed only when stale
 *
 * The OSINT Engine is stubbed. What is under test is our side of the contract:
 * that a submission answers without waiting for an analysis that takes minutes,
 * that the result is chased in the background, and that a settled report is
 * never fetched from the engine twice.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";
process.env.OSINT_API_KEY = "test-osint-key";
process.env.OSINT_DB_SOURCE = "2";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../../services/tbmlOsintService");
jest.mock("../../utils/fileVaultService");

let mongod;
let Case, TbmlReport, AuditLog, User, osint, fileVault, screening, tbmlCtrl;

const call = (handler, { params = {}, query = {}, body = {}, file, user } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ res, err: null }); return this; },
    };
    const next = (e) => resolve({ res, err: e || null });
    const timer = setTimeout(() => resolve({ res, err: new Error("handler did not respond") }), 10000);
    Promise.resolve(
      handler({ params, query, body, file, user, headers: {}, ip: "127.0.0.1" }, res, next)
    ).finally(() => clearTimeout(timer));
  });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  User = require("../../models/User");
  require("../../models/Client");
  require("../../models/Branch");
  require("../../models/Counter");
  require("../../models/Customer");
  require("../../models/Alert");
  require("../../models/CaseNote");
  Case = require("../../models/Case");
  TbmlReport = require("../../models/TbmlReport");
  AuditLog = require("../../models/AuditLog");
  osint = require("../../services/tbmlOsintService");
  fileVault = require("../../utils/fileVaultService");
  screening = require("../../services/tbmlScreening");
  tbmlCtrl = require("../../controllers/tbmlController");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const CLIENT = new mongoose.Types.ObjectId();
const user = { _id: new mongoose.Types.ObjectId(), name: "Ayesha Rahman", role: "admin", clientBelongs: CLIENT };

const REPORT_ID = "TBML-TEST00000001";

// Trimmed to the fields our side reads; the rest is passed through untouched.
const engineReport = (overrides = {}) => ({
  report_id: REPORT_ID,
  status: "COMPLETED",
  environment: "stage",
  db_source: 2,
  created_at: "2026-09-05T17:01:00.000Z",
  completed_at: "2026-09-05T17:06:20.000Z",
  overall_risk_level: "HIGH",
  overall_risk_score: 70,
  requires_analyst_review: true,
  review_reasons: ["An overall risk of HIGH requires analyst confirmation before any action is taken."],
  tbml_indicators_detected: ["CIRCULAR_TRADE"],
  document_extracts: [{ document_type: "Commercial Invoice", products: [] }],
  osint_results: [],
  product_analyses: [],
  narrative_report: "## Executive Summary\nA test narrative.",
  methodology: { search_provider: "searxng", products_detected: 1 },
  ...overrides,
});

let caseDoc;

beforeEach(async () => {
  jest.clearAllMocks();
  await Promise.all([Case.deleteMany({}), TbmlReport.deleteMany({}), AuditLog.deleteMany({})]);

  // A real user record, so the documents list can populate its uploader.
  await User.deleteMany({});
  await User.create({
    _id: user._id,
    name: user.name,
    userName: "ayesha",
    email: "ayesha@example.test",
    password: "hashed-password-placeholder",
  });

  caseDoc = await Case.create({
    title: "Trade finance review",
    client: CLIENT,
    createdBy: user._id,
  });

  osint.dbSource.mockReturnValue(2);
  osint.submitDocument.mockResolvedValue({
    success: true,
    message: "Screening queued",
    submission_id: "sub-0001",
    report_id: REPORT_ID,
    db_source: 2,
    environment: "stage",
    estimated_completion_minutes: 5,
  });
  osint.getStatus.mockResolvedValue({ report_id: REPORT_ID, status: "PROCESSING", environment: "stage" });
  osint.getReport.mockResolvedValue(engineReport());
  osint.getDocuments.mockResolvedValue({ file_count: 1, files: [{ file_id: "f1", filename: "inv.pdf" }] });
  osint.getTrail.mockResolvedValue({ total: 84, opened: 28, results: [] });

  fileVault.uploadFile.mockResolvedValue({ success: true, file: { publicUrl: "https://files.test/inv.pdf" } });
});

// ── Submission ───────────────────────────────────────────────────────────────

describe("POST /tbml/cases/:caseId/screen", () => {
  const upload = (overrides = {}) =>
    call(tbmlCtrl.screenCaseDocument, {
      params: { caseId: String(caseDoc._id) },
      body: { name: "INV-2026-0006", type: "trade_document" },
      file: { buffer: Buffer.from("%PDF-1.4 test"), originalname: "inv.pdf", mimetype: "application/pdf" },
      user,
      ...overrides,
    });

  it("answers 202 without waiting for the analysis", async () => {
    const { res, err } = await upload();

    expect(err).toBeNull();
    expect(res.statusCode).toBe(202);
    expect(res.body.data.report.reportId).toBe(REPORT_ID);
    // Queued, not analysed — the engine has only accepted the document.
    expect(res.body.data.report.status).toBe("PENDING");
    expect(res.body.data.estimatedCompletionMinutes).toBe(5);
    // Nothing about the result is fetched on the request path.
    expect(osint.getReport).not.toHaveBeenCalled();
    expect(osint.getStatus).not.toHaveBeenCalled();
  });

  it("stores the document in the vault and attaches it to the case before submitting", async () => {
    await upload();

    const fresh = await Case.findById(caseDoc._id);
    expect(fresh.documents).toHaveLength(1);
    expect(fresh.documents[0]).toMatchObject({
      name: "INV-2026-0006",
      url: "https://files.test/inv.pdf",
      type: "trade_document",
      mimeType: "application/pdf",
    });
    // The run is stamped on the document, so the Files view can say what was
    // screened without going near the engine.
    expect(fresh.documents[0].tbml.reportId).toBe(REPORT_ID);
    expect(fileVault.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("keeps the document on the case when the engine refuses the submission", async () => {
    osint.submitDocument.mockRejectedValue(new Error("429 rate limited"));

    const { res, err } = await upload();

    expect(res.statusCode).not.toBe(202);
    expect(err.statusCode).toBe(502);
    expect(err.message).toMatch(/stored on the case but screening could not be started/);

    // The evidence survives independently of the screening — losing an
    // uploaded file would be the worse bug.
    const fresh = await Case.findById(caseDoc._id);
    expect(fresh.documents).toHaveLength(1);
    expect(fresh.documents[0].tbml?.reportId).toBeFalsy();
    expect(await TbmlReport.countDocuments()).toBe(0);
  });

  it("screens a document already on the case without a second upload", async () => {
    await upload();
    jest.clearAllMocks();
    osint.dbSource.mockReturnValue(2);
    osint.submitDocument.mockResolvedValue({
      success: true, message: "queued", submission_id: "sub-0002",
      report_id: "TBML-TEST00000002", db_source: 2, environment: "stage",
    });

    const stored = (await Case.findById(caseDoc._id)).documents[0];
    const axios = require("axios");
    const spy = jest.spyOn(axios, "get").mockResolvedValue({
      data: Buffer.from("%PDF-1.4 test"),
      headers: { "content-type": "application/pdf" },
    });

    const { res } = await call(tbmlCtrl.screenCaseDocument, {
      params: { caseId: String(caseDoc._id) },
      body: { documentId: String(stored._id) },
      user,
    });

    expect(res.statusCode).toBe(202);
    expect(spy).toHaveBeenCalledWith("https://files.test/inv.pdf", expect.anything());
    // Read back from the vault — nothing new is stored.
    expect(fileVault.uploadFile).not.toHaveBeenCalled();
    expect((await Case.findById(caseDoc._id)).documents).toHaveLength(1);
    spy.mockRestore();
  });

  it("refuses a request with neither a file nor a documentId", async () => {
    const { err } = await call(tbmlCtrl.screenCaseDocument, {
      params: { caseId: String(caseDoc._id) },
      body: {},
      user,
    });
    expect(err.statusCode).toBe(400);
  });

  it("refuses a case belonging to another tenant", async () => {
    const foreign = await Case.create({
      title: "Someone else's case",
      client: new mongoose.Types.ObjectId(),
      createdBy: user._id,
    });
    const { err } = await upload({ params: { caseId: String(foreign._id) } });
    expect(err.statusCode).toBe(403);
  });
});

// ── Background polling ───────────────────────────────────────────────────────

describe("background sweep", () => {
  const submit = () =>
    screening.submitScreening({
      buffer: Buffer.from("x"),
      filename: "inv.pdf",
      mimetype: "application/pdf",
      caseDoc,
      user,
    });

  it("leaves a still-running report alone and stores no payload", async () => {
    await submit();

    const stats = await screening.sweepPendingReports();

    expect(stats).toMatchObject({ scanned: 1, settled: 0, failed: 0 });
    const doc = await TbmlReport.findOne({ reportId: REPORT_ID });
    expect(doc.status).toBe("PROCESSING");
    // A run mid-flight has no extract or narrative worth caching; fetching one
    // would cache a blank.
    expect(doc.report).toBeNull();
    expect(osint.getReport).not.toHaveBeenCalled();
    expect(doc.refreshedAt).toBeInstanceOf(Date);
  });

  it("caches the full report once the run settles", async () => {
    await submit();
    osint.getStatus.mockResolvedValue({ report_id: REPORT_ID, status: "COMPLETED" });

    const stats = await screening.sweepPendingReports();

    expect(stats).toMatchObject({ scanned: 1, settled: 1 });
    const doc = await TbmlReport.findOne({ reportId: REPORT_ID });
    expect(doc.status).toBe("COMPLETED");
    expect(doc.overallRiskLevel).toBe("HIGH");
    expect(doc.overallRiskScore).toBe(70);
    expect(doc.requiresAnalystReview).toBe(true);
    expect(doc.completedAt).toBeInstanceOf(Date);
    expect(doc.report.narrative_report).toMatch(/Executive Summary/);
    expect(doc.files.file_count).toBe(1);
  });

  it("records a polling failure without losing the run", async () => {
    await submit();
    osint.getStatus.mockRejectedValue(new Error("connect ETIMEDOUT"));

    await screening.sweepPendingReports();

    const doc = await TbmlReport.findOne({ reportId: REPORT_ID });
    expect(doc.lastPollError).toMatch(/ETIMEDOUT/);
    expect(doc.status).toBe("PENDING"); // unchanged, not invented
    expect(doc.pollAttempts).toBe(1);
  });

  it("stops chasing a run that never settled", async () => {
    const { record } = await submit();
    record.submittedAt = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await record.save();

    const stats = await screening.sweepPendingReports();

    expect(stats.scanned).toBe(0);
    expect(osint.getStatus).not.toHaveBeenCalled();
  });

  it("ignores runs the engine has already finished with", async () => {
    await submit();
    osint.getStatus.mockResolvedValue({ report_id: REPORT_ID, status: "COMPLETED" });
    await screening.sweepPendingReports();
    jest.clearAllMocks();

    const stats = await screening.sweepPendingReports();

    expect(stats.scanned).toBe(0);
    expect(osint.getStatus).not.toHaveBeenCalled();
  });
});

// ── Reading, and the cache ───────────────────────────────────────────────────

describe("GET /tbml/reports/:reportId", () => {
  const settle = async () => {
    await screening.submitScreening({
      buffer: Buffer.from("x"), filename: "inv.pdf", mimetype: "application/pdf", caseDoc, user,
    });
    osint.getStatus.mockResolvedValue({ report_id: REPORT_ID, status: "COMPLETED" });
    await screening.sweepPendingReports();
    jest.clearAllMocks();
    osint.dbSource.mockReturnValue(2);
  };

  it("serves a settled report from our database, never from the engine", async () => {
    await settle();

    const { res } = await call(tbmlCtrl.getTbmlReport, { params: { reportId: REPORT_ID }, user });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.report.narrative_report).toMatch(/Executive Summary/);
    // The whole point of the cache: reopening the tab costs a database read.
    expect(osint.getStatus).not.toHaveBeenCalled();
    expect(osint.getReport).not.toHaveBeenCalled();
  });

  it("re-checks a running report whose last look has gone stale", async () => {
    await screening.submitScreening({
      buffer: Buffer.from("x"), filename: "inv.pdf", mimetype: "application/pdf", caseDoc, user,
    });
    await TbmlReport.updateOne(
      { reportId: REPORT_ID },
      { refreshedAt: new Date(Date.now() - 60_000) }
    );
    osint.getStatus.mockResolvedValue({ report_id: REPORT_ID, status: "COMPLETED" });

    const { res } = await call(tbmlCtrl.getTbmlReport, { params: { reportId: REPORT_ID }, user });

    expect(res.body.data.status).toBe("COMPLETED");
    expect(osint.getStatus).toHaveBeenCalledTimes(1);
    expect(osint.getReport).toHaveBeenCalledTimes(1);
  });

  it("fetches the search trail once, then serves it from the cache", async () => {
    await settle();

    const first = await call(tbmlCtrl.getTbmlTrail, { params: { reportId: REPORT_ID }, user });
    const second = await call(tbmlCtrl.getTbmlTrail, { params: { reportId: REPORT_ID }, user });

    expect(first.res.body.data.total).toBe(84);
    expect(second.res.body.data.total).toBe(84);
    expect(osint.getTrail).toHaveBeenCalledTimes(1);
  });

  it("re-reads from the engine when explicitly refreshed", async () => {
    await settle();
    osint.getStatus.mockResolvedValue({ report_id: REPORT_ID, status: "COMPLETED" });
    osint.getReport.mockResolvedValue(engineReport({ overall_risk_score: 85 }));

    const { res } = await call(tbmlCtrl.refreshTbmlReport, { params: { reportId: REPORT_ID }, user });

    expect(res.body.data.overallRiskScore).toBe(85);
    expect(osint.getReport).toHaveBeenCalledTimes(1);
  });

  it("refuses a run belonging to another tenant", async () => {
    await settle();
    await TbmlReport.updateOne({ reportId: REPORT_ID }, { client: new mongoose.Types.ObjectId() });

    const { err } = await call(tbmlCtrl.getTbmlReport, { params: { reportId: REPORT_ID }, user });
    expect(err.statusCode).toBe(403);
  });
});

describe("GET /tbml/cases/:caseId/reports", () => {
  it("lists headlines for the case without touching the engine", async () => {
    await screening.submitScreening({
      buffer: Buffer.from("x"), filename: "inv.pdf", mimetype: "application/pdf", caseDoc, user,
    });
    osint.getStatus.mockResolvedValue({ report_id: REPORT_ID, status: "COMPLETED" });
    await screening.sweepPendingReports();
    jest.clearAllMocks();

    const { res } = await call(tbmlCtrl.getCaseTbmlReports, {
      params: { caseId: String(caseDoc._id) },
      user,
    });

    expect(res.body.count).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      reportId: REPORT_ID,
      status: "COMPLETED",
      overallRiskLevel: "HIGH",
      overallRiskScore: 70,
    });
    // Headlines only — the cached payload is large and a list never needs it.
    expect(res.body.data[0].report).toBeUndefined();
    expect(osint.getStatus).not.toHaveBeenCalled();
  });
});

// ── Case documents ───────────────────────────────────────────────────────────
// The Files tab reads and writes through these; the TBML tab screens what they
// record. Both views must agree on one list.

describe("case documents", () => {
  const caseCtrl = () => require("../../controllers/caseController");

  it("records a document uploaded to the vault and returns it with its uploader", async () => {
    const ctrl = caseCtrl();

    const added = await call(ctrl.addCaseDocument, {
      params: { id: String(caseDoc._id) },
      body: {
        name: "Commercial invoice INV-2026-0006",
        url: "https://files.test/inv.pdf",
        mimeType: "application/pdf",
        type: "trade_document",
      },
      user,
    });

    expect(added.res.statusCode).toBe(201);
    expect(added.res.body.data.name).toBe("Commercial invoice INV-2026-0006");

    const listed = await call(ctrl.getCaseDocuments, { params: { id: String(caseDoc._id) }, user });
    expect(listed.res.body.count).toBe(1);
    // Populated so the Files tab can name who attached it.
    expect(listed.res.body.data[0].uploadedBy).toBeTruthy();
  });

  it("refuses a document with no stored file", async () => {
    const { err } = await call(caseCtrl().addCaseDocument, {
      params: { id: String(caseDoc._id) },
      body: { name: "no url" },
      user,
    });
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/file-vault/);
  });

  it("detaches a document from the case without touching the vault", async () => {
    const ctrl = caseCtrl();
    const added = await call(ctrl.addCaseDocument, {
      params: { id: String(caseDoc._id) },
      body: { name: "inv.pdf", url: "https://files.test/inv.pdf", type: "trade_document" },
      user,
    });

    const removed = await call(ctrl.removeCaseDocument, {
      params: { id: String(caseDoc._id), documentId: String(added.res.body.data._id) },
      user,
    });

    expect(removed.res.statusCode).toBe(200);
    expect((await Case.findById(caseDoc._id)).documents).toHaveLength(0);
    // The audit line says the file survives — detaching evidence is not
    // authority to destroy it.
    const log = await AuditLog.findOne({ action: "document_removed" });
    expect(log.details).toMatch(/remains in FileVault/);
  });

  it("screening a document from the Files tab reuses the stored file", async () => {
    const ctrl = caseCtrl();
    const added = await call(ctrl.addCaseDocument, {
      params: { id: String(caseDoc._id) },
      body: { name: "inv.pdf", url: "https://files.test/inv.pdf", type: "trade_document" },
      user,
    });

    const axios = require("axios");
    const spy = jest.spyOn(axios, "get").mockResolvedValue({
      data: Buffer.from("%PDF-1.4"),
      headers: { "content-type": "application/pdf" },
    });

    const { res } = await call(tbmlCtrl.screenCaseDocument, {
      params: { caseId: String(caseDoc._id) },
      body: { documentId: String(added.res.body.data._id) },
      user,
    });

    expect(res.statusCode).toBe(202);
    expect(fileVault.uploadFile).not.toHaveBeenCalled();
    // The run is stamped back onto the document, so the Files tab can show it.
    const fresh = await Case.findById(caseDoc._id);
    expect(fresh.documents[0].tbml.reportId).toBe(REPORT_ID);
    spy.mockRestore();
  });
});
