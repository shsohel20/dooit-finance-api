/**
 * Source of Funds (SOF) Verification Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Lets a customer upload SOF evidence (bank_statement | payslip |
 * bank_cheque | bank_certificate) from their own mobile device via a QR /
 * link, without logging in. The link is just `/sof-upload?cid=<customerId>`
 * — there's no per-link token to mint or expire, so a session (+ its QR
 * image) is auto-provisioned for a customer the first time it's needed
 * (ensureSofSession) and the same link/QR always works. The admin tab never
 * needs a "Generate" click — it just appears.
 *
 * Verified/uploaded documents are ALSO written into Customer.documents
 * (the same array the reviewer Documents tab reads/writes via
 * addCustomerDocuments), so a SOF upload shows up there too.
 *
 * Routes (see routes/sofVerification.js):
 *   GET  /api/v1/sof-verification/customer/:customerId          (admin)  read (auto-create) the session + QR + documents
 *   POST /api/v1/sof-verification/:customerId/send-email         (admin)  email the (always-available) upload link
 *   PATCH /api/v1/sof-verification/:customerId/documents/:docId  (admin)  manual verify/reject override
 *   GET  /api/v1/sof-verification/validate                       (public) look up the customer before showing the upload UI
 *   POST /api/v1/sof-verification/upload                         (public) upload + auto-verify one document
 */

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const sendEmail = require("../utils/sendEmail");
const SofRequestEmailTemplate = require("../utils/email-template/sofRequest");
const { generateQRFromUrl } = require("../utils/qrService");
const fileVaultService = require("../utils/fileVaultService");
const ocrService = require("../utils/ocrService");
const { customerRelatedToTenant } = require("../utils/customerTenantGuard");
const { logEvent } = require("../utils/audit");
const { recordDevice } = require("../utils/deviceContext");

const { resolveCaseLinkage } = require("../utils/resolveCaseLinkage");

const Customer = require("../models/Customer");
const Client = require("../models/Client");
const SofVerification = require("../models/SofVerification");
const RFI = require("../models/Rfi");

const DOC_TYPES = SofVerification.DOC_TYPES;

// ── Shared helpers ────────────────────────────────────────────────────────────

const loadGuardedCustomer = async (req, next) => {
  const customer = await Customer.findById(req.params.customerId).select(
    "documents relations personalKyc metadata",
  );
  if (!customer) {
    next(new ErrorResponse(`Customer not found with id of ${req.params.customerId}`, 404));
    return null;
  }
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (!customerRelatedToTenant(customer, client, branch)) {
    next(new ErrorResponse(`Customer not found with id of ${req.params.customerId}`, 404));
    return null;
  }
  return customer;
};

const customerDisplayName = (customer) => {
  const d = customer?.personalKyc?.personal_form?.customer_details || {};
  const name = [d.given_name, d.surname].filter(Boolean).join(" ").trim();
  return name || customer?.uid || "Customer";
};

/**
 * Client (tenant) branding for anything shown to the customer — the request
 * email header and the public upload page both co-brand Dooit with the
 * organisation that asked for the document. Client has no dedicated logo
 * field, so read the conventional Mixed keys (same as userController).
 * Best-effort: a missing client just means plain Dooit branding.
 */
const resolveClientBranding = async (customer) => {
  try {
    const clientId = customer?.relations?.[0]?.client;
    if (!clientId) return { name: "", logoUrl: "" };
    const clientDoc = await Client.findById(clientId)
      .select("name settings metadata")
      .lean();
    return {
      name: clientDoc?.name || "",
      logoUrl: clientDoc?.settings?.logoUrl || clientDoc?.metadata?.logoUrl || "",
    };
  } catch (err) {
    console.error("[resolveClientBranding] lookup failed:", err.message);
    return { name: "", logoUrl: "" };
  }
};

const toStringList = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];

/**
 * Map a /process-bank-documents response onto the stored per-document OCR
 * record (SofOcrResultSchema). Which buckets fill depends on the document
 * type — statements carry an account block + paginated transactions, payslips
 * carry a payslips[] array, cheques carry neither. `raw` always keeps the
 * untouched response so a shape change upstream can never lose data.
 *
 * Safe to call with ocrResult === null (OCR outage): everything comes back
 * empty with ocrError recorded as the rejection reason.
 */
const buildSofOcrRecord = (ocrResult, { docType = null, ocrError = null } = {}) => {
  const data = ocrResult?.data || {};
  const analysis = ocrResult?.analysis || {};

  // Statements are returned page by page. Flatten into one ledger, carrying
  // the page number onto each row so the reviewer table stays a flat list.
  const transactions = Array.isArray(data.pages)
    ? data.pages.flatMap((page) =>
        (Array.isArray(page?.transactions) ? page.transactions : []).map((t) => ({
          page_number: page?.page_number ?? null,
          ...t,
        })),
      )
    : [];

  return {
    isValid: ocrResult?.is_valid ?? null,
    rejectionReason:
      ocrResult?.rejection_reason || data.rejection_reason || ocrError || null,
    documentType: ocrResult?.document_type || docType,
    processedAt: ocrResult ? new Date() : null,

    accountInformation: data.account_information || null,
    payslips: Array.isArray(data.payslips) ? data.payslips : [],
    transactions,
    statementSummary: data.summary || null,

    analysis: {
      patterns: toStringList(analysis.patterns),
      anomalies: toStringList(analysis.anomalies),
      insights: toStringList(analysis.insights),
      summary: typeof analysis.summary === "string" ? analysis.summary : null,
    },
    raw: ocrResult || null,
  };
};

// Exported for tests — not routed.
exports.buildSofOcrRecord = buildSofOcrRecord;

// Deadlines mirror an "initial" RFI send in rfiController.sendRFI.
const DAY_MS = 24 * 60 * 60 * 1000;
const SOF_RFI_SOURCE = "sof_verification";

/**
 * Record the SOF request as an RFI so it appears in the RFI register and on
 * the case's Reports section — a source of funds request is a formal request
 * for information and needs the same audit trail and deadline clock.
 *
 * One RFI per customer SOF session: re-sending the link is a follow-up on the
 * open request, not a new one, so it appends an activity note and refreshes
 * sentAt instead of creating a duplicate. A closed RFI is left alone and a new
 * one is opened.
 *
 * Best-effort — the email has already gone out by the time this runs, so a
 * failure here is logged and swallowed rather than failing the request.
 */
const recordSofRfi = async ({ req, customer, sof, email, url, caseId }) => {
  try {
    // caseId is optional: the onboarding tab has no case, the case-manager tab
    // passes one so the RFI lands on that case's register.
    const link = caseId ? await resolveCaseLinkage({ caseId }) : {};
    const relation = customer.relations?.[0] || {};
    const contactName = customerDisplayName(customer);
    const now = new Date();

    const existing = await RFI.findOne({
      customer: customer._id,
      "metadata.source": SOF_RFI_SOURCE,
      status: { $ne: "Closed" },
    }).sort({ createdAt: -1 });

    if (existing) {
      existing.replyToEmail = email;
      existing.sentAt = now;
      existing.sentBy = req?.user?._id || existing.sentBy || null;
      existing.followupDeadline = new Date(now.getTime() + 7 * DAY_MS);
      existing.status = "Pending FollowUp";
      // Attach the case the moment one exists, so an RFI opened during
      // onboarding follows the customer into their investigation.
      if (!existing.case && link.caseId) existing.case = link.caseId;
      if (!existing.alert && link.alert) existing.alert = link.alert;
      existing.activityNote.push({
        note: `Source of funds upload link re-sent to ${email}`,
        uploadedAt: now,
        by: req?.user?._id || null,
      });
      await existing.save();
      return existing;
    }

    return await RFI.create({
      case: link.caseId || null,
      alert: link.alert || null,
      client: relation.client || link.client || null,
      branch: relation.branch || link.branch || null,
      customer: customer._id,
      primaryContactName: contactName,
      replyToEmail: email,
      requestedItems: DOC_TYPES.map((docType) => ({
        text: `Source of funds evidence — ${docType.replace(/_/g, " ")}`,
      })),
      responseDeadline: new Date(now.getTime() + 14 * DAY_MS),
      followupDeadline: new Date(now.getTime() + 21 * DAY_MS),
      finalDeadline: new Date(now.getTime() + 28 * DAY_MS),
      status: "Sent",
      sentAt: now,
      sentBy: req?.user?._id || null,
      activityNote: [
        {
          note: `Source of funds upload link sent to ${email}`,
          uploadedAt: now,
          by: req?.user?._id || null,
        },
      ],
      metadata: {
        source: SOF_RFI_SOURCE,
        sofVerification: sof._id,
        uploadUrl: url,
        // Any one of these satisfies the request — see SofVerification.DOC_TYPES.
        acceptedDocTypes: DOC_TYPES,
      },
    });
  } catch (err) {
    console.error("[recordSofRfi] failed:", err.message);
    return null;
  }
};

// The upload page lives at /accept-invite/sof-upload on the customer-facing
// app. Built from FRONTEND_URL (the app's origin) rather than
// CLIENT_INVITE_URL, so the SOF link doesn't move if the invite path changes.
const SOF_UPLOAD_BASE = `${(process.env.FRONTEND_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
)}/accept-invite`;

const buildSofUrl = (customerId) => `${SOF_UPLOAD_BASE}/sof-upload?cid=${customerId}`;

/**
 * Get-or-create the customer's SOF session, generating + persisting the QR
 * image the first time (fileVaultService — same store every other document
 * goes through). Idempotent: safe to call on every admin tab load and on
 * every public validate/upload hit.
 */
const ensureSofSession = async (customer) => {
  let sof = await SofVerification.findOne({ customer: customer._id });
  if (sof && sof.qrCode?.url) return sof;

  const relation = customer.relations?.[0] || {};
  if (!sof) {
    sof = new SofVerification({
      customer: customer._id,
      client: relation.client || null,
      branch: relation.branch || null,
    });
  }

  try {
    const qrBuffer = await generateQRFromUrl(buildSofUrl(customer._id), "png");
    const qrUpload = await fileVaultService.uploadFile(
      qrBuffer,
      `sof-qr-${customer._id}.png`,
      "image/png",
    );
    const qrUrl = qrUpload?.file?.publicUrl;
    if (qrUpload?.success && qrUrl) {
      sof.qrCode = { url: qrUrl, mimeType: "image/png", generatedAt: new Date() };
    }
  } catch (err) {
    console.error("[ensureSofSession] QR upload failed:", err.message);
  }

  await sof.save();
  return sof;
};

// ── Admin: read (auto-create) the session ─────────────────────────────────────

// @desc   Get (or lazily create) the SOF verification session + QR + documents
// @route  GET /api/v1/sof-verification/customer/:customerId
// @access Private (CUSTOMER.GET)
exports.getSofVerification = asyncHandler(async (req, res, next) => {
  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const sof = await ensureSofSession(customer);

  res.status(200).json({
    success: true,
    data: sof,
    url: buildSofUrl(customer._id),
    docTypes: DOC_TYPES,
  });
});

// @desc   Email the customer's (always-available) SOF upload link
// @route  POST /api/v1/sof-verification/:customerId/send-email
// @access Private (CUSTOMER.EDIT)
exports.sendSofEmail = asyncHandler(async (req, res, next) => {
  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const { email, caseId } = req.body || {};
  const targetEmail =
    email ||
    customer.personalKyc?.personal_form?.contact_details?.email ||
    customer.metadata?.email ||
    null;

  if (!targetEmail) {
    return next(new ErrorResponse("No email address available for this customer", 400));
  }

  const sof = await ensureSofSession(customer);
  const url = buildSofUrl(customer._id);

  const { name: clientName, logoUrl: clientLogoUrl } =
    await resolveClientBranding(customer);

  try {
    await sendEmail({
      email: targetEmail,
      subject: clientName
        ? `${clientName}: please verify your source of funds`
        : "Please verify your source of funds",
      message: SofRequestEmailTemplate({
        clientName,
        clientLogoUrl,
        customerName: customerDisplayName(customer),
        uploadLink: url,
      }),
    });
  } catch (e) {
    console.error("[sendSofEmail] email failed:", e.message);
    return next(new ErrorResponse("Failed to send the email", 502));
  }

  sof.sentTo = { email: targetEmail, sentAt: new Date() };
  await sof.save();

  // Log the request in the RFI register so it carries a deadline clock and
  // shows up alongside every other information request on the case.
  const rfi = await recordSofRfi({
    req,
    customer,
    sof,
    email: targetEmail,
    url,
    caseId,
  });

  logEvent({
    req,
    service: "kyc",
    action: "sof_link_emailed",
    customer: customer._id,
    afterValue: { to: targetEmail, rfi: rfi?.uid || null },
  });

  res.status(200).json({
    success: true,
    message: `Upload link emailed to ${targetEmail}`,
    data: sof,
    url,
    rfi: rfi ? { _id: rfi._id, uid: rfi.uid, status: rfi.status } : null,
  });
});

// @desc   Manually override a single uploaded document's verification status
// @route  PATCH /api/v1/sof-verification/:customerId/documents/:docId
// @access Private (CUSTOMER.EDIT)
exports.reviewSofDocument = asyncHandler(async (req, res, next) => {
  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const { status, note = "" } = req.body || {};
  if (!["verified", "rejected", "needs_review"].includes(status)) {
    return next(new ErrorResponse("status must be one of verified | rejected | needs_review", 400));
  }

  const sof = await SofVerification.findOne({ customer: customer._id });
  if (!sof) return next(new ErrorResponse("No SOF verification session for this customer", 404));

  const doc = sof.documents.id(req.params.docId);
  if (!doc) return next(new ErrorResponse("Document not found in this SOF session", 404));

  doc.status = status;
  doc.reviewNote = note;
  doc.reviewedBy = req.user?._id || null;
  doc.reviewedAt = new Date();

  sof.status = sof.documents.some((d) => d.status === "verified") ? "verified" : "in_review";

  await sof.save();

  logEvent({
    req,
    service: "kyc",
    action: "sof_document_reviewed",
    customer: customer._id,
    afterValue: { docId: req.params.docId, status },
  });

  res.status(200).json({ success: true, message: "Document updated", data: sof });
});

// ── Public: no-login mobile upload flow ───────────────────────────────────────

// @desc   Look up a customer before showing the mobile upload page
// @route  GET /api/v1/sof-verification/validate?cid=
// @access Public
exports.validateSofCustomer = asyncHandler(async (req, res, next) => {
  const { cid } = req.query;
  if (!cid) return next(new ErrorResponse("cid required", 400));

  const customer = await Customer.findById(cid).select("personalKyc uid relations");
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  const sof = await ensureSofSession(customer);

  // Co-branding for the public page: it is Dooit's page, but the customer was
  // asked for the document by their own provider, so name (and where set, show)
  // that organisation.
  const client = await resolveClientBranding(customer);

  res.status(200).json({
    success: true,
    data: {
      customerId: cid,
      customerName: customerDisplayName(customer),
      client,
      docTypes: DOC_TYPES,
      documents: sof.documents.map((d) => ({
        _id: d._id,
        docType: d.docType,
        name: d.name,
        status: d.status,
        uploadedAt: d.uploadedAt,
      })),
    },
  });
});

// @desc   Upload + auto-verify one SOF document (public)
// @route  POST /api/v1/sof-verification/upload  (multipart/form-data: cid, docType, file)
// @access Public
exports.uploadSofDocument = asyncHandler(async (req, res, next) => {
  const { cid, docType } = req.body || {};

  if (!cid) return next(new ErrorResponse("cid required", 400));
  if (!DOC_TYPES.includes(docType)) {
    return next(new ErrorResponse(`docType must be one of: ${DOC_TYPES.join(", ")}`, 400));
  }
  if (!req.file) return next(new ErrorResponse("Please attach a file", 400));

  const customer = await Customer.findById(cid).select("relations");
  if (!customer) return next(new ErrorResponse("Customer not found", 404));

  const sof = await ensureSofSession(customer);

  const { buffer, originalname, mimetype } = req.file;

  // Upload to storage first — we want the file kept even if OCR verification
  // itself fails (upstream OCR outage shouldn't block evidence collection).
  let publicUrl;
  try {
    const uploadRes = await fileVaultService.uploadFile(buffer, originalname, mimetype);
    publicUrl = uploadRes?.file?.publicUrl;
    if (!uploadRes?.success || !publicUrl) {
      throw new Error(uploadRes?.message || "Upload failed");
    }
  } catch (err) {
    return next(new ErrorResponse(`File upload failed: ${err.message}`, 502));
  }

  let ocrResult = null;
  let ocrError = null;
  try {
    ocrResult = await ocrService.processBankDocument(buffer, originalname, mimetype, docType);
  } catch (err) {
    ocrError = err.message;
    console.error("[uploadSofDocument] OCR failed:", err.message);
  }

  let status = "needs_review";
  if (ocrResult?.success === true) {
    status = ocrResult.is_valid ? "verified" : "rejected";
  }

  const docEntry = {
    docType,
    type: "sof_qr_upload",
    name: originalname,
    url: publicUrl,
    mimeType: mimetype,
    status,
    ocr: buildSofOcrRecord(ocrResult, { docType, ocrError }),
    uploadedAt: new Date(),
  };

  sof.documents.push(docEntry);
  sof.status = sof.documents.some((d) => d.status === "verified") ? "verified" : "in_review";
  await sof.save();

  // Mirror into Customer.documents (DocumentMetaSchema) — same store the
  // reviewer Documents tab reads. updateOne + $push avoids re-running the
  // Customer pre-save encryption hooks over untouched PII fields.
  await Customer.updateOne(
    { _id: cid },
    {
      $push: {
        documents: {
          name: originalname,
          url: publicUrl,
          mimeType: mimetype,
          type: "sof_qr_upload",
          docType,
          uploadedAt: new Date(),
        },
      },
    },
  );

  // Public route — req.user is undefined; logEvent/recordDevice leave actor null.
  logEvent({
    req,
    service: "kyc",
    action: "sof_document_uploaded",
    customer: cid,
    details: `SOF ${docType} uploaded via QR — ${status}`,
  });
  recordDevice({ req, customerId: cid, purpose: "other", details: { event: "sof_upload", docType } });

  const savedDoc = sof.documents[sof.documents.length - 1];

  // Public, unauthenticated response — return only what the upload page shows.
  // The rest of the OCR record (analysis, transactions, raw) is internal
  // compliance commentary and stays on the reviewer side.
  res.status(201).json({
    success: true,
    message:
      status === "verified"
        ? "Document verified"
        : status === "rejected"
          ? "Document could not be verified"
          : "Document uploaded — pending review",
    data: {
      document: {
        _id: savedDoc._id,
        docType: savedDoc.docType,
        name: savedDoc.name,
        status: savedDoc.status,
        uploadedAt: savedDoc.uploadedAt,
        ocr: {
          rejectionReason: savedDoc.ocr?.rejectionReason || null,
          accountInformation: savedDoc.ocr?.accountInformation || null,
        },
      },
      sofStatus: sof.status,
    },
  });
});
