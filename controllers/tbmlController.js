const axios = require('axios');
const asyncHandler = require('../middleware/async');
const ErrorResponse = require('../utils/errorResponse');
const Case = require('../models/Case');
const AuditLog = require('../models/AuditLog');
const TbmlReport = require('../models/TbmlReport');
const fileVaultService = require('../utils/fileVaultService');
const osint = require('../services/tbmlOsintService');
const { submitScreening, readReport, refreshReport } = require('../services/tbmlScreening');
const { auditContext } = require('../utils/auditContext');
const { logEvent } = require('../utils/audit');

// ─────────────────────────────────────────────────────────────────────────────
// TBML screening (OSINT Engine — https://osint.dooit.ai/docs, "TBML OSINT")
//
// Screening a trade document is three steps that must not be split across the
// browser:
//
//   1. the file is stored in FileVault and attached to the case, so the
//      evidence survives independently of the screening;
//   2. the same bytes go to the OSINT Engine, which accepts them and starts
//      work that takes minutes;
//   3. the result is chased in the background and cached here, so every later
//      read of a finished report is served from our own database.
//
// The engine authenticates with a tenant-wide API key. That key stays on this
// side; nothing about it reaches the client.
// ─────────────────────────────────────────────────────────────────────────────

const getTenant = (req) => ({
  client: req?.user?.client?._id || req?.user?.clientBelongs || null,
  branch: req?.user?.branch?._id || req?.user?.branchBelongs || null,
});

const logAudit = (caseId, userId, action, details, tenant, req) =>
  AuditLog.create({
    case: caseId,
    user: userId,
    action,
    details,
    ...tenant,
    ...auditContext(req),
  });

// Returns an ErrorResponse if denied, null if allowed.
const checkCaseAccess = (caseDoc, req) => {
  const tenant = getTenant(req);
  if (tenant.client && caseDoc.client && caseDoc.client.toString() !== tenant.client.toString()) {
    return new ErrorResponse('Case not in your tenant', 403);
  }
  if (req.user.role === 'investigator') {
    const assignedId = caseDoc.assignedTo?._id || caseDoc.assignedTo;
    if (!assignedId || assignedId.toString() !== req.user._id.toString()) {
      return new ErrorResponse('Case not assigned to you', 403);
    }
  }
  return null;
};

const checkReportAccess = (record, req) => {
  const tenant = getTenant(req);
  if (tenant.client && record.client && record.client.toString() !== tenant.client.toString()) {
    return new ErrorResponse('Screening run not in your tenant', 403);
  }
  return null;
};

// The list shape — headlines only. The cached `report` payload is large and a
// list never needs it.
const LIST_FIELDS =
  'reportId submissionId status overallRiskLevel overallRiskScore productsDetected ' +
  'requiresAnalystReview errorMessage environment dbSource case caseDocument documentName ' +
  'submittedBy submittedAt completedAt refreshedAt lastPollError createdAt';

// ── POST /cases/:id/tbml/screen ──────────────────────────────────────────────
/**
 * Screens one trade document against the OSINT Engine.
 *
 * Two ways in, because an analyst should never have to find the same file
 * twice:
 *   • multipart with `file` — a new document. Stored in FileVault, attached to
 *     the case, then submitted.
 *   • JSON with `documentId` — a document already on the case. The bytes are
 *     read back from the vault here; the browser is not involved.
 *
 * Answers 202 as soon as the engine accepts the document. The analysis itself
 * is chased by the background sweep in services/tbmlScreening.js — nothing
 * waits on it, and the result is cached when it lands.
 */
exports.screenCaseDocument = asyncHandler(async (req, res, next) => {
  const caseId = req.params.caseId || req.params.id;
  const caseDoc = await Case.findOne({ _id: caseId, isDeleted: { $ne: true } });

  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${caseId}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const customerId = caseDoc.customer || caseDoc.linkedCustomers?.[0] || null;

  let buffer;
  let filename;
  let mimetype;
  let caseDocument = null;

  console.log(req.file)

  if (req.file) {
    // ── New document: vault first, so the evidence exists even if screening
    // fails. A file an analyst uploaded and then lost would be the worse bug.
    ({ buffer, originalname: filename, mimetype } = req.file);

    let stored;
    try {
      stored = await fileVaultService.uploadFile(buffer, filename, mimetype);
    } catch (error) {
      return next(new ErrorResponse(`Could not store the document: ${error.message}`, 502));
    }

    console.log(stored)

    const url = stored?.file?.publicUrl || stored?.file?.url;
    if (!url) {
      return next(new ErrorResponse('FileVault did not return a URL for the uploaded file', 502));
    }

    caseDoc.documents.push({
      name: req.body.name || filename,
      url,
      mimeType: mimetype,
      type: req.body.type || 'trade_document',
      sizeBytes: buffer.length,
      uploadedAt: new Date(),
      uploadedBy: req.user._id,
    });
    await caseDoc.save();
    caseDocument = caseDoc.documents[caseDoc.documents.length - 1];
  } else if (req.body.documentId) {
    // ── Already on the case: read the bytes back from the vault.
    caseDocument = caseDoc.documents.id(req.body.documentId);
    if (!caseDocument) {
      return next(new ErrorResponse(`Document not found with id ${req.body.documentId}`, 404));
    }
    if (!caseDocument.url) {
      return next(new ErrorResponse('That document has no stored file to screen', 400));
    }

    try {
      const stored = await axios.get(caseDocument.url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
      });
      buffer = Buffer.from(stored.data);
      mimetype = caseDocument.mimeType || stored.headers['content-type'];
      filename = caseDocument.name || 'document';
    } catch (error) {
      return next(new ErrorResponse(`Could not read the stored file: ${error.message}`, 502));
    }
  } else {
    return next(new ErrorResponse('Attach a file, or name a documentId already on the case', 400));
  }

  let submission;
  let record;
  try {
    ({ submission, record } = await submitScreening({
      buffer,
      filename,
      mimetype,
      caseDoc,
      customerId,
      caseDocumentId: caseDocument?._id,
      documentName: caseDocument?.name || filename,
      user: req.user,
    }));
  } catch (error) {
    console.log(error)
    // The document is attached either way — say so, so nobody re-uploads it.
    return next(
      new ErrorResponse(
        `The document was stored on the case but screening could not be started: ${error.message}`,
        502
      )
    );
  }

  // Stamp the run onto the case document so the Files view can say what was
  // screened, and when, without going near the engine.
  if (caseDocument) {
    caseDocument.tbml = {
      reportId: record.reportId,
      submissionId: record.submissionId,
      status: record.status,
      dbSource: record.dbSource,
      submittedAt: record.submittedAt,
    };
    await caseDoc.save();
  }

  await logAudit(
    caseDoc._id,
    req.user._id,
    'tbml_screening_submitted',
    `TBML screening ${record.reportId} started for "${record.documentName}"` +
      (record.dbSource === 2 ? ' (stage environment — not a compliance artefact)' : ''),
    getTenant(req),
    req
  );

  logEvent({
    req,
    service: 'case',
    action: 'tbml_screening_submitted',
    target: record.reportId,
    case: caseDoc._id,
    afterValue: { document: record.documentName, dbSource: record.dbSource },
  });

  res.status(202).json({
    succeed: true,
    message: submission.message || 'Screening queued',
    data: {
      report: record,
      document: caseDocument,
      estimatedCompletionMinutes: submission.estimated_completion_minutes ?? null,
    },
  });
});

// ── GET /cases/:id/tbml/reports ──────────────────────────────────────────────
// Every screening run recorded against this case. Served entirely from our own
// database — no engine call, however often the tab is opened.
exports.getCaseTbmlReports = asyncHandler(async (req, res, next) => {
  const caseId = req.params.caseId || req.params.id;
  const caseDoc = await Case.findOne({ _id: caseId, isDeleted: { $ne: true } })
    .select('client branch assignedTo')
    .lean();
  if (!caseDoc) {
    return next(new ErrorResponse(`Case not found with id ${caseId}`, 404));
  }
  const accessErr = checkCaseAccess(caseDoc, req);
  if (accessErr) return next(accessErr);

  const reports = await TbmlReport.find({ case: caseId, isDeleted: { $ne: true } })
    .select(LIST_FIELDS)
    .populate('submittedBy', 'name email')
    .sort({ submittedAt: -1 })
    .lean();

  res.status(200).json({ succeed: true, data: reports, count: reports.length });
});

// ── GET /tbml/reports/:reportId ──────────────────────────────────────────────
// The cached run in full. A finished report never changes, so this is answered
// from our copy; a run still in flight is re-checked if the last look was more
// than a few seconds ago.
exports.getTbmlReport = asyncHandler(async (req, res, next) => {
  const record = await TbmlReport.findOne({
    reportId: req.params.reportId,
    isDeleted: { $ne: true },
  });
  if (!record) {
    return next(new ErrorResponse(`Screening run not found: ${req.params.reportId}`, 404));
  }
  const accessErr = checkReportAccess(record, req);
  if (accessErr) return next(accessErr);

  const fresh = await readReport(record);
  res.status(200).json({ succeed: true, data: fresh });
});

// ── POST /tbml/reports/:reportId/refresh ─────────────────────────────────────
// Re-reads a run from the engine even when our copy looks settled.
exports.refreshTbmlReport = asyncHandler(async (req, res, next) => {
  const record = await TbmlReport.findOne({
    reportId: req.params.reportId,
    isDeleted: { $ne: true },
  });
  if (!record) {
    return next(new ErrorResponse(`Screening run not found: ${req.params.reportId}`, 404));
  }
  const accessErr = checkReportAccess(record, req);
  if (accessErr) return next(accessErr);

  const fresh = await refreshReport(record, { force: true });
  if (fresh.lastPollError) {
    return next(new ErrorResponse(`The engine could not be reached: ${fresh.lastPollError}`, 502));
  }

  res.status(200).json({ succeed: true, data: fresh });
});

// ── GET /tbml/reports/:reportId/trail ────────────────────────────────────────
// Every search result the run saw, opened or not. Large, so it is fetched on
// the first request that wants it and cached from then on.
exports.getTbmlTrail = asyncHandler(async (req, res, next) => {
  const record = await TbmlReport.findOne({
    reportId: req.params.reportId,
    isDeleted: { $ne: true },
  });
  if (!record) {
    return next(new ErrorResponse(`Screening run not found: ${req.params.reportId}`, 404));
  }
  const accessErr = checkReportAccess(record, req);
  if (accessErr) return next(accessErr);

  const fresh = await readReport(record, { withTrail: true });
  res.status(200).json({ succeed: true, data: fresh.trail || null });
});

// ── GET /tbml/reports/:reportId/files/:fileId ────────────────────────────────
// Streams a screened document back. Proxied because the engine needs the shared
// API key, which must not leave this service.
exports.downloadTbmlFile = asyncHandler(async (req, res, next) => {
  const record = await TbmlReport.findOne({
    reportId: req.params.reportId,
    isDeleted: { $ne: true },
  }).lean();
  if (!record) {
    return next(new ErrorResponse(`Screening run not found: ${req.params.reportId}`, 404));
  }
  const accessErr = checkReportAccess(record, req);
  if (accessErr) return next(accessErr);

  try {
    const upstream = await osint.getDocumentFile(req.params.reportId, req.params.fileId);

    const contentType = upstream.headers['content-type'];
    const contentDisposition = upstream.headers['content-disposition'];
    const contentLength = upstream.headers['content-length'];
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Evidence access is itself the audit target.
    logEvent({
      req,
      service: 'case',
      action: 'tbml_document_downloaded',
      target: `${req.params.reportId}/${req.params.fileId}`,
      case: record.case || undefined,
    });

    upstream.data.pipe(res);
    upstream.data.on('error', (err) => {
      console.error('[TBML] stream error:', err.message);
      if (!res.headersSent) next(new ErrorResponse('Error streaming file', 500));
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) return next(new ErrorResponse('File not found at the OSINT engine', 404));
    return next(new ErrorResponse(`Failed to retrieve file: ${error.message}`, status || 502));
  }
});
