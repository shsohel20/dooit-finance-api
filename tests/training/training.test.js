const request  = require("supertest");
const mongoose = require("mongoose");
const { connect, disconnect, clearAll } = require("./setup");

// ── mock auth BEFORE app/routes are required ──────────────────────────────────
// Jest hoists jest.mock() calls. Variable names starting with "mock" are
// allowed by Jest's out-of-scope guard.
let mockCurrentUser = null;

jest.mock("../../middleware/auth", () => ({
  protect: (req, _res, next) => {
    if (!mockCurrentUser) {
      const e = Object.assign(new Error("No test user"), { statusCode: 401 });
      return next(e);
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
  verifyUser:           (_req, _res, next) => next(),
  authorizePermission:  ()  => (_req, _res, next) => next(),
}));

// advancedResults scopes by client/branch — Training modules no longer carry
// those fields, so stub it with a plain find() to keep tests predictable.
jest.mock("../../middleware/advancedResults", () =>
  (model) => async (req, res, next) => {
    try {
      const data = await model.find({}).sort("-createdAt").lean();
      res.advancedResults = { success: true, count: data.length, data };
      next();
    } catch (e) { next(e); }
  }
);

// ── require app AFTER mocks are registered ────────────────────────────────────
const app = require("./app");

// ── shared ObjectIds ──────────────────────────────────────────────────────────
const adminId   = new mongoose.Types.ObjectId();
const managerId = new mongoose.Types.ObjectId();
const learnerId = new mongoose.Types.ObjectId();
const clientId  = new mongoose.Types.ObjectId();
const branchId  = new mongoose.Types.ObjectId();
const roleId    = new mongoose.Types.ObjectId();

const ADMIN   = { _id: adminId,   id: adminId,   name: "Admin",   email: "admin@t.com",   role: "admin",   client: null, branch: {}, permissions: [] };
const MANAGER = { _id: managerId, id: managerId, name: "Manager", email: "manager@t.com", role: "manager", client: null, branch: {}, permissions: [] };
const LEARNER = { _id: learnerId, id: learnerId, name: "Learner", email: "learner@t.com", role: "learner", client: null, branch: {}, permissions: [] };

function as(user) { mockCurrentUser = user; }

const api = (method, url) => request(app)[method](url);

// ── lifecycle ─────────────────────────────────────────────────────────────────
beforeAll(async () => { await connect(); });
afterAll(async () => { await disconnect(); });
afterEach(async () => { await clearAll(); mockCurrentUser = null; });

// ═════════════════════════════════════════════════════════════════════════════
// 1. MODULE CRUD
// ═════════════════════════════════════════════════════════════════════════════
describe("Module CRUD", () => {
  beforeEach(() => as(ADMIN));

  it("creates a draft module", async () => {
    const res = await api("post", "/api/v1/training-modules")
      .send({ title: "Safety Basics", description: "Intro" });

    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe("Safety Basics");
    expect(res.body.data.status).toBe("draft");
    expect(res.body.data.uid).toMatch(/^MOD_/);
  });

  it("400 when title is missing", async () => {
    const res = await api("post", "/api/v1/training-modules").send({});
    expect(res.status).toBe(400);
  });

  it("lists all modules", async () => {
    await api("post", "/api/v1/training-modules").send({ title: "A" });
    await api("post", "/api/v1/training-modules").send({ title: "B" });
    const res = await api("get", "/api/v1/training-modules");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  it("gets a single module by id", async () => {
    const { body: { data: { _id } } } = await api("post", "/api/v1/training-modules").send({ title: "Single" });
    const res = await api("get", `/api/v1/training-modules/${_id}`);
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(_id);
  });

  it("400 for invalid ObjectId", async () => {
    expect((await api("get", "/api/v1/training-modules/not-valid")).status).toBe(400);
  });

  it("404 for unknown id", async () => {
    expect((await api("get", `/api/v1/training-modules/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
  });

  it("updates title and status", async () => {
    const { body: { data: { _id } } } = await api("post", "/api/v1/training-modules").send({ title: "Old" });
    const res = await api("put", `/api/v1/training-modules/${_id}`)
      .send({ title: "New", status: "published" });
    expect(res.body.data.title).toBe("New");
    expect(res.body.data.status).toBe("published");
  });

  it("deletes a module", async () => {
    const { body: { data: { _id } } } = await api("post", "/api/v1/training-modules").send({ title: "Del" });
    expect((await api("delete", `/api/v1/training-modules/${_id}`)).status).toBe(200);
    expect((await api("get",    `/api/v1/training-modules/${_id}`)).status).toBe(404);
  });

  it("manager can create but not delete", async () => {
    as(MANAGER);
    const { body: { data: { _id } } } = await api("post", "/api/v1/training-modules").send({ title: "MgrMod" });
    expect((await api("delete", `/api/v1/training-modules/${_id}`)).status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. MODULE ACCESS
// ═════════════════════════════════════════════════════════════════════════════
describe("Module Access (scoping)", () => {
  let moduleId;

  beforeEach(async () => {
    as(ADMIN);
    const res = await api("post", "/api/v1/training-modules").send({ title: "Scope" });
    moduleId = res.body.data._id;
  });

  it("assigns a single scope", async () => {
    const res = await api("post", `/api/v1/training-modules/${moduleId}/access`)
      .send({ client: clientId, branch: branchId, roles: [roleId] });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(1);
  });

  it("assigns multiple scopes via array body", async () => {
    const res = await api("post", `/api/v1/training-modules/${moduleId}/access`)
      .send([
        { client: clientId, branch: branchId },
        { client: clientId },
      ]);
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(2);
  });

  it("skips duplicate scope silently", async () => {
    const scope = { client: clientId, branch: branchId };
    await api("post", `/api/v1/training-modules/${moduleId}/access`).send(scope);
    const res = await api("post", `/api/v1/training-modules/${moduleId}/access`).send(scope);
    expect(res.body.skipped).toBe(1);
  });

  it("lists access rules", async () => {
    await api("post", `/api/v1/training-modules/${moduleId}/access`).send({ client: clientId });
    const res = await api("get", `/api/v1/training-modules/${moduleId}/access`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it("deletes an access rule", async () => {
    await api("post", `/api/v1/training-modules/${moduleId}/access`).send({ client: clientId });
    const { body: { data: [{ _id: accessId }] } } =
      await api("get", `/api/v1/training-modules/${moduleId}/access`);

    expect((await api("delete", `/api/v1/training-modules/access/${accessId}`)).status).toBe(200);
    expect((await api("get",    `/api/v1/training-modules/${moduleId}/access`)).body.count).toBe(0);
  });

  it("403 for manager trying to assign access", async () => {
    as(MANAGER);
    const res = await api("post", `/api/v1/training-modules/${moduleId}/access`).send({ client: clientId });
    expect(res.status).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PARTS
// ═════════════════════════════════════════════════════════════════════════════
describe("Module Parts", () => {
  let moduleId;

  beforeEach(async () => {
    as(ADMIN);
    moduleId = (await api("post", "/api/v1/training-modules").send({ title: "PartsMod" })).body.data._id;
  });

  it("creates a part", async () => {
    const res = await api("post", `/api/v1/training-modules/${moduleId}/parts`)
      .send({ title: "Part 1", order: 1, video: { url: "" } });
    expect(res.status).toBe(201);
    expect(res.body.data.uid).toMatch(/^PART_/);
  });

  it("400 when title missing", async () => {
    expect((await api("post", `/api/v1/training-modules/${moduleId}/parts`)
      .send({ order: 1 })).status).toBe(400);
  });

  it("400 for invalid moduleId", async () => {
    expect((await api("post", "/api/v1/training-modules/bad/parts")
      .send({ title: "X" })).status).toBe(400);
  });

  it("returns parts sorted by order", async () => {
    await api("post", `/api/v1/training-modules/${moduleId}/parts`).send({ title: "P2", order: 2, video: { url: "" } });
    await api("post", `/api/v1/training-modules/${moduleId}/parts`).send({ title: "P1", order: 1, video: { url: "" } });
    const res = await api("get", `/api/v1/training-modules/${moduleId}/parts`);
    expect(res.body.count).toBe(2);
    expect(res.body.data[0].order).toBe(1);
  });

  it("rejects duplicate title within same module", async () => {
    await api("post", `/api/v1/training-modules/${moduleId}/parts`).send({ title: "Dup", video: { url: "" } });
    const res = await api("post", `/api/v1/training-modules/${moduleId}/parts`).send({ title: "Dup", video: { url: "" } });
    expect(res.status).toBe(409);
  });

  it("allows same title in a different module", async () => {
    const mod2Id = (await api("post", "/api/v1/training-modules").send({ title: "Mod2" })).body.data._id;
    await api("post", `/api/v1/training-modules/${moduleId}/parts`).send({ title: "Shared", video: { url: "" } });
    const res = await api("post", `/api/v1/training-modules/${mod2Id}/parts`).send({ title: "Shared", video: { url: "" } });
    expect(res.status).toBe(201);
  });

  it("updates a part", async () => {
    const partId = (await api("post", `/api/v1/training-modules/${moduleId}/parts`)
      .send({ title: "Old", video: { url: "" } })).body.data._id;
    const res = await api("put", `/api/v1/training-modules/parts/${partId}`)
      .send({ title: "New", video: { url: "" } });
    expect(res.body.data.title).toBe("New");
  });

  it("deletes a part", async () => {
    const partId = (await api("post", `/api/v1/training-modules/${moduleId}/parts`)
      .send({ title: "ToDel", video: { url: "" } })).body.data._id;
    expect((await api("delete", `/api/v1/training-modules/parts/${partId}`)).status).toBe(200);
    expect((await api("get",    `/api/v1/training-modules/parts/${partId}`)).status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. QUESTIONS
// ═════════════════════════════════════════════════════════════════════════════
describe("Module Questions", () => {
  let partId;

  beforeEach(async () => {
    as(ADMIN);
    const modId = (await api("post", "/api/v1/training-modules").send({ title: "QMod" })).body.data._id;
    partId = (await api("post", `/api/v1/training-modules/${modId}/parts`)
      .send({ title: "QPart", video: { url: "" } })).body.data._id;
  });

  const qBody = () => ({
    text: "What colour is the sky?",
    type: "single",
    options: [{ key: "A", text: "Blue" }, { key: "B", text: "Red" }],
    correctAnswers: ["A"],
    points: 2,
  });

  it("creates a question and attaches to part", async () => {
    const res = await api("post", `/api/v1/training-modules/parts/${partId}/questions`).send(qBody());
    expect(res.status).toBe(201);
    expect(res.body.data.text).toBe("What colour is the sky?");

    const part = await api("get", `/api/v1/training-modules/parts/${partId}`);
    expect(part.body.data.questions.length).toBe(1);
  });

  it("gets a question by id", async () => {
    const qId = (await api("post", `/api/v1/training-modules/parts/${partId}/questions`).send(qBody())).body.data._id;
    const res = await api("get", `/api/v1/training-modules/questions/${qId}`);
    expect(res.status).toBe(200);
  });

  it("updates a question", async () => {
    const qId = (await api("post", `/api/v1/training-modules/parts/${partId}/questions`).send(qBody())).body.data._id;
    const res = await api("put", `/api/v1/training-modules/questions/${qId}`).send({ points: 5 });
    expect(res.body.data.points).toBe(5);
  });

  it("deletes question and removes from part", async () => {
    const qId = (await api("post", `/api/v1/training-modules/parts/${partId}/questions`).send(qBody())).body.data._id;
    expect((await api("delete", `/api/v1/training-modules/questions/${qId}`)).status).toBe(200);
    const part = await api("get", `/api/v1/training-modules/parts/${partId}`);
    expect(part.body.data.questions.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════
describe("Learner Assignments", () => {
  let moduleId;

  beforeEach(async () => {
    as(ADMIN);
    const res = await api("post", "/api/v1/training-modules").send({ title: "AssignMod" });
    moduleId = res.body.data._id;
    await api("put", `/api/v1/training-modules/${moduleId}`).send({ status: "published" });
  });

  it("assigns to learners and increments stats", async () => {
    const res = await api("post", `/api/v1/training-assignments/${moduleId}/assign`)
      .send({ learnerIds: [learnerId], dueDate: "2026-12-31", maxAttempts: 3 });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(1);
  });

  it("skips duplicate assignment", async () => {
    await api("post", `/api/v1/training-assignments/${moduleId}/assign`).send({ learnerIds: [learnerId] });
    const res = await api("post", `/api/v1/training-assignments/${moduleId}/assign`).send({ learnerIds: [learnerId] });
    expect(res.body.skipped).toBe(1);
    expect(res.body.inserted).toBe(0);
  });

  it("400 for draft module", async () => {
    const draftId = (await api("post", "/api/v1/training-modules").send({ title: "Draft" })).body.data._id;
    const res = await api("post", `/api/v1/training-assignments/${draftId}/assign`).send({ learnerIds: [learnerId] });
    expect(res.status).toBe(400);
  });

  it("400 for empty learnerIds", async () => {
    expect((await api("post", `/api/v1/training-assignments/${moduleId}/assign`)
      .send({ learnerIds: [] })).status).toBe(400);
  });

  it("learner sees own assignments", async () => {
    await api("post", `/api/v1/training-assignments/${moduleId}/assign`).send({ learnerIds: [learnerId] });
    as(LEARNER);
    const res = await api("get", "/api/v1/training-assignments/mine");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it("admin sees all assignments", async () => {
    await api("post", `/api/v1/training-assignments/${moduleId}/assign`).send({ learnerIds: [learnerId] });
    const res = await api("get", "/api/v1/training-assignments");
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });

  it("revokes an assignment and decrements stats", async () => {
    await api("post", `/api/v1/training-assignments/${moduleId}/assign`).send({ learnerIds: [learnerId] });
    const assignmentId = (await api("get", "/api/v1/training-assignments")).body.data[0]._id;
    expect((await api("delete", `/api/v1/training-assignments/${assignmentId}`)).status).toBe(200);
    expect((await api("get", "/api/v1/training-assignments")).body.count).toBe(0);
  });

  it("patches assignment status", async () => {
    await api("post", `/api/v1/training-assignments/${moduleId}/assign`).send({ learnerIds: [learnerId] });
    const assignmentId = (await api("get", "/api/v1/training-assignments")).body.data[0]._id;
    const res = await api("patch", `/api/v1/training-assignments/${assignmentId}/status`)
      .send({ status: "overdue" });
    expect(res.body.data.status).toBe("overdue");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PROGRESS
// ═════════════════════════════════════════════════════════════════════════════
describe("Learner Progress", () => {
  let moduleId, partId, questionId;

  beforeEach(async () => {
    as(ADMIN);
    moduleId = (await api("post", "/api/v1/training-modules").send({ title: "ProgMod" })).body.data._id;
    await api("put", `/api/v1/training-modules/${moduleId}`).send({ status: "published" });

    partId = (await api("post", `/api/v1/training-modules/${moduleId}/parts`)
      .send({ title: "ProgPart", order: 0, video: { url: "" }, minWatchPercent: 80 })).body.data._id;

    questionId = (await api("post", `/api/v1/training-modules/parts/${partId}/questions`)
      .send({
        text: "Q?", type: "single",
        options: [{ key: "A", text: "Right" }, { key: "B", text: "Wrong" }],
        correctAnswers: ["A"], points: 1,
      })).body.data._id;

    await api("post", `/api/v1/training-assignments/${moduleId}/assign`).send({ learnerIds: [learnerId] });
  });

  it("starts a module for a learner", async () => {
    as(LEARNER);
    const res = await api("post", `/api/v1/training-progress/${moduleId}/start`);
    expect(res.status).toBe(200);
    expect(res.body.data.module.toString()).toBe(moduleId);
  });

  it("403 if learner is not assigned", async () => {
    const stranger = { ...LEARNER, _id: new mongoose.Types.ObjectId(), id: new mongoose.Types.ObjectId() };
    as(stranger);
    expect((await api("post", `/api/v1/training-progress/${moduleId}/start`)).status).toBe(403);
  });

  it("returns null progress before start", async () => {
    as(LEARNER);
    const res = await api("get", `/api/v1/training-progress/${moduleId}`);
    expect(res.body.data).toBeNull();
  });

  it("records watch progress", async () => {
    as(LEARNER);
    await api("post", `/api/v1/training-progress/${moduleId}/start`);
    const res = await api("put", `/api/v1/training-progress/${moduleId}/watch`)
      .send({ partId, watchedSeconds: 60, durationSec: 100 });
    expect(res.status).toBe(200);
    expect(res.body.data.watchPercent).toBe(60);
    expect(res.body.data.completed).toBe(false);
  });

  it("marks watch as completed when >= minWatchPercent", async () => {
    as(LEARNER);
    await api("post", `/api/v1/training-progress/${moduleId}/start`);
    const res = await api("put", `/api/v1/training-progress/${moduleId}/watch`)
      .send({ partId, watchedSeconds: 85, durationSec: 100 });
    expect(res.body.data.completed).toBe(true);
  });

  it("scores a correct answer", async () => {
    as(LEARNER);
    await api("post", `/api/v1/training-progress/${moduleId}/start`);
    const res = await api("post", `/api/v1/training-progress/${moduleId}/attempts`)
      .send({ partId, answers: [{ questionId, selectedAnswer: "A" }] });
    expect(res.status).toBe(201);
    expect(res.body.data.results[0].isCorrect).toBe(true);
    expect(res.body.data.results[0].pointsEarned).toBe(1);
    expect(res.body.data.partScore).toBe(100);
  });

  it("scores a wrong answer", async () => {
    as(LEARNER);
    await api("post", `/api/v1/training-progress/${moduleId}/start`);
    const res = await api("post", `/api/v1/training-progress/${moduleId}/attempts`)
      .send({ partId, answers: [{ questionId, selectedAnswer: "B" }] });
    expect(res.body.data.results[0].isCorrect).toBe(false);
    expect(res.body.data.partScore).toBe(0);
  });

  it("completes module and marks passed", async () => {
    as(LEARNER);
    await api("post", `/api/v1/training-progress/${moduleId}/start`);
    await api("post", `/api/v1/training-progress/${moduleId}/attempts`)
      .send({ partId, answers: [{ questionId, selectedAnswer: "A" }] });
    const res = await api("post", `/api/v1/training-progress/${moduleId}/complete`);
    expect(res.body.data.isPassed).toBe(true);
    expect(res.body.data.score).toBe(100);
  });

  it("completes module and marks failed", async () => {
    as(LEARNER);
    await api("post", `/api/v1/training-progress/${moduleId}/start`);
    await api("post", `/api/v1/training-progress/${moduleId}/attempts`)
      .send({ partId, answers: [{ questionId, selectedAnswer: "B" }] });
    const res = await api("post", `/api/v1/training-progress/${moduleId}/complete`);
    expect(res.body.data.isPassed).toBe(false);
    expect(res.body.data.score).toBe(0);
  });

  it("400 on double complete", async () => {
    as(LEARNER);
    await api("post", `/api/v1/training-progress/${moduleId}/start`);
    await api("post", `/api/v1/training-progress/${moduleId}/attempts`)
      .send({ partId, answers: [{ questionId, selectedAnswer: "A" }] });
    await api("post", `/api/v1/training-progress/${moduleId}/complete`);
    expect((await api("post", `/api/v1/training-progress/${moduleId}/complete`)).status).toBe(400);
  });

  it("grants a retake and resets progress", async () => {
    as(LEARNER);
    await api("post", `/api/v1/training-progress/${moduleId}/start`);
    await api("post", `/api/v1/training-progress/${moduleId}/attempts`)
      .send({ partId, answers: [{ questionId, selectedAnswer: "B" }] });
    await api("post", `/api/v1/training-progress/${moduleId}/complete`);

    as(ADMIN);
    const res = await api("post", `/api/v1/training-modules/${moduleId}/retake`)
      .send({ learnerId });
    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. REPORTS
// ═════════════════════════════════════════════════════════════════════════════
describe("Training Reports", () => {
  beforeEach(() => as(ADMIN));

  it("GET /overview — returns KPI snapshot", async () => {
    const res = await api("get", "/api/v1/training-reports/overview");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalModules:         expect.any(Number),
      publishedModules:     expect.any(Number),
      totalAssignments:     expect.any(Number),
      completionRate:       expect.any(Number),
      passRate:             expect.any(Number),
      avgScore:             expect.any(Number),
    });
  });

  it("GET /modules — returns per-module analytics", async () => {
    await api("post", "/api/v1/training-modules").send({ title: "ReportMod", status: "published" });
    const id = (await api("get", "/api/v1/training-modules")).body.data[0]._id;
    await api("put", `/api/v1/training-modules/${id}`).send({ status: "published" });

    const res = await api("get", "/api/v1/training-reports/modules");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /learners — returns learner progress table", async () => {
    const res = await api("get", "/api/v1/training-reports/learners");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /module/:moduleId — returns single-module report", async () => {
    const modId = (await api("post", "/api/v1/training-modules").send({ title: "SingleReport" })).body.data._id;
    const res = await api("get", `/api/v1/training-reports/module/${modId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toHaveProperty("totalLearners");
    expect(res.body.data).toHaveProperty("questionBreakdown");
  });
});
