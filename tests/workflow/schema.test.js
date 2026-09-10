/**
 * Workflow schema contract.
 *
 * Pins tenancy, the node/branch/edge subdocument shapes, tenant-scoped
 * workflowId uniqueness, and the version-snapshot hooks — so the next schema
 * change cannot silently drift.
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let Workflow, WorkflowVersion;

const CLIENT_A = new mongoose.Types.ObjectId();
const CLIENT_B = new mongoose.Types.ObjectId();

const wf = (over = {}) => ({
  workflowId: over.workflowId || `WF-${Math.random().toString(36).slice(2, 7)}`,
  name: over.name || "test workflow",
  category: "onboarding",
  appliesTo: "both",
  startNodeId: "n1",
  nodes: [
    { id: "n1", num: "01", type: "level", title: "Entry", position: { x: 0, y: 0 } },
  ],
  edges: [],
  ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Workflow = require("../../models/Workflow");
  WorkflowVersion = require("../../models/WorkflowVersion");
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(async () => {
  await Workflow.deleteMany({});
  await WorkflowVersion.deleteMany({});
});

describe("Workflow schema", () => {
  test("node ids are stable strings, not ObjectIds", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    expect(doc.nodes[0].id).toBe("n1");
    expect(doc.nodes[0]._id).toBeUndefined();
  });

  test("workflowId is unique per tenant, not globally", async () => {
    await Workflow.create(wf({ client: CLIENT_A, workflowId: "WF-0001" }));
    // Same id under a different client is allowed.
    await expect(
      Workflow.create(wf({ client: CLIENT_B, workflowId: "WF-0001" }))
    ).resolves.toBeDefined();
    // Same id under the same client is not.
    await expect(
      Workflow.create(wf({ client: CLIENT_A, workflowId: "WF-0001" }))
    ).rejects.toThrow();
  });

  test("defaults: draft status, version 1, not visible to clients", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    expect(doc.status).toBe("draft");
    expect(doc.version).toBe(1);
    expect(doc.visibleToClients).toBe(false);
  });

  test("a condition branch carries rule-engine condition leaves", async () => {
    const doc = await Workflow.create(
      wf({
        client: CLIENT_A,
        nodes: [
          {
            id: "n1", num: "01", type: "cond", title: "Route",
            position: { x: 0, y: 0 },
            branches: [
              {
                key: "b1", label: "Branch 1", logic: "OR",
                conditions: [
                  { field: "applicant.type", operator: "eq", value: "individual" },
                  { field: "applicant.country", operator: "in", values: ["AU", "NZ"] },
                ],
              },
              { key: "b2", label: "Else", logic: "AND", conditions: [] },
            ],
          },
        ],
      })
    );
    expect(doc.nodes[0].branches[0].conditions[1].values).toEqual(["AU", "NZ"]);
  });

  test("a condition field containing operator characters is rejected", async () => {
    await expect(
      Workflow.create(
        wf({
          client: CLIENT_A,
          nodes: [
            {
              id: "n1", num: "01", type: "cond", title: "Bad",
              position: { x: 0, y: 0 },
              branches: [
                {
                  key: "b1", label: "Branch 1", logic: "AND",
                  conditions: [{ field: "New account (", operator: "eq", value: 1 }],
                },
              ],
            },
          ],
        })
      )
    ).rejects.toThrow(/operator characters/);
  });
});

describe("Workflow version history", () => {
  test("version 1 is snapshotted on create", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    const versions = await WorkflowVersion.find({ workflow: doc._id });
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].snapshot.nodes).toHaveLength(1);
  });

  test("a graph change bumps the version and records changed paths", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    doc.nodes.push({ id: "n2", num: "02", type: "review", title: "Review", position: { x: 300, y: 0 } });
    await doc.save();
    expect(doc.version).toBe(2);
    const v2 = await WorkflowVersion.findOne({ workflow: doc._id, version: 2 });
    expect(v2.changedPaths).toContain("nodes");
  });

  test("a rename does not bump the version", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    doc.name = "renamed";
    await doc.save();
    expect(doc.version).toBe(1);
    expect(await WorkflowVersion.countDocuments({ workflow: doc._id })).toBe(1);
  });

  test("findOneAndUpdate on the graph also bumps and snapshots", async () => {
    const doc = await Workflow.create(wf({ client: CLIENT_A }));
    await Workflow.findByIdAndUpdate(doc._id, { edges: [{ from: "n1", to: "n1" }] }, { new: true });
    const fresh = await Workflow.findById(doc._id);
    expect(fresh.version).toBe(2);
    expect(await WorkflowVersion.countDocuments({ workflow: doc._id, version: 2 })).toBe(1);
  });
});
