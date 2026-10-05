require("./setup");
const request = require("supertest");
const express = require("express");
const cookieParser = require("cookie-parser");

const mockSvc = {
  getForApprover: jest.fn(), approve: jest.fn(), reject: jest.fn(),
  getRequesterStatus: jest.fn(), continueAsRequester: jest.fn(),
};
jest.mock("../../services/xero/connectionRequestService", () => ({
  getForApprover: (...a) => mockSvc.getForApprover(...a), approve: (...a) => mockSvc.approve(...a),
  reject: (...a) => mockSvc.reject(...a), getRequesterStatus: (...a) => mockSvc.getRequesterStatus(...a),
  continueAsRequester: (...a) => mockSvc.continueAsRequester(...a), expireDue: jest.fn(),
}));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn(), hashPayload: jest.fn() }));

const errorHandler = require("../../middleware/error");
const routes = require("../../routes/xero");

const app = express();
// middleware/auth.js reads req.cookies; server.js installs cookie-parser, so must the test app.
app.use(cookieParser());
app.use("/xero", routes);
app.use(errorHandler);

const TOKEN = "a".repeat(64);
beforeEach(() => jest.clearAllMocks());

describe("approval routes", () => {
  it("GET details is public (the emailed token is the credential)", async () => {
    mockSvc.getForApprover.mockResolvedValue({ status: "PENDING_CONFIRMATION", organisation: "ABC" });
    const res = await request(app).get(`/xero/connection-requests/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data.organisation).toBe("ABC");
    expect(mockSvc.getForApprover).toHaveBeenCalledWith(TOKEN);
  });

  it("approve requires a signed-in user: no credentials → 401 and the service is never reached", async () => {
    const res = await request(app).post(`/xero/connection-requests/${TOKEN}/approve`);
    expect(res.status).toBe(401);
    expect(mockSvc.approve).not.toHaveBeenCalled();
  });

  it("approve rejects a forged bearer token", async () => {
    const res = await request(app).post(`/xero/connection-requests/${TOKEN}/approve`).set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
    expect(mockSvc.approve).not.toHaveBeenCalled();
  });

  it("reject needs only the emailed token (the safe direction)", async () => {
    mockSvc.reject.mockResolvedValue({ status: "REJECTED" });
    const res = await request(app).post(`/xero/connection-requests/${TOKEN}/reject`);
    expect(res.status).toBe(200);
    expect(mockSvc.reject).toHaveBeenCalledWith({ token: TOKEN });
  });

  it("surfaces service errors in the app's standard shape", async () => {
    mockSvc.getForApprover.mockRejectedValue(Object.assign(new Error("This confirmation link is invalid or has expired."), { statusCode: 404 }));
    const res = await request(app).get(`/xero/connection-requests/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: expect.stringMatching(/invalid or has expired/) });
  });
});

describe("requester routes", () => {
  it("status is polled with the requester handle", async () => {
    mockSvc.getRequesterStatus.mockResolvedValue({ status: "PENDING_CONFIRMATION", maskedEmail: "a***@abc.com" });
    const res = await request(app).get("/xero/signup/pending").query({ token: "r-token" });
    expect(res.status).toBe(200);
    expect(mockSvc.getRequesterStatus).toHaveBeenCalledWith("r-token");
    expect(res.body.data.maskedEmail).toBe("a***@abc.com");
  });

  it("continue takes the handle in the body", async () => {
    mockSvc.continueAsRequester.mockResolvedValue({ next: "login" });
    const res = await request(app).post("/xero/signup/pending/continue").send({ token: "r-token" });
    expect(res.status).toBe(200);
    expect(mockSvc.continueAsRequester).toHaveBeenCalledWith("r-token");
  });
});
