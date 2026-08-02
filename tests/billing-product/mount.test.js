// Verifies the billing routers are reachable through routes/index.js —
// the other suites mount the sub-routers directly, so a missing line in
// routes/index.js would not be caught by them.
const { connect, disconnect, clearAll, makeUser } = require("./setup");

const request = require("supertest");
const express = require("express");
const cookieParser = require("cookie-parser");

let app;
let dooit;

beforeAll(async () => {
  await connect();
  const errorHandler = require("../../middleware/error");
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/v1", require("../../routes/index"));
  app.use(errorHandler);
});

afterAll(disconnect);

beforeEach(async () => {
  await clearAll();
  dooit = await makeUser({ userType: "dooit", email: "mount@dooit.ai" });
});

describe("routes/index.js mounting", () => {
  it("mounts /api/v1/product", async () => {
    const res = await request(app)
      .get("/api/v1/product")
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("mounts /api/v1/billing-plan", async () => {
    const res = await request(app)
      .get("/api/v1/billing-plan")
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("mounts the plan sub-routes (not swallowed by /:id)", async () => {
    // /:id is declared last so these resolve to their own handlers; if the
    // ordering regressed, publish would be parsed as a plan id and 404.
    const res = await request(app)
      .post("/api/v1/billing-plan/000000000000000000000000/publish")
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/plan not found/i);
  });

  it("mounts the product sub-routes", async () => {
    const res = await request(app)
      .get("/api/v1/product/categories")
      .set("Authorization", dooit.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(8);
  });
});
