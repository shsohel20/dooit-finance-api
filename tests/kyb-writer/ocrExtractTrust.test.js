/**
 * eKYB OCR pre-fill for a Trust Deed (docs/65 Step 50): POST /customer/trust/ocr.
 *
 * Mirrors ocrExtractCompany.test.js — pure extraction, no DB record touched,
 * ocrService mocked (never hits the real external OCR server in tests).
 */
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "development";

jest.mock("../../utils/ocrService");
const ocrService = require("../../utils/ocrService");
const controller = require("../../controllers/customerController");

function call(handler, { user = {}, body = {}, params = {}, file } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
      },
    };
    const next = (err) => resolve({ error: err });
    handler({ user, body, params, file }, res, next);
  });
}

const reviewer = { userType: "client", role: "client" };
const fakeFile = { buffer: Buffer.from("fake-pdf-bytes"), originalname: "deed.pdf", mimetype: "application/pdf" };

afterEach(() => jest.clearAllMocks());

test("no file on the request -> 400", async () => {
  const r = await call(controller.ocrExtractTrust, { user: reviewer });
  expect(r.error?.statusCode).toBe(400);
  expect(ocrService.processEkybTrust).not.toHaveBeenCalled();
});

test("upstream success -> 200, data passed through as-is; processEkybCompany NOT called", async () => {
  ocrService.processEkybTrust.mockResolvedValue({
    success: true,
    document_type: "Trust",
    data: { trust_details: { full_trust_name: "STRIKEO Trust" } },
    error: null,
  });
  const r = await call(controller.ocrExtractTrust, { user: reviewer, file: fakeFile });
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(200);
  expect(r.body).toEqual({
    success: true,
    document_type: "Trust",
    data: { trust_details: { full_trust_name: "STRIKEO Trust" } },
  });
  expect(ocrService.processEkybTrust).toHaveBeenCalledWith(fakeFile.buffer, fakeFile.originalname, fakeFile.mimetype);
  expect(ocrService.processEkybCompany).not.toHaveBeenCalled();
});

test("upstream success:false -> 422 with the upstream error message", async () => {
  ocrService.processEkybTrust.mockResolvedValue({ success: false, document_type: "unknown", error: "Not a trust deed" });
  const r = await call(controller.ocrExtractTrust, { user: reviewer, file: fakeFile });
  expect(r.error?.statusCode).toBe(422);
  expect(r.error.message).toBe("Not a trust deed");
});

test("upstream 4xx -> relayed as the same 4xx", async () => {
  const err = new Error("Request failed");
  err.response = { status: 422, data: { detail: [{ msg: "Unsupported file type" }] } };
  ocrService.processEkybTrust.mockRejectedValue(err);
  const r = await call(controller.ocrExtractTrust, { user: reviewer, file: fakeFile });
  expect(r.error?.statusCode).toBe(422);
  expect(r.error.message).toBe("Unsupported file type");
});

test("network/timeout/5xx failure -> 502", async () => {
  ocrService.processEkybTrust.mockRejectedValue(new Error("connect ETIMEDOUT"));
  const r = await call(controller.ocrExtractTrust, { user: reviewer, file: fakeFile });
  expect(r.error?.statusCode).toBe(502);
});
