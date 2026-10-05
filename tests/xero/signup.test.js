require("./setup");
const jwt = require("jsonwebtoken");
const { makeStore } = require("./fakes");

const mockSignups = makeStore();
const mockUsers = makeStore();
const mockClients = makeStore();
const mockTypes = makeStore();
const mockStates = makeStore();
const mockCreateEmailKey = (e) => `h:${e}`;

jest.mock("../../models/XeroSignup", () => ({
  // Schema defaults the real model would apply.
  create: (d) => mockSignups.create({ ticketUsed: false, loginCodeUsed: false, createdAt: new Date(), ...d }), findOne: (f) => mockSignups.findOne(f), findById: (i) => mockSignups.findById(i),
  updateOne: (f, u) => mockSignups.updateOne(f, u), deleteOne: (f) => mockSignups.deleteOne(f),
  findOneAndUpdate: (f, u, o) => mockSignups.findOneAndUpdate(f, u, o),
}));
jest.mock("../../models/XeroOAuthState", () => ({ create: (d) => mockStates.create(d), findOneAndDelete: (f) => mockStates.findOneAndDelete(f) }));
jest.mock("../../models/User", () => ({
  findOne: (f) => mockUsers.findOne(f.emailHash ? { emailHash: f.emailHash } : f),
  findById: (id) => mockUsers.findById(id),
  create: async (d) => { const u = await mockUsers.create({ ...d, emailHash: mockCreateEmailKey(d.email), getSignedJwtToken: (m) => `jwt-for-${m.userType}` }); return u; },
  deleteOne: (f) => mockUsers.deleteOne(f),
}));
jest.mock("../../models/Client", () => ({
  findOne: (f) => mockClients.findOne(f), create: (d) => mockClients.create(d), deleteOne: (f) => mockClients.deleteOne(f),
}));
jest.mock("../../models/UserType", () => ({
  findOne: (f) => mockTypes.findOne(f), create: (d) => mockTypes.create(d), deleteOne: (f) => mockTypes.deleteOne(f),
}));
jest.mock("../../models/EntityType", () => ({ find: () => ({ select: () => ({ sort: () => ({ lean: async () => [{ _id: "e1", name: "Accountants", category: "Tranche 2" }] }) }) }) }));
jest.mock("../../utils/encryption", () => ({
  ...jest.requireActual("../../utils/encryption"),
  hashForSearch: (e) => mockCreateEmailKey(e.toLowerCase()),
}));
jest.mock("../../utils", () => ({
  validateClientCreation: async (data, next) => {
    if (mockClients.rows.some((c) => c.name === data.name)) return next(Object.assign(new Error("Client with this name already exists!"), { statusCode: 400 }));
    return true;
  },
}));
jest.mock("../../services/xero/syncLog", () => ({ logSync: jest.fn(), hashPayload: jest.fn() }));
jest.mock("../../services/xero/oauth", () => ({
  ...jest.requireActual("../../services/xero/oauth"),
  exchangeCode: jest.fn(), fetchConnections: jest.fn(),
}));
jest.mock("../../services/xero/client", () => ({ getOrganisationWithToken: jest.fn(), upsertConnection: jest.fn() }));
jest.mock("../../services/xero/connectionRequestService", () => ({ findExistingClient: jest.fn(), createRequest: jest.fn() }));

const oauth = require("../../services/xero/oauth");
const xero = require("../../services/xero/client");
const m = require("../../services/xero/mappers");
const svc = require("../../services/xero/signupService");
const requests = require("../../services/xero/connectionRequestService");

const idToken = (over = {}) =>
  jwt.sign({ iss: "https://identity.xero.com", aud: "test-client-id", sub: "s1", xero_userid: "xu1", email: "Owner@Acme.com", given_name: "Olive", family_name: "Owner", nonce: "N1", ...over }, "x", { expiresIn: "5m" });

const ORG = {
  Name: "Acme Trading", LegalName: "Acme Pty Ltd", RegistrationNumber: "51824753556", TaxNumber: "TAX1", CountryCode: "AU", OrganisationType: "COMPANY",
  Addresses: [{ AddressType: "POBOX", AddressLine1: "PO Box 1", City: "X" }, { AddressType: "STREET", AddressLine1: "1 Main St", AddressLine2: "Level 2", City: "Sydney", Region: "NSW", PostalCode: "2000", Country: "Australia" }],
  Phones: [{ PhoneType: "FAX", PhoneNumber: "9" }, { PhoneType: "DEFAULT", PhoneCountryCode: "61", PhoneAreaCode: "2", PhoneNumber: "9000 0000" }],
  ExternalLinks: [{ LinkType: "Website", Url: "https://acme.example" }],
};

const runCallback = async (claims = {}) => {
  oauth.exchangeCode.mockResolvedValue({ accessToken: "AT", refreshToken: "RT", expiresAt: new Date(Date.now() + 1.8e6), scopes: ["openid"], idToken: idToken(claims) });
  oauth.fetchConnections.mockResolvedValue([{ id: "cn1", tenantId: "t1", tenantName: "Acme Trading", updatedDateUtc: "2026-01-01" }]);
  xero.getOrganisationWithToken.mockResolvedValue(ORG);
  return svc.handleSignupCallback({ code: "c", state: { nonce: "N1" } });
};

beforeEach(() => {
  [mockSignups, mockUsers, mockClients, mockTypes, mockStates].forEach((s) => s.reset());
  jest.clearAllMocks();
  requests.findExistingClient.mockResolvedValue(null);
  xero.upsertConnection.mockImplementation(async ({ companyId }) => ({ companyId, deleteOne: jest.fn() }));
});

describe("signup state + authorize URL", () => {
  it("adds openid/profile/email and the nonce for signup only", async () => {
    const { state, nonce } = await oauth.createSignupState();
    const u = new URL(oauth.buildAuthUrl(state, { signup: true, nonce }));
    expect(u.searchParams.get("scope").split(" ")).toEqual(expect.arrayContaining(["openid", "profile", "email", "offline_access", "accounting.contacts"]));
    expect(u.searchParams.get("nonce")).toBe(nonce);
    expect(mockStates.rows[0]).toMatchObject({ purpose: "signup", nonce });
    expect(new URL(oauth.buildAuthUrl("s")).searchParams.get("scope")).not.toContain("openid");
  });
});

describe("id_token validation", () => {
  it("accepts a good token", () => expect(oauth.readIdToken(idToken(), "N1").email).toBe("Owner@Acme.com"));
  it.each([
    ["issuer", { iss: "https://evil.example" }],
    ["audience", { aud: "other-app" }],
    ["nonce", { nonce: "WRONG" }],
    ["no email", { email: undefined }],
  ])("rejects bad %s", (_n, over) => expect(() => oauth.readIdToken(idToken(over), "N1")).toThrow(/identity token/i));
  it("rejects expired and missing tokens", () => {
    expect(() => oauth.readIdToken(jwt.sign({ iss: "https://identity.xero.com", aud: "test-client-id", email: "a@b.c", nonce: "N1", exp: 1 }, "x"), "N1")).toThrow(/expired/);
    expect(() => oauth.readIdToken(null, "N1")).toThrow(/missing/);
  });
});

describe("organisation -> client form prefill", () => {
  const p = m.organisationToClientPrefill(ORG, { email: "Owner@Acme.com", givenName: "Olive", familyName: "Owner" });
  it("fills the client form from Xero", () => {
    expect(p).toMatchObject({
      name: "Acme Pty Ltd", tradingName: "Acme Trading", registrationNumber: "51824753556", taxId: "TAX1",
      email: "owner@acme.com", phone: "+61 2 9000 0000", website: "https://acme.example",
      address: { street: "1 Main St, Level 2", city: "Sydney", state: "NSW", zipcode: "2000", country: "Australia" },
      legalRepresentative: { name: "Olive Owner", email: "owner@acme.com" },
    });
  });
  it("prefers the street address and does not invent a client type", () => {
    expect(p.address.street).not.toMatch(/PO Box/);
    expect(p.clientType).toBeUndefined();
  });
  it("copes with an empty organisation", () => expect(() => m.organisationToClientPrefill({}, {})).not.toThrow());
});

describe("new visitor: callback -> prefill -> complete -> sign-in", () => {
  it("returns a ticket (no account yet) and serves the prefilled form", async () => {
    const out = await runCallback();
    expect(out.kind).toBe("signup");
    expect(mockUsers.rows).toHaveLength(0);
    expect(JSON.stringify(mockSignups.rows)).not.toContain(out.ticket); // only the hash is stored

    const data = await svc.getPrefill(out.ticket);
    expect(data).toMatchObject({ organisation: "Acme Trading", email: "owner@acme.com", entityTypes: [{ id: "e1", name: "Accountants" }] });
    expect(data.prefill.name).toBe("Acme Pty Ltd");
  });

  it("creates user, client, client-admin membership and the connection, then a one-time login", async () => {
    const { ticket } = await runCallback();
    const { loginCode, clientId } = await svc.completeSignup({ ticket, form: { clientType: "Accountants", clientTypeId: "e1", phone: "0400" } });

    expect(mockUsers.rows[0]).toMatchObject({ email: "owner@acme.com", isActive: true, userName: "owner@acme.com" });
    expect(mockUsers.rows[0].password.length).toBeGreaterThanOrEqual(24);
    expect(mockClients.rows[0]).toMatchObject({ name: "Acme Pty Ltd", clientType: "Accountants", registrationNumber: "51824753556", phone: "0400", user: mockUsers.rows[0]._id });
    expect(mockTypes.rows[0]).toMatchObject({ userType: "client", role: "admin", clientBelongs: mockClients.rows[0]._id, isActive: true });
    expect(xero.upsertConnection).toHaveBeenCalledWith(expect.objectContaining({
      tokens: expect.objectContaining({ accessToken: "AT", refreshToken: "RT" }), companyId: clientId,
    }));

    expect(await svc.redeemLoginCode(loginCode)).toBe("jwt-for-client");
    await expect(svc.redeemLoginCode(loginCode)).rejects.toMatchObject({ statusCode: 401 }); // single use
  });

  it("always uses the Xero email and ignores unlisted fields (status, email, user)", async () => {
    const { ticket } = await runCallback();
    await svc.completeSignup({ ticket, form: { clientType: "Accountants", email: "attacker@evil.com", status: "Active", user: "x", legalRepresentative: { email: "x@y.z" } } });
    expect(mockUsers.rows[0].email).toBe("owner@acme.com");
    expect(mockClients.rows[0].email).toBe("owner@acme.com");
    expect(mockClients.rows[0].status).toBeUndefined();
    expect(mockClients.rows[0].user).toBe(mockUsers.rows[0]._id);
  });

  it("spends the ticket once", async () => {
    const { ticket } = await runCallback();
    await svc.completeSignup({ ticket, form: { clientType: "Accountants" } });
    await expect(svc.completeSignup({ ticket, form: { clientType: "Accountants" } })).rejects.toMatchObject({ statusCode: 410 });
    await expect(svc.getPrefill(ticket)).rejects.toMatchObject({ statusCode: 410 });
  });

  it("requires an entity type and keeps the ticket usable after a validation error", async () => {
    const { ticket } = await runCallback();
    await expect(svc.completeSignup({ ticket, form: {} })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/entity type/i) });
    await mockClients.create({ name: "Acme Pty Ltd" }); // name taken
    await expect(svc.completeSignup({ ticket, form: { clientType: "Accountants" } })).rejects.toThrow(/already registered with Dooit/);
    expect(mockUsers.rows).toHaveLength(0);
    await expect(svc.getPrefill(ticket)).resolves.toBeDefined(); // still usable
    await svc.completeSignup({ ticket, form: { clientType: "Accountants", name: "Acme Pty Ltd 2" } });
    expect(mockUsers.rows).toHaveLength(1);
  });

  it("rolls everything back (and frees the ticket) if connecting fails", async () => {
    const { ticket } = await runCallback();
    xero.upsertConnection.mockRejectedValueOnce(Object.assign(new Error("org already connected"), { statusCode: 409 }));
    await expect(svc.completeSignup({ ticket, form: { clientType: "Accountants" } })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockUsers.rows).toHaveLength(0);
    expect(mockClients.rows).toHaveLength(0);
    expect(mockTypes.rows).toHaveLength(0);
    await expect(svc.getPrefill(ticket)).resolves.toBeDefined();
  });

  it("rejects unknown, empty and expired tickets / login codes", async () => {
    await expect(svc.getPrefill("nope")).rejects.toMatchObject({ statusCode: 410 });
    await expect(svc.getPrefill(undefined)).rejects.toMatchObject({ statusCode: 410 });
    await expect(svc.redeemLoginCode("nope")).rejects.toMatchObject({ statusCode: 401 });
    const { ticket } = await runCallback();
    mockSignups.rows[0].createdAt = new Date(Date.now() - 31 * 60 * 1000);
    await expect(svc.getPrefill(ticket)).rejects.toMatchObject({ statusCode: 410 });
  });

  it("expires login codes after two minutes", async () => {
    const { ticket } = await runCallback();
    const { loginCode } = await svc.completeSignup({ ticket, form: { clientType: "Accountants" } });
    mockSignups.rows[0].loginCodeExpiresAt = new Date(Date.now() - 1000);
    await expect(svc.redeemLoginCode(loginCode)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("organisation already known to Dooit", () => {
  const existingMatch = { client: { _id: "c-existing", name: "Existing Co" }, matchedBy: "tenant" };

  it("opens an approval request instead of signing in or connecting", async () => {
    requests.findExistingClient.mockResolvedValue(existingMatch);
    requests.createRequest.mockResolvedValue({ requesterToken: "R-TOKEN", maskedEmail: "a***@abc.com" });
    const out = await runCallback();

    expect(out).toEqual({ kind: "pending", requesterToken: "R-TOKEN", maskedEmail: "a***@abc.com" });
    expect(requests.findExistingClient).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }));
    expect(requests.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      match: existingMatch, identity: expect.objectContaining({ email: "owner@acme.com" }),
    }));
    // Nothing is connected, no account/ticket/login code is created.
    expect(xero.upsertConnection).not.toHaveBeenCalled();
    expect(mockSignups.rows).toHaveLength(0);
    expect(mockUsers.rows).toHaveLength(0);
  });

  it("does NOT sign in a client admin just because the Xero email matches theirs", async () => {
    const u = await mockUsers.create({ email: "owner@acme.com", emailHash: mockCreateEmailKey("owner@acme.com") });
    const c = await mockClients.create({ name: "Existing Co", user: u._id });
    await mockTypes.create({ user: u._id, userType: "client", role: "admin", clientBelongs: c._id, isActive: true });
    requests.findExistingClient.mockResolvedValue({ client: c, matchedBy: "tenant" });
    requests.createRequest.mockResolvedValue({ requesterToken: "R", maskedEmail: "o***@acme.com" });

    const out = await runCallback();
    expect(out.kind).toBe("pending");
    expect(out.loginCode).toBeUndefined();
    expect(xero.upsertConnection).not.toHaveBeenCalled();
  });

  it("a new organisation whose Xero email already belongs to a user is refused (409), never signed in", async () => {
    await mockUsers.create({ email: "owner@acme.com", emailHash: mockCreateEmailKey("owner@acme.com") });
    await expect(runCallback()).rejects.toMatchObject({ statusCode: 409 });
    expect(xero.upsertConnection).not.toHaveBeenCalled();
    expect(mockSignups.rows).toHaveLength(0);
  });

  it("completeSignup refuses if the organisation became a known client after the ticket was issued", async () => {
    const { ticket } = await runCallback();
    requests.findExistingClient.mockResolvedValue(existingMatch);
    await expect(svc.completeSignup({ ticket, form: { clientType: "Accountants" } })).rejects.toMatchObject({ statusCode: 409 });
    expect(mockUsers.rows).toHaveLength(0);
    expect(mockClients.rows).toHaveLength(0);
  });

  it("shows a friendly message (not the raw validation error) when details clash with a registered client", async () => {
    const { ticket } = await runCallback();
    await mockClients.create({ name: "Acme Pty Ltd" });
    await expect(svc.completeSignup({ ticket, form: { clientType: "Accountants" } })).rejects.toMatchObject({
      statusCode: 400, message: expect.stringMatching(/already registered with Dooit/i),
    });
    await expect(svc.completeSignup({ ticket, form: { clientType: "Accountants" } })).rejects.not.toThrow(/Client with this name/);
  });
});
