/**
 * Workflow lifecycle — the compliance controls.
 *
 * Publishing a workflow that routes sanctions matches and SMR decisions is a
 * consequential act. Maker-checker and reason capture are the point of these
 * tests, not incidental to them.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Workflow, ctrl;

const CLIENT_A = new mongoose.Types.ObjectId();
const MAKER = new mongoose.Types.ObjectId();
const CHECKER = new mongoose.Types.ObjectId();

const user = (id) => ({ _id: id, userType: "client", client: { _id: CLIENT_A } });
const dooit = () => ({ _id: MAKER, userType: "dooit" });

const mockRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

/** A graph that passes validation: one start step, marked terminal. */
const validWf = (over = {}) => ({
  workflowId: `WF-${Math.random().toString(36).slice(2, 7)}`,
  name: "publishable",
  client: CLIENT_A,
  startNodeId: "n1",
  nodes: [{ id: "n1", num: "01", type: "level", title: "Entry", position: { x: 0, y: 0 }, endOfFlow: true }],
  edges: [],
  ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Workflow = require("../../models/Workflow");
  require("../../models/WorkflowVersion");
  require("../../models/User");
  ctrl = require("../../controllers/workflowController");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(async () => {
  await Workflow.deleteMany({});
  await mongoose.model("WorkflowVersion").deleteMany({});
});

describe("publish", () => {
  test("a valid draft moves to pending_approval and records the maker", async () => {
    const doc = await Workflow.create(validWf());
    const res = mockRes();
    await ctrl.publishWorkflow({ params: { id: doc._id }, user: user(MAKER) }, res);
    expect(res.statusCode).toBe(200);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("pending_approval");
    expect(String(fresh.publishedBy)).toBe(String(MAKER));
  });

  test("publish refuses a graph with validation errors", async () => {
    const doc = await Workflow.create(validWf({ startNodeId: "ghost" }));
    const res = mockRes();
    await ctrl.publishWorkflow({ params: { id: doc._id }, user: user(MAKER) }, res);
    expect(res.statusCode).toBe(422);
    expect(res.body.validation.errors.length).toBeGreaterThan(0);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("draft");
  });
});

describe("approve — maker-checker", () => {
  test("a different user approves, moving it to active", async () => {
    const doc = await Workflow.create(validWf({ status: "pending_approval", publishedBy: MAKER }));
    const res = mockRes();
    await ctrl.approveWorkflow({ params: { id: doc._id }, user: user(CHECKER) }, res);
    expect(res.statusCode).toBe(200);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("active");
    expect(String(fresh.approvedBy)).toBe(String(CHECKER));
    expect(fresh.publishedAt).toBeInstanceOf(Date);
  });

  test("the publisher cannot approve their own workflow", async () => {
    const doc = await Workflow.create(validWf({ status: "pending_approval", publishedBy: MAKER }));
    const res = mockRes();
    await ctrl.approveWorkflow({ params: { id: doc._id }, user: user(MAKER) }, res);
    expect(res.statusCode).toBe(403);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("pending_approval");
  });

  test("approve refuses a workflow that is not awaiting approval", async () => {
    const doc = await Workflow.create(validWf({ status: "draft" }));
    const res = mockRes();
    await ctrl.approveWorkflow({ params: { id: doc._id }, user: user(CHECKER) }, res);
    expect(res.statusCode).toBe(409);
  });

  test("approve fails closed when approver has no _id", async () => {
    // Must be a system workflow (client: null): I4 restricts dooit's write
    // scope to system workflows only, so a dooit caller cannot reach a
    // client-owned workflow at all (404) — this case is specifically about
    // the identity check failing closed once the workflow IS reachable.
    const doc = await Workflow.create(validWf({ client: null, status: "pending_approval", publishedBy: MAKER }));
    const res = mockRes();
    await ctrl.approveWorkflow({ params: { id: doc._id }, user: { userType: "dooit" } }, res);
    expect(res.statusCode).toBe(403);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("pending_approval");
  });

  test("approve fails closed when workflow has no publishedBy", async () => {
    const doc = await Workflow.create(validWf({ status: "pending_approval", publishedBy: null }));
    const res = mockRes();
    await ctrl.approveWorkflow({ params: { id: doc._id }, user: user(CHECKER) }, res);
    expect(res.statusCode).toBe(409);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("pending_approval");
  });
});

describe("archive", () => {
  test("archive requires a reason", async () => {
    const doc = await Workflow.create(validWf({ status: "active" }));
    const res = mockRes();
    await ctrl.archiveWorkflow({ params: { id: doc._id }, body: { reason: "   " }, user: user(MAKER) }, res);
    expect(res.statusCode).toBe(400);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("active");
  });

  test("archive records the reason on the file", async () => {
    const doc = await Workflow.create(validWf({ status: "active" }));
    const res = mockRes();
    await ctrl.archiveWorkflow(
      { params: { id: doc._id }, body: { reason: "Superseded by WF-0007" }, user: user(MAKER) },
      res
    );
    expect(res.statusCode).toBe(200);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("archived");
    expect(fresh.archivedReason).toBe("Superseded by WF-0007");
  });
});

describe("duplicate", () => {
  test("a copy is a draft owned by the caller, with a fresh id and no approval trail", async () => {
    const sys = await Workflow.create(
      validWf({ client: null, visibleToClients: true, status: "active", publishedBy: MAKER, approvedBy: CHECKER })
    );
    const res = mockRes();
    await ctrl.duplicateWorkflow({ params: { id: sys._id }, user: user(MAKER) }, res);
    expect(res.statusCode).toBe(201);
    const copy = await Workflow.findById(res.body.data._id);
    expect(String(copy.client)).toBe(String(CLIENT_A));
    expect(copy.status).toBe("draft");
    expect(copy.workflowId).not.toBe(sys.workflowId);
    expect(copy.publishedBy).toBeNull();
    expect(copy.approvedBy).toBeNull();
    expect(copy.visibleToClients).toBe(false);
    expect(copy.publishedAt).toBeNull();
    expect(copy.nodes).toHaveLength(1);
  });
});

describe("visibility", () => {
  test("only dooit may toggle a system template's visibility", async () => {
    const sys = await Workflow.create(validWf({ client: null, visibleToClients: false }));
    const denied = mockRes();
    await ctrl.toggleWorkflowVisibility({ params: { id: sys._id }, user: user(MAKER) }, denied);
    expect(denied.statusCode).toBe(403);

    const allowed = mockRes();
    await ctrl.toggleWorkflowVisibility({ params: { id: sys._id }, user: dooit() }, allowed);
    expect(allowed.statusCode).toBe(200);
    const fresh = await Workflow.findById(sys._id);
    expect(fresh.visibleToClients).toBe(true);
  });

  test("visibility cannot be toggled on a client-owned workflow", async () => {
    const owned = await Workflow.create(validWf({ client: CLIENT_A }));
    const res = mockRes();
    await ctrl.toggleWorkflowVisibility({ params: { id: owned._id }, user: dooit() }, res);
    expect(res.statusCode).toBe(400);
    const fresh = await Workflow.findById(owned._id);
    expect(fresh.visibleToClients).toBe(false);
  });
});
