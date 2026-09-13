/**
 * Workflow controller — tenancy isolation and the write path.
 *
 * Handlers are called directly with fake req/res, the way the rule-engine
 * tests exercise their services: no HTTP server, no auth stack, so what is
 * under test is the handler's own logic.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Workflow, ctrl, workflowResultsMw;

const CLIENT_A = new mongoose.Types.ObjectId();
const CLIENT_B = new mongoose.Types.ObjectId();
const BRANCH_1 = new mongoose.Types.ObjectId();
const BRANCH_2 = new mongoose.Types.ObjectId();
const USER_A = new mongoose.Types.ObjectId();

const clientUser = (client) => ({ _id: USER_A, userType: "client", client: { _id: client } });
const clientUserInBranch = (client, branch) => ({
  _id: USER_A,
  userType: "client",
  client: { _id: client },
  branch: { _id: branch },
});
const clientUserNoClient = () => ({ _id: USER_A, userType: "client" });
const dooitUser = () => ({ _id: USER_A, userType: "dooit" });

/** Minimal res double — captures status and body. */
const mockRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const wf = (over = {}) => ({
  workflowId: over.workflowId || `WF-${Math.random().toString(36).slice(2, 7)}`,
  name: "test workflow",
  category: "onboarding",
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
  // getWorkflowVersions populates `changedBy` against the "Users" model — it
  // must be registered on this connection before that query runs.
  require("../../models/User");
  ctrl = require("../../controllers/workflowController");
  workflowResultsMw = require("../../middleware/workflowResults");
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

describe("tenancy isolation", () => {
  test("a client user cannot read another client's workflow", async () => {
    const other = await Workflow.create(wf({ client: CLIENT_B }));
    const res = mockRes();
    await ctrl.getWorkflow({ params: { id: other._id }, user: clientUser(CLIENT_A) }, res);
    expect(res.statusCode).toBe(404);
  });

  test("a client user cannot read a hidden system workflow", async () => {
    const sys = await Workflow.create(wf({ client: null, visibleToClients: false }));
    const res = mockRes();
    await ctrl.getWorkflow({ params: { id: sys._id }, user: clientUser(CLIENT_A) }, res);
    expect(res.statusCode).toBe(404);
  });

  test("a client user can read a visible system workflow", async () => {
    const sys = await Workflow.create(wf({ client: null, visibleToClients: true }));
    const res = mockRes();
    await ctrl.getWorkflow({ params: { id: sys._id }, user: clientUser(CLIENT_A) }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.workflowId).toBe(sys.workflowId);
  });

  // Regression test for a branch-scoping bug: the default (no-tab) scope
  // filter previously dropped branch entirely, so a user in Branch 1 could
  // read a same-client workflow that belongs to Branch 2. findScoped always
  // calls buildScopeFilter(req.user, undefined) — the default case — so
  // every single-item read (getWorkflow, getWorkflowVersions, ...) took the
  // unguarded path.
  test("a client user in one branch cannot read another branch's workflow of the same client", async () => {
    const other = await Workflow.create(wf({ client: CLIENT_A, branch: BRANCH_2 }));
    const res = mockRes();
    await ctrl.getWorkflow(
      { params: { id: other._id }, user: clientUserInBranch(CLIENT_A, BRANCH_1) },
      res
    );
    expect(res.statusCode).toBe(404);
  });
});

// Regression tests for C4/I3/I4: findScoped (read) was branch-aware and
// tenant-safe; findWritable (write) was not. These exercise the WRITE verbs
// (PUT, DELETE, archive) specifically, because the pre-existing coverage
// above only ever calls getWorkflow — which is exactly why these three bugs
// survived a prior review round.
describe("write-path tenancy (findWritable)", () => {
  test("C4: a client user in one branch cannot PUT another branch's workflow of the same client", async () => {
    const other = await Workflow.create(wf({ client: CLIENT_A, branch: BRANCH_2 }));
    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: other._id }, body: { name: "hijacked" }, user: clientUserInBranch(CLIENT_A, BRANCH_1) },
      res
    );
    expect(res.statusCode).toBe(404);
    const fresh = await Workflow.findById(other._id);
    expect(fresh.name).toBe("test workflow");
  });

  test("C4: a client user in one branch cannot DELETE another branch's workflow of the same client", async () => {
    const other = await Workflow.create(wf({ client: CLIENT_A, branch: BRANCH_2 }));
    const res = mockRes();
    await ctrl.deleteWorkflow(
      { params: { id: other._id }, user: clientUserInBranch(CLIENT_A, BRANCH_1) },
      res
    );
    expect(res.statusCode).toBe(404);
    const fresh = await Workflow.findById(other._id);
    expect(fresh.deletedAt).toBeNull();
  });

  test("C4: a client user in one branch cannot ARCHIVE another branch's workflow of the same client", async () => {
    const other = await Workflow.create(wf({ client: CLIENT_A, branch: BRANCH_2, status: "active" }));
    const res = mockRes();
    await ctrl.archiveWorkflow(
      { params: { id: other._id }, body: { reason: "no longer needed" }, user: clientUserInBranch(CLIENT_A, BRANCH_1) },
      res
    );
    expect(res.statusCode).toBe(404);
    const fresh = await Workflow.findById(other._id);
    expect(fresh.status).toBe("active");
  });

  test("C4: a branch-scoped user CAN write a client-wide (no-branch) workflow of their own client", async () => {
    const shared = await Workflow.create(wf({ client: CLIENT_A, branch: null }));
    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: shared._id }, body: { name: "edited" }, user: clientUserInBranch(CLIENT_A, BRANCH_1) },
      res
    );
    expect(res.statusCode).toBe(200);
  });

  test("I3: a client user whose client does not resolve cannot PUT a system template (client: null is NOT their scope)", async () => {
    const sys = await Workflow.create(wf({ client: null, visibleToClients: true, workflowId: "WF-SYS-I3" }));
    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: sys._id }, body: { name: "hijacked" }, user: clientUserNoClient() },
      res
    );
    expect(res.statusCode).toBe(404);
    const fresh = await Workflow.findById(sys._id);
    expect(fresh.name).toBe("test workflow");
  });

  test("I3: a client user whose client does not resolve cannot DELETE a system template", async () => {
    const sys = await Workflow.create(wf({ client: null, visibleToClients: true, workflowId: "WF-SYS-I3B" }));
    const res = mockRes();
    await ctrl.deleteWorkflow(
      { params: { id: sys._id }, user: clientUserNoClient() },
      res
    );
    expect(res.statusCode).toBe(404);
    const fresh = await Workflow.findById(sys._id);
    expect(fresh.deletedAt).toBeNull();
  });

  test("I4: dooit cannot PUT a client's workflow (dooit's client view is read-only)", async () => {
    const clientWf = await Workflow.create(wf({ client: CLIENT_A, workflowId: "WF-I4A" }));
    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: clientWf._id }, body: { name: "hijacked" }, user: dooitUser() },
      res
    );
    expect(res.statusCode).toBe(404);
    const fresh = await Workflow.findById(clientWf._id);
    expect(fresh.name).toBe("test workflow");
  });

  test("I4: dooit cannot DELETE a client's workflow", async () => {
    const clientWf = await Workflow.create(wf({ client: CLIENT_A, workflowId: "WF-I4B" }));
    const res = mockRes();
    await ctrl.deleteWorkflow({ params: { id: clientWf._id }, user: dooitUser() }, res);
    expect(res.statusCode).toBe(404);
    const fresh = await Workflow.findById(clientWf._id);
    expect(fresh.deletedAt).toBeNull();
  });

  test("I4: dooit CAN PUT a system template (client: null)", async () => {
    const sys = await Workflow.create(wf({ client: null, workflowId: "WF-I4C" }));
    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: sys._id }, body: { name: "edited by dooit" }, user: dooitUser() },
      res
    );
    expect(res.statusCode).toBe(200);
    const fresh = await Workflow.findById(sys._id);
    expect(fresh.name).toBe("edited by dooit");
  });
});

// Regression test for C5: an edit to the graph of an already-approved
// workflow must revoke that approval, not silently ride along on it.
describe("editing a versioned path revokes approval (C5)", () => {
  const approved = (over = {}) => wf({
    client: CLIENT_A,
    status: "active",
    publishedBy: USER_A,
    approvedBy: new mongoose.Types.ObjectId(),
    publishedAt: new Date(),
    ...over,
  });

  test("changing `nodes` on an active workflow resets it to draft and clears approval fields", async () => {
    const doc = await Workflow.create(approved());
    const res = mockRes();
    await ctrl.updateWorkflow(
      {
        params: { id: doc._id },
        body: { nodes: [...doc.toObject().nodes, { id: "n2", num: "02", type: "review", title: "Review", position: { x: 300, y: 0 }, endOfFlow: true }] },
        user: clientUser(CLIENT_A),
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.approvalRevoked).toBe(true);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("draft");
    expect(fresh.publishedBy).toBeNull();
    expect(fresh.approvedBy).toBeNull();
    expect(fresh.publishedAt).toBeNull();
  });

  test("changing `edges` on a pending_approval workflow also revokes it", async () => {
    const doc = await Workflow.create(approved({ status: "pending_approval" }));
    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: doc._id }, body: { edges: [{ from: "n1", to: "n1", sourcePort: "" }] }, user: clientUser(CLIENT_A) },
      res
    );
    expect(res.statusCode).toBe(200);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("draft");
    expect(fresh.approvedBy).toBeNull();
  });

  test("changing a non-versioned field (e.g. name) on an active workflow does NOT revoke approval", async () => {
    const doc = await Workflow.create(approved());
    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: doc._id }, body: { name: "renamed only" }, user: clientUser(CLIENT_A) },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.approvalRevoked).toBeUndefined();
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("active");
    expect(fresh.approvedBy).not.toBeNull();
  });
});

describe("create and update", () => {
  test("create stamps the caller's tenant and author", async () => {
    const res = mockRes();
    await ctrl.createWorkflow({ body: wf(), user: clientUser(CLIENT_A) }, res);
    expect(res.statusCode).toBe(201);
    const doc = await Workflow.findById(res.body.data._id);
    expect(String(doc.client)).toBe(String(CLIENT_A));
    expect(String(doc.createdBy)).toBe(String(USER_A));
  });

  test("create allocates a sequential workflowId when none is given", async () => {
    const res = mockRes();
    await ctrl.createWorkflow({ body: { name: "no id" }, user: clientUser(CLIENT_A) }, res);
    expect(res.body.data.workflowId).toMatch(/^WF-\d{4}$/);
  });

  test("a draft save with an invalid graph still succeeds, returning warnings", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    const res = mockRes();
    await ctrl.updateWorkflow(
      {
        params: { id: doc._id },
        // startNodeId points at nothing — an error, but drafts still save.
        body: { startNodeId: "ghost" },
        user: clientUser(CLIENT_A),
      },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.validation.errors.length).toBeGreaterThan(0);
  });

  test("a client user cannot update another client's workflow", async () => {
    const other = await Workflow.create(wf({ client: CLIENT_B }));
    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: other._id }, body: { name: "hijacked" }, user: clientUser(CLIENT_A) },
      res
    );
    expect(res.statusCode).toBe(404);
    const fresh = await Workflow.findById(other._id);
    expect(fresh.name).toBe("test workflow");
  });

  // The single most security-relevant line in this task: status, client,
  // branch, visibleToClients, version, publishedBy, approvedBy and
  // workflowId move only through their own endpoints (lifecycle/tenancy),
  // never through a plain save — even when a caller sends hostile values
  // for all eight in one request.
  test("updateWorkflow strips lifecycle and tenancy fields even when the caller sends hostile values for all eight", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    const originalWorkflowId = doc.workflowId;

    const hostileBody = {
      status: "active",
      client: CLIENT_B,
      branch: new mongoose.Types.ObjectId(),
      visibleToClients: true,
      version: 999,
      publishedBy: new mongoose.Types.ObjectId(),
      approvedBy: new mongoose.Types.ObjectId(),
      workflowId: "WF-9999",
      // Control: a field that is NOT on the strip list should still apply,
      // proving this is a targeted strip and not a broken update path.
      name: "still editable",
    };

    const res = mockRes();
    await ctrl.updateWorkflow(
      { params: { id: doc._id }, body: hostileBody, user: clientUser(CLIENT_A) },
      res
    );
    expect(res.statusCode).toBe(200);

    const fresh = await Workflow.findById(doc._id);
    expect(fresh.status).toBe("draft");
    expect(String(fresh.client)).toBe(String(CLIENT_A));
    expect(fresh.branch).toBeNull();
    expect(fresh.visibleToClients).toBe(false);
    expect(fresh.version).toBe(1);
    expect(fresh.publishedBy).toBeNull();
    expect(fresh.approvedBy).toBeNull();
    expect(fresh.workflowId).toBe(originalWorkflowId);
    expect(fresh.name).toBe("still editable");
  });

  test("delete is soft — the document survives with deletedAt set", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    const res = mockRes();
    await ctrl.deleteWorkflow({ params: { id: doc._id }, user: clientUser(CLIENT_A) }, res);
    expect(res.statusCode).toBe(200);
    const fresh = await Workflow.findById(doc._id);
    expect(fresh).not.toBeNull();
    expect(fresh.deletedAt).toBeInstanceOf(Date);
  });
});

describe("version history", () => {
  test("versions list newest first", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    doc.nodes.push({ id: "n2", num: "02", type: "review", title: "Review", position: { x: 300, y: 0 } });
    await doc.save();
    const res = mockRes();
    await ctrl.getWorkflowVersions({ params: { id: doc._id }, user: clientUser(CLIENT_A) }, res);
    expect(res.body.data.map((v) => v.version)).toEqual([2, 1]);
  });
});

describe("catalog", () => {
  test("catalog exposes step types, operators and variable namespaces", async () => {
    const res = mockRes();
    await ctrl.getWorkflowCatalog({ user: clientUser(CLIENT_A) }, res);
    expect(res.body.data.stepTypes.length).toBe(10);
    expect(res.body.data.operators).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "eq" })])
    );
    expect(res.body.data.variables.length).toBeGreaterThan(0);
  });
});

describe("workflowResults middleware (list route)", () => {
  // The middleware is not yet wired to a route (routing lands in a later
  // task), so it is called directly with a fake req/res/next, the same way
  // the controller handlers above are called directly.
  const runMw = async (req) => {
    const res = {};
    const next = jest.fn();
    await workflowResultsMw(req, res, next);
    return { res, next };
  };

  test("the system tab returns only visible system workflows", async () => {
    await Workflow.create(wf({ client: null, visibleToClients: true, workflowId: "WF-SYS1" }));
    await Workflow.create(wf({ client: null, visibleToClients: false, workflowId: "WF-SYS2" }));
    await Workflow.create(wf({ client: CLIENT_A, workflowId: "WF-CLI1" }));

    const { res, next } = await runMw({ query: { workflowType: "system" }, user: clientUser(CLIENT_A) });

    expect(next).toHaveBeenCalledWith();
    expect(res.workflowResults.data.map((d) => d.workflowId)).toEqual(["WF-SYS1"]);
  });

  test("the client tab returns only the caller's own workflows", async () => {
    await Workflow.create(wf({ client: CLIENT_A, workflowId: "WF-A1" }));
    await Workflow.create(wf({ client: CLIENT_B, workflowId: "WF-B1" }));
    await Workflow.create(wf({ client: null, visibleToClients: true, workflowId: "WF-SYS" }));

    const { res } = await runMw({ query: { workflowType: "client" }, user: clientUser(CLIENT_A) });

    expect(res.workflowResults.data.map((d) => d.workflowId)).toEqual(["WF-A1"]);
  });

  test("list rows omit nodes/edges but carry nodeCount/conditionCount", async () => {
    await Workflow.create(wf({
      client: CLIENT_A,
      nodes: [
        { id: "n1", num: "01", type: "level", title: "Entry", position: { x: 0, y: 0 } },
        {
          id: "n2", num: "02", type: "cond", title: "Branch", position: { x: 100, y: 0 },
          branches: [{ key: "y", label: "Yes" }, { key: "n", label: "Else" }],
        },
        { id: "n3", num: "03", type: "note", title: "Just a note", position: { x: 200, y: 0 } },
      ],
    }));

    const { res } = await runMw({ query: {}, user: clientUser(CLIENT_A) });

    const row = res.workflowResults.data[0];
    expect(row.nodes).toBeUndefined();
    expect(row.edges).toBeUndefined();
    // nodeCount excludes the note (n1 level + n2 cond = 2); conditionCount
    // counts only 'cond' type nodes (n2 = 1).
    expect(row.nodeCount).toBe(2);
    expect(row.conditionCount).toBe(1);
  });

  test("an off-allowlist sort value falls back to createdAt instead of being passed through", async () => {
    const older = await Workflow.create(wf({ client: CLIENT_A, workflowId: "WF-OLD" }));
    await Workflow.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 100000) } });
    const newer = await Workflow.create(wf({ client: CLIENT_A, workflowId: "WF-NEW" }));
    await Workflow.updateOne({ _id: newer._id }, { $set: { createdAt: new Date() } });

    // "$where" is not on SAFE_SORT_FIELDS — if it were passed straight into
    // .sort() it would either throw or let the caller sort/inject on an
    // arbitrary key. It must fall back to createdAt desc silently instead.
    const { res, next } = await runMw({ query: { sort: "$where" }, user: clientUser(CLIENT_A) });

    expect(next).toHaveBeenCalledWith();
    const ids = res.workflowResults.data.map((d) => d.workflowId);
    expect(ids[0]).toBe("WF-NEW");
    expect(ids[1]).toBe("WF-OLD");
  });

  test("limit is capped at 200 even when a larger value is requested", async () => {
    const bulk = Array.from({ length: 205 }, (_, i) => ({
      workflowId: `WF-CAP${String(i).padStart(4, "0")}`,
      name: `bulk ${i}`,
      client: CLIENT_A,
    }));
    await Workflow.insertMany(bulk);

    const { res } = await runMw({ query: { limit: "5000" }, user: clientUser(CLIENT_A) });

    expect(res.workflowResults.total).toBe(205);
    expect(res.workflowResults.count).toBe(200);
    expect(res.workflowResults.pages).toBe(2);
  });
});

describe("getWorkflows handler", () => {
  test("returns whatever workflowResults middleware set on res", async () => {
    const req = {};
    const res = { workflowResults: { success: true, count: 0, total: 0, data: [] } };
    let statusCode;
    res.status = (c) => { statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await ctrl.getWorkflows(req, res);
    expect(statusCode).toBe(200);
    expect(res.body).toBe(res.workflowResults);
  });
});
