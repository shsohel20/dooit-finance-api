/**
 * eKYB OCR pre-fill (docs/65 Step 48): POST /customer/company/ocr.
 *
 * Pure extraction endpoint — no CompanyKyc read/write, so no
 * mongodb-memory-server needed here, only the controller + a mocked
 * ocrService (never hits the real external OCR server in tests).
 *
 * Controllers are invoked directly (asyncHandler does not return the handler
 * promise; results are awaited via the mocked res.json/next).
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
const fakeFile = { buffer: Buffer.from("fake-pdf-bytes"), originalname: "extract.pdf", mimetype: "application/pdf" };

afterEach(() => jest.clearAllMocks());

test("no file on the request -> 400", async () => {
  const r = await call(controller.ocrExtractCompany, { user: reviewer });
  expect(r.error?.statusCode).toBe(400);
  expect(ocrService.processEkybCompany).not.toHaveBeenCalled();
});

test("upstream success -> 200, data passed through as-is", async () => {
  ocrService.processEkybCompany.mockResolvedValue({
    success: true,
    document_type: "ASIC Company Extract",
    data: { general_information: { legal_name: "Layer 8 Networks Pty Ltd" } },
    error: null,
  });
  const r = await call(controller.ocrExtractCompany, { user: reviewer, file: fakeFile });
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(200);
  expect(r.body).toEqual({
    success: true,
    document_type: "ASIC Company Extract",
    data: { general_information: { legal_name: "Layer 8 Networks Pty Ltd" } },
  });
  expect(ocrService.processEkybCompany).toHaveBeenCalledWith(fakeFile.buffer, fakeFile.originalname, fakeFile.mimetype);
});

test("upstream success:false -> 422 with the upstream error message", async () => {
  ocrService.processEkybCompany.mockResolvedValue({ success: false, document_type: "unknown", error: "Not an ASIC document" });
  const r = await call(controller.ocrExtractCompany, { user: reviewer, file: fakeFile });
  expect(r.error?.statusCode).toBe(422);
  expect(r.error.message).toBe("Not an ASIC document");
});

test("upstream 4xx (e.g. unreadable file) -> relayed as the same 4xx", async () => {
  const err = new Error("Request failed");
  err.response = { status: 422, data: { detail: [{ msg: "Unsupported file type" }] } };
  ocrService.processEkybCompany.mockRejectedValue(err);
  const r = await call(controller.ocrExtractCompany, { user: reviewer, file: fakeFile });
  expect(r.error?.statusCode).toBe(422);
  expect(r.error.message).toBe("Unsupported file type");
});

test("network/timeout/5xx failure -> 502, not leaked as a 500", async () => {
  ocrService.processEkybCompany.mockRejectedValue(new Error("connect ETIMEDOUT"));
  const r = await call(controller.ocrExtractCompany, { user: reviewer, file: fakeFile });
  expect(r.error?.statusCode).toBe(502);
});
