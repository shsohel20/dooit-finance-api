require("./setup");
process.env.FRONTEND_URL = "https://app.dooit.test";
const { makeStore } = require("./fakes");

const mockRequests = makeStore();
const mockClients = makeStore();
const mockUsers = makeStore();
const mockTypes = makeStore();
const mockSignups = makeStore();
let mockXeroConnectionRows = [];

jest.mock("../../models/XeroConnectionRequest", () => {
  const model = {
    create: (d) =>
      mockRequests.create({ status: "PENDING_CONFIRMATION", usedAt: null, continuedAt: null, approvedAt: null, createdAt: new Date(), ...d }),
    findOne: (f) => mockRequests.findOne(f),
    findById: (i) => mockRequests.findById(i),
    find: (f) => mockRequests.find(f),
    updateOne: (f, u) => mockRequests.updateOne(f, u),
    findOneAndUpdate: (f, u, o) => mockRequests.findOneAndUpdate(f, u, o),
  };
  model.REQUEST_STATUS = { PENDING: "PENDING_CONFIRMATION", APPROVED: "APPROVED", REJECTED: "REJECTED", EXPIRED: "EXPIRED" };
  return model;
});
jest.mock("../../models/XeroConnection", () => ({
  findOne: (f) => {
    const r = mockXeroConnectionRows.find((x) => x.tenantId === f.tenantId) || null;
    const p = Promise.resolve(r);
    p.sort = () => ({ lean: async () => r });
    return p;
  },
}));
jest.mock("../../models/Client", () => ({
  findById: async (id) => mockClients.rows.find((c) => c._id === id) || null,
  findOne: async (f) => {
    if (f.registrationNumber) return mockClients.rows.find((c) => c.registrationNumber === f.registrationNumber) || null;
    if (f.name instanceof RegExp) return mockClients.rows.find((c) => f.name.test(c.name)) || null;
    return null;
  },
}));
jest.mock("../../models/User", () => ({ findOne: (f) => mockUsers.findOne(f) }));
jest.mock("../../models/UserType", () => ({ findOne: (f) => mockTypes.findOne(f), create: jest.fn() }));
jest.mock("../../models/XeroSignup", () => ({
  create: (d) => mockSignups.create({ ticketUsed: false, loginCodeUsed: false, createdAt: new Date(), ...d }),
  updateOne: (f, u) => mockSignups.updateOne(f, u),
}));
jest.mock("../../utils/sendEmail", () => jest.fn());
jest.mock("../../utils/rawUserFields", () => ({ getRawEmail: jest.fn() }));
jest.mock("../../utils/encryption", () => ({
  ...jest.requireActual("../../utils/encryption"),
  hashForSearch: (e) => `h:${String(e).toLowerCase()}`,
}));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn(), hashPayload: jest.fn() }));
jest.mock("../../services/xero/oauth", () => ({
  ...jest.requireActual("../../services/xero/oauth"),
  tokenRequest: jest.fn(), fetchConnections: jest.fn(),
}));
jest.mock("../../services/xero/client", () => ({ upsertConnection: jest.fn() }));

const sendEmail = require("../../utils/sendEmail");
const { getRawEmail } = require("../../utils/rawUserFields");
const { logSync } = require("../../services/xero/syncLog");
const oauth = require("../../services/xero/oauth");
const xero = require("../../services/xero/client");
const svc = require("../../services/xero/connectionRequestService");
const tpl = require("../../utils/email-template/xeroEmailTemplate");

const CLIENT = { _id: "c1", name: "ABC Trading Ltd", email: "admin@abc.com", registrationNumber: "ABN-1" };
const TENANT = { tenantId: "t1", id: "cn1", tenantName: "ABC Trading Ltd" };
const IDENTITY = { email: "accounts@abc.com", givenName: "John", familyName: "Smith", xeroUserId: "xu1" };
const TOKENS = { accessToken: "xero-access-SECRET", refreshToken: "xero-refresh-SECRET", expiresAt: new Date(Date.now() + 1.8e6), scopes: ["openid"] };
const ADMIN = { id: "u-admin", userType: "client", role: "admin", clientBelongs: "c1" };

const open = (over = {}) =>
  svc.createRequest({ match: { client: mockClients.rows[0], matchedBy: "tenant" }, tenant: TENANT, org: { Name: "ABC Trading Ltd" }, identity: IDENTITY, tokens: TOKENS, ...over });

/** The approver token only exists in the emailed link — pull it back out of it. */
const emailedToken = (callIdx = 0) => /\/auth\/xero\/confirm\/([0-9a-f]{64})/.exec(sendEmail.mock.calls[callIdx][0].message)[1];

const xeroAcceptsRefresh = () => {
  oauth.tokenRequest.mockResolvedValue({ status: 200, data: { access_token: "AT2", refresh_token: "RT2", expires_in: 1800, scope: "openid" } });
  oauth.fetchConnections.mockResolvedValue([{ id: "cn1", tenantId: "t1", tenantName: "ABC Trading Ltd" }]);
};

beforeEach(() => {
  [mockRequests, mockClients, mockUsers, mockTypes, mockSignups].forEach((s) => s.reset());
  mockXeroConnectionRows = [];
  mockClients.rows.push({ ...CLIENT });
  jest.clearAllMocks();
  sendEmail.mockResolvedValue();
  xeroAcceptsRefresh();
  xero.upsertConnection.mockResolvedValue({});
});

const events = () => logSync.mock.calls.map(([e]) => e.action);

describe("matching an organisation to an existing client", () => {
  it("prefers the Xero tenant id — any historical connection row, even if revoked", async () => {
    mockXeroConnectionRows.push({ tenantId: "t9", companyId: "c1", status: "revoked" });
    expect((await svc.findExistingClient({ tenantId: "t9", org: { Name: "Totally Different Name" } })).matchedBy).toBe("tenant");
  });
  it("falls back to ABN, then exact name — each only ever leads to an email", async () => {
    expect((await svc.findExistingClient({ tenantId: "new", org: { RegistrationNumber: "ABN-1", Name: "x" } })).matchedBy).toBe("registrationNumber");
    expect((await svc.findExistingClient({ tenantId: "new", org: { Name: "abc trading ltd" } })).matchedBy).toBe("name");
  });
  it("matches nothing for an unknown organisation (→ the normal new-client flow)", async () => {
    expect(await svc.findExistingClient({ tenantId: "new", org: { Name: "Nobody Ltd", RegistrationNumber: "ABN-2" } })).toBeNull();
  });
  it("does not treat a name that merely contains another name as a match", async () => {
    expect(await svc.findExistingClient({ tenantId: "new", org: { Name: "ABC Trading" } })).toBeNull();
  });
  it("masks emails", () => {
    expect(svc.maskEmail("admin@abc.com")).toBe("a***@abc.com");
    expect(svc.maskEmail("nonsense")).toBe("***");
  });
});

describe("existing client: request created, email sent, nothing connected", () => {
  it("creates a pending request and emails the registered address only", async () => {
    const out = await open();
    expect(out).toMatchObject({ maskedEmail: "a***@abc.com", reused: false });

    const r = mockRequests.rows[0];
    expect(r).toMatchObject({ status: "PENDING_CONFIRMATION", clientId: "c1", xeroTenantId: "t1", requesterEmail: "accounts@abc.com", targetEmail: "admin@abc.com" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ email: "admin@abc.com", subject: expect.stringContaining("Confirm Xero connection") });
    const html = sendEmail.mock.calls[0][0].message;
    expect(html).toContain("accounts@abc.com");
    expect(html).toContain("John Smith");
    expect(html).toContain("https://app.dooit.test/auth/xero/confirm/");
    expect(html).toContain("?action=reject");

    // Security boundary: no connection, no login, nothing granted.
    expect(xero.upsertConnection).not.toHaveBeenCalled();
    expect(out.loginCode).toBeUndefined();
    expect(events()).toEqual(expect.arrayContaining(["XERO_CONNECTION_REQUEST_CREATED", "XERO_CONNECTION_REQUEST_EMAIL_SENT"]));
  });

  it("stores only hashes of the secrets, and the Xero tokens only as ciphertext", async () => {
    const out = await open();
    const token = emailedToken();
    const dump = JSON.stringify(mockRequests.rows);
    [token, out.requesterToken, "xero-access-SECRET", "xero-refresh-SECRET"].forEach((secret) => expect(dump).not.toContain(secret));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(out.requesterToken);
  });

  it("keeps secrets and internals out of the audit metadata (email masked, no tokens)", async () => {
    await open();
    const metas = JSON.stringify(logSync.mock.calls.map(([e]) => e.meta));
    expect(metas).not.toContain(emailedToken());
    expect(metas).not.toContain("admin@abc.com");
    expect(metas).toContain("a***@abc.com");
  });

  it("falls back to the owning user's email when the client has none", async () => {
    mockClients.rows[0] = { ...CLIENT, email: undefined, user: "u1" };
    getRawEmail.mockResolvedValue("Owner@ABC.com");
    await open();
    expect(sendEmail.mock.calls[0][0].email).toBe("owner@abc.com");
  });

  it("refuses (and sends nothing) when the client has no registered email", async () => {
    mockClients.rows[0] = { ...CLIENT, email: undefined };
    await expect(open()).rejects.toMatchObject({ statusCode: 409 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mockRequests.rows).toHaveLength(0);
  });

  it("closes the request and reports a 502 if the email cannot be sent", async () => {
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    await expect(open()).rejects.toMatchObject({ statusCode: 502 });
    expect(mockRequests.rows[0].status).toBe("EXPIRED");
    expect(mockRequests.rows[0].accessToken).toBeUndefined(); // secrets dropped
  });
});

describe("duplicate request protection", () => {
  it("same requester retrying inside the cooldown reuses the request: no second email, new status handle", async () => {
    const first = await open();
    const again = await open();
    expect(again.reused).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mockRequests.rows).toHaveLength(1);
    expect(again.requesterToken).not.toBe(first.requesterToken);
    await expect(svc.getRequesterStatus(first.requesterToken)).rejects.toMatchObject({ statusCode: 404 }); // old handle dead
    expect((await svc.getRequesterStatus(again.requesterToken)).status).toBe("PENDING_CONFIRMATION");
  });

  it("a different requester supersedes the live request — only one stays pending and the old link dies", async () => {
    await open();
    const oldToken = emailedToken(0);
    await open({ identity: { ...IDENTITY, email: "someone.else@xero.com" } });

    const pending = mockRequests.rows.filter((r) => r.status === "PENDING_CONFIRMATION");
    expect(pending).toHaveLength(1);
    expect(pending[0].requesterEmail).toBe("someone.else@xero.com");
    expect(mockRequests.rows.find((r) => r.requesterEmail === "accounts@abc.com").status).toBe("EXPIRED");
    await expect(svc.approve({ token: oldToken, user: ADMIN })).rejects.toMatchObject({ statusCode: 410 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("after the cooldown the same requester gets a fresh request and email", async () => {
    await open();
    mockRequests.rows[0].createdAt = new Date(Date.now() - svc.RESEND_COOLDOWN_MS - 1000);
    await open();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(mockRequests.rows.filter((r) => r.status === "PENDING_CONFIRMATION")).toHaveLength(1);
  });
});

describe("approval page data", () => {
  it("shows the organisation and requester — nothing about the client", async () => {
    await open();
    const data = await svc.getForApprover(emailedToken());
    expect(data).toMatchObject({ status: "PENDING_CONFIRMATION", organisation: "ABC Trading Ltd", requester: { name: "John Smith", email: "accounts@abc.com" } });
    expect(JSON.stringify(data)).not.toMatch(/admin@abc|c1|clientId/);
  });
  it("gives the same generic answer for unknown / malformed tokens", async () => {
    for (const t of ["nope", "", undefined, "x".repeat(500)]) {
      await expect(svc.getForApprover(t)).rejects.toMatchObject({ statusCode: 404, message: expect.stringMatching(/invalid or has expired/) });
    }
  });
});

describe("approval", () => {
  it("links the tenant to the existing client, marks APPROVED, invalidates the token, audits and notifies", async () => {
    const { requesterToken } = await open();
    const token = emailedToken();

    const out = await svc.approve({ token, user: ADMIN });
    expect(out).toMatchObject({ status: "APPROVED", organisation: "ABC Trading Ltd" });

    // Re-verified with Xero using the stored authorisation, then linked with the FRESH tokens.
    expect(oauth.tokenRequest).toHaveBeenCalledWith(expect.objectContaining({ grant_type: "refresh_token", refresh_token: "xero-refresh-SECRET" }));
    expect(xero.upsertConnection).toHaveBeenCalledWith({
      tokens: expect.objectContaining({ accessToken: "AT2", refreshToken: "RT2" }),
      tenant: expect.objectContaining({ tenantId: "t1" }),
      userId: "u-admin", companyId: "c1",
    });

    const r = mockRequests.rows[0];
    expect(r).toMatchObject({ status: "APPROVED", decidedBy: "u-admin" });
    expect(r.usedAt).toBeInstanceOf(Date);
    expect(r.approvedAt).toBeInstanceOf(Date);
    expect(r.accessToken).toBeUndefined(); // Xero tokens wiped once decided
    expect(r.refreshToken).toBeUndefined();

    expect(events()).toEqual(expect.arrayContaining(["XERO_CONNECTION_REQUEST_APPROVED", "XERO_TENANT_LINKED"]));
    expect(sendEmail).toHaveBeenCalledTimes(2); // approval request + requester notification
    expect(sendEmail.mock.calls[1][0]).toMatchObject({ email: "accounts@abc.com", subject: expect.stringContaining("approved") });
    expect((await svc.getRequesterStatus(requesterToken)).status).toBe("APPROVED");
  });

  it("cannot be replayed once used", async () => {
    await open();
    const token = emailedToken();
    await svc.approve({ token, user: ADMIN });
    await expect(svc.approve({ token, user: ADMIN })).rejects.toMatchObject({ statusCode: 410 });
    await expect(svc.reject({ token })).rejects.toMatchObject({ statusCode: 410 });
    expect(xero.upsertConnection).toHaveBeenCalledTimes(1);
  });

  it("two simultaneous approvals link exactly once", async () => {
    await open();
    const token = emailedToken();
    const results = await Promise.allSettled([svc.approve({ token, user: ADMIN }), svc.approve({ token, user: ADMIN })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(xero.upsertConnection).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no user", undefined],
    ["a staff member (not an admin)", { ...ADMIN, role: "user" }],
    ["an admin of a DIFFERENT client", { ...ADMIN, clientBelongs: "c2" }],
    ["a dooit platform user", { id: "d1", userType: "dooit", role: "admin", clientBelongs: null }],
    ["a customer", { id: "x", userType: "customer", role: "admin", clientBelongs: "c1" }],
  ])("is refused for %s — and the request stays pending", async (_n, user) => {
    await open();
    await expect(svc.approve({ token: emailedToken(), user })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRequests.rows[0].status).toBe("PENDING_CONFIRMATION");
    expect(xero.upsertConnection).not.toHaveBeenCalled();
  });

  it("the requester's own Xero identity / handle cannot approve", async () => {
    const { requesterToken } = await open();
    await expect(svc.approve({ token: requesterToken, user: ADMIN })).rejects.toMatchObject({ statusCode: 404 });
    expect(xero.upsertConnection).not.toHaveBeenCalled();
  });

  it("is refused after expiry", async () => {
    await open();
    const token = emailedToken();
    mockRequests.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.approve({ token, user: ADMIN })).rejects.toMatchObject({ statusCode: 410 });
    expect(mockRequests.rows[0].status).toBe("EXPIRED");
    expect(xero.upsertConnection).not.toHaveBeenCalled();
    expect(events()).toContain("XERO_CONNECTION_REQUEST_EXPIRED");
  });

  it("fails safely if the client has been deleted meanwhile", async () => {
    await open();
    const token = emailedToken();
    mockClients.reset();
    await expect(svc.approve({ token, user: ADMIN })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockRequests.rows[0].status).toBe("EXPIRED");
    expect(xero.upsertConnection).not.toHaveBeenCalled();
  });

  it("does not link if Xero no longer honours the authorisation (revoked)", async () => {
    await open();
    const token = emailedToken();
    oauth.tokenRequest.mockResolvedValue({ status: 400, data: { error: "invalid_grant" } });
    await expect(svc.approve({ token, user: ADMIN })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/start again/i) });
    expect(xero.upsertConnection).not.toHaveBeenCalled();
    expect(mockRequests.rows[0].status).toBe("EXPIRED");
  });

  it("does not link a different Xero tenant than the one that was requested", async () => {
    await open();
    const token = emailedToken();
    oauth.fetchConnections.mockResolvedValue([{ id: "cnX", tenantId: "OTHER-TENANT", tenantName: "Other Org" }]);
    await expect(svc.approve({ token, user: ADMIN })).rejects.toMatchObject({ statusCode: 409 });
    expect(xero.upsertConnection).not.toHaveBeenCalled();
  });

  it("leaves the request dead (not half-linked) if the final link fails", async () => {
    await open();
    xero.upsertConnection.mockRejectedValueOnce(Object.assign(new Error("org already connected"), { statusCode: 409 }));
    await expect(svc.approve({ token: emailedToken(), user: ADMIN })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockRequests.rows[0].status).toBe("EXPIRED");
  });
});

describe("rejection", () => {
  it("marks REJECTED, connects nothing, invalidates the token, audits and notifies the requester", async () => {
    await open();
    const token = emailedToken();
    const out = await svc.reject({ token });

    expect(out.status).toBe("REJECTED");
    const r = mockRequests.rows[0];
    expect(r).toMatchObject({ status: "REJECTED" });
    expect(r.rejectedAt).toBeInstanceOf(Date);
    expect(r.refreshToken).toBeUndefined();
    expect(xero.upsertConnection).not.toHaveBeenCalled();
    expect(events()).toContain("XERO_CONNECTION_REQUEST_REJECTED");
    expect(sendEmail.mock.calls[1][0]).toMatchObject({ email: "accounts@abc.com", subject: expect.stringContaining("declined") });
    expect(sendEmail.mock.calls[1][0].message).not.toMatch(/admin@abc\.com/); // client details not revealed

    await expect(svc.approve({ token, user: ADMIN })).rejects.toMatchObject({ statusCode: 410 });
    await expect(svc.reject({ token })).rejects.toMatchObject({ statusCode: 410 });
  });
});

describe("expiry sweep", () => {
  it("expires lapsed pending requests, audits once and frees the pair for a new request", async () => {
    await open();
    mockRequests.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await svc.expireDue()).toBe(1);
    expect(mockRequests.rows[0].status).toBe("EXPIRED");
    expect(events().filter((a) => a === "XERO_CONNECTION_REQUEST_EXPIRED")).toHaveLength(1);
    expect(await svc.expireDue()).toBe(0);

    await open(); // restart is allowed
    expect(mockRequests.rows.filter((r) => r.status === "PENDING_CONFIRMATION")).toHaveLength(1);
  });
});

describe("requester side", () => {
  it("shows pending status with a masked address — never the full one", async () => {
    const { requesterToken } = await open();
    const s = await svc.getRequesterStatus(requesterToken);
    expect(s).toMatchObject({ status: "PENDING_CONFIRMATION", maskedEmail: "a***@abc.com", organisation: "ABC Trading Ltd" });
    expect(JSON.stringify(s)).not.toContain("admin@abc.com");
  });

  it("cannot continue before approval, or with someone else's handle", async () => {
    const a = await open();
    await expect(svc.continueAsRequester(a.requesterToken)).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.continueAsRequester("forged")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("after approval, lets in only an EXISTING member of that client — with their own membership, once", async () => {
    const { requesterToken } = await open();
    const u = await mockUsers.create({ email: "accounts@abc.com", emailHash: "h:accounts@abc.com" });
    const m = await mockTypes.create({ user: u._id, userType: "client", role: "user", clientBelongs: "c1", isActive: true });
    await svc.approve({ token: emailedToken(), user: ADMIN });

    const out = await svc.continueAsRequester(requesterToken);
    expect(out.next).toBe("signed_in");
    expect(out.loginCode).toMatch(/^[0-9a-f]{64}$/);
    expect(mockSignups.rows[0]).toMatchObject({ userId: u._id, clientId: "c1", membershipId: m._id });
    expect(require("../../models/UserType").create).not.toHaveBeenCalled(); // nothing new granted

    await expect(svc.continueAsRequester(requesterToken)).rejects.toMatchObject({ statusCode: 410 }); // single use
  });

  it("grants no access to a requester who is not already a member: they are sent to sign in", async () => {
    const { requesterToken } = await open();
    await svc.approve({ token: emailedToken(), user: ADMIN });
    expect(await svc.continueAsRequester(requesterToken)).toEqual({ next: "login" });
    expect(mockSignups.rows).toHaveLength(0);
  });

  it("a member of a DIFFERENT client gets no access to this one", async () => {
    const { requesterToken } = await open();
    const u = await mockUsers.create({ email: "accounts@abc.com", emailHash: "h:accounts@abc.com" });
    await mockTypes.create({ user: u._id, userType: "client", role: "admin", clientBelongs: "c-other", isActive: true });
    await svc.approve({ token: emailedToken(), user: ADMIN });
    expect(await svc.continueAsRequester(requesterToken)).toEqual({ next: "login" });
  });

  it("stops working after the continue window", async () => {
    const { requesterToken } = await open();
    await svc.approve({ token: emailedToken(), user: ADMIN });
    mockRequests.rows[0].approvedAt = new Date(Date.now() - 31 * 60 * 1000);
    await expect(svc.continueAsRequester(requesterToken)).rejects.toMatchObject({ statusCode: 410 });
  });
});

describe("email template", () => {
  it("escapes everything that comes from Xero (no HTML/script injection)", () => {
    const evil = '<script>alert(1)</script>"><img src=x onerror=alert(1)>';
    const html = tpl.xeroConnectionApprovalHtml({ organisationName: evil, requesterName: evil, requesterEmail: evil, approveUrl: 'https://x/"onmouseover="a', rejectUrl: "https://x" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('"onmouseover="a');
    expect(html).toContain("&lt;script&gt;");
  });
  it("has both actions and the safety guidance", () => {
    const html = tpl.xeroConnectionApprovalHtml({ organisationName: "ABC", requesterEmail: "a@b.c", approveUrl: "https://a", rejectUrl: "https://r", expiresInMinutes: 30 });
    expect(html).toMatch(/Approve Xero Connection/);
    expect(html).toMatch(/Reject Request/);
    expect(html).toMatch(/If you approve/);
    expect(html).toMatch(/If you reject/);
    expect(html).toMatch(/expires in\s+30 minutes/);
  });
});
