// controllers/dismissalController.js
//
// The lifecycle of an alert dismissal record (docs/74 §4.5, phase C5).
// Creation is not here: a dismissal is drafted from the case's own facts via
// POST /cases/:id/reports/dismissal/draft, the same route every other report
// uses. This controller owns reading, editing and the four-eyes approval.

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const AlertDismissal = require("../models/AlertDismissal");
const Alert = require("../models/Alert");
const AuditLog = require("../models/AuditLog");
const { auditContext } = require("../utils/auditContext");
const { logEvent } = require("../utils/audit");
const { DISMISSAL_TYPES, suggestDismissalTypes } = require("../utils/dismissalTypes");

// Narrative fields an analyst may rewrite. Editing one records it in
// `editedFields` so a re-draft cannot overwrite their words (docs/74 §6.3).
const NARRATIVE_FIELDS = [
  "title",
  "category",
  "intro",
  "profile",
  "transactionAnalysis",
  "additionalInfo",
  "conclusion",
];

// Everything else a caller may set directly.
const WRITABLE_FIELDS = [...NARRATIVE_FIELDS, "dismissalType", "reviewer", "metadata"];

const getTenant = (req) => ({
  client: req?.user?.client?._id || req?.user?.clientBelongs || null,
  branch: req?.user?.branch?._id || req?.user?.branchBelongs || null,
});

// A tenant user only sees their own client's dismissals; admins see all.
const tenantFilter = (req) => {
  const { client } = getTenant(req);
  return client ? { client } : {};
};

// @desc   The industry dismissal templates, and which suit this customer
// @route  GET /api/v1/dismissal-report/types?industry=Retail
// @access Private
exports.getDismissalTypes = asyncHandler(async (req, res) => {
  res.status(200).json({
    succeed: true,
    data: DISMISSAL_TYPES,
    suggested: suggestDismissalTypes(req.query.industry),
  });
});

// @desc   List dismissals
// @route  GET /api/v1/dismissal-report
// @access Private
exports.getDismissals = asyncHandler(async (req, res) => {
  const filter = { ...tenantFilter(req) };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.alert) filter.alert = req.query.alert;
  if (req.query.case) filter.case = req.query.case;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

  const [totalRecords, data] = await Promise.all([
    AlertDismissal.countDocuments(filter),
    AlertDismissal.find(filter)
      .populate("alert", "uid ruleId ruleName riskLabel status")
      .populate("closedBy reviewer", "name email")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  res.status(200).json({
    succeed: true,
    totalRecords,
    totalPages: Math.ceil(totalRecords / limit),
    currentPage: page,
    count: data.length,
    data,
  });
});

// @desc   Single dismissal
// @route  GET /api/v1/dismissal-report/:id
// @access Private
exports.getDismissal = asyncHandler(async (req, res, next) => {
  const doc = await AlertDismissal.findOne({ _id: req.params.id, ...tenantFilter(req) })
    .populate("alert", "uid ruleId ruleName riskLabel status")
    .populate("case", "uid title status")
    .populate("closedBy reviewer", "name email")
    .lean();

  if (!doc) return next(new ErrorResponse(`Dismissal not found with id ${req.params.id}`, 404));
  res.status(200).json({ succeed: true, data: doc });
});

// @desc   Edit a dismissal's narrative
// @route  PUT /api/v1/dismissal-report/:id
// @access Private
exports.updateDismissal = asyncHandler(async (req, res, next) => {
  const doc = await AlertDismissal.findOne({ _id: req.params.id, ...tenantFilter(req) });
  if (!doc) return next(new ErrorResponse(`Dismissal not found with id ${req.params.id}`, 404));

  // An approved record is evidence of a decision — reopen it rather than edit.
  if (doc.status === "approved") {
    return next(new ErrorResponse("An approved dismissal cannot be edited", 409));
  }

  const edited = new Set(doc.editedFields || []);
  for (const field of WRITABLE_FIELDS) {
    if (req.body[field] === undefined) continue;
    doc[field] = req.body[field];
    // Remember which prose the analyst owns now.
    if (NARRATIVE_FIELDS.includes(field)) edited.add(field);
  }
  doc.editedFields = [...edited];
  await doc.save();

  res.status(200).json({ succeed: true, data: doc.toObject() });
});

// @desc   Approve a dismissal — the second pair of eyes
// @route  PUT /api/v1/dismissal-report/:id/approve
// @access Private (CASE.EDIT)
exports.approveDismissal = asyncHandler(async (req, res, next) => {
  const doc = await AlertDismissal.findOne({ _id: req.params.id, ...tenantFilter(req) });
  if (!doc) return next(new ErrorResponse(`Dismissal not found with id ${req.params.id}`, 404));
  if (doc.status === "approved") {
    return next(new ErrorResponse("This dismissal is already approved", 400));
  }

  // Four eyes: whoever wrote the dismissal cannot also sign it off.
  if (doc.closedBy && String(doc.closedBy) === String(req.user._id)) {
    return next(
      new ErrorResponse("A dismissal must be approved by someone other than its author", 403)
    );
  }

  // Our own blocking conditions outrank the narrative: if the evidence says
  // this alert should be escalated, it cannot be signed off as dismissed.
  if (doc.requiresEscalation && req.body.override !== true) {
    return next(
      new ErrorResponse(
        `This dismissal is blocked: ${doc.blockingConditions.join(" ")} Resolve these first, or approve with an explicit override.`,
        409
      )
    );
  }

  const from = doc.status;
  doc.status = "approved";
  doc.reviewer = req.user._id;
  doc.approvedAt = new Date();
  if (req.body.override === true) {
    doc.metadata = { ...(doc.metadata || {}), overrideBy: req.user._id, overrideAt: new Date() };
  }
  await doc.save();

  // Closing the alert is the point of the record, so do it here rather than
  // leaving the two to drift apart.
  //
  // `escalated_to_case` is deliberately NOT excluded: an alert reaches a case
  // precisely so it can be investigated, and "we looked and it was fine" is a
  // normal outcome of that. This approval is the four-eyes decision that says
  // so. Only an already-closed alert is left untouched. Note this closes the
  // ALERT, not the case — a case can hold others that are still open.
  const alert = await Alert.findById(doc.alert);
  if (alert && !["dismissed", "false_positive"].includes(alert.status)) {
    alert.status = "dismissed";
    alert.closedAt = new Date();
    alert.statusReason = doc.conclusion || doc.title || "Dismissed after review";
    alert.activity.push({
      type: "activity",
      title: "Dismissal approved",
      message: `Dismissal ${doc.uid} approved by ${req.user.name || req.user._id}`,
      createdBy: req.user._id,
    });
    await alert.save();
  }

  const tenant = getTenant(req);
  await AuditLog.create({
    ...tenant,
    case: doc.case || undefined,
    alert: doc.alert,
    user: req.user._id,
    action: "dismissal_approved",
    details: `Dismissal ${doc.uid} approved${req.body.override === true ? " (blocking conditions overridden)" : ""}`,
    ...auditContext(req),
  });

  logEvent({
    req,
    service: "report",
    action: "dismissal_approved",
    reportType: "DISMISSAL",
    target: doc.uid,
    case: doc.case || undefined,
    alert: doc.alert,
    customer: doc.customer || undefined,
    beforeValue: { status: from },
    afterValue: { status: doc.status, override: req.body.override === true },
  });

  res.status(200).json({ succeed: true, data: doc.toObject() });
});

// @desc   Withdraw a dismissal (e.g. the alert was escalated after all)
// @route  PUT /api/v1/dismissal-report/:id/withdraw
// @access Private (CASE.EDIT)
exports.withdrawDismissal = asyncHandler(async (req, res, next) => {
  const doc = await AlertDismissal.findOne({ _id: req.params.id, ...tenantFilter(req) });
  if (!doc) return next(new ErrorResponse(`Dismissal not found with id ${req.params.id}`, 404));

  const from = doc.status;
  doc.status = "withdrawn";
  doc.metadata = {
    ...(doc.metadata || {}),
    withdrawnBy: req.user._id,
    withdrawnAt: new Date(),
    withdrawReason: req.body.reason || null,
  };
  await doc.save();

  await AuditLog.create({
    ...getTenant(req),
    case: doc.case || undefined,
    alert: doc.alert,
    user: req.user._id,
    action: "dismissal_withdrawn",
    details: `Dismissal ${doc.uid} withdrawn${req.body.reason ? `: ${req.body.reason}` : ""}`,
    ...auditContext(req),
  });

  logEvent({
    req,
    service: "report",
    action: "dismissal_withdrawn",
    reportType: "DISMISSAL",
    target: doc.uid,
    beforeValue: { status: from },
    afterValue: { status: doc.status },
  });

  res.status(200).json({ succeed: true, data: doc.toObject() });
});

// @desc   Export a dismissal as a filing-grade PDF
// @route  GET /api/v1/dismissal-report/:id/export-pdf
// @access Private (ALERT.GET)
//
// The on-screen record is a working surface; this is the artefact handed to an
// auditor asking "why did you close this alert?". It carries its own
// provenance (uid, alert, case, status, who wrote it and who approved it), the
// evidence that was actually considered, and — where they exist — the
// conditions saying this alert should NOT have been closed. Composition is kept
// separate from transport so the layout can be inspected without launching a
// browser, the same way the ECDD / SMR / GFS exports do.
const buildDismissalReportHtml = (report) => {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // Every empty value renders as an em dash rather than "undefined" — a filed
  // report must not look like a rendering fault.
  const val = (v) => (v === 0 ? "0" : v ? esc(v) : "&mdash;");

  const fmtDate = (d) =>
    d && !Number.isNaN(new Date(d).getTime())
      ? new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" })
      : "&mdash;";

  const fmtDateTime = (d) =>
    d && !Number.isNaN(new Date(d).getTime())
      ? new Date(d).toLocaleString("en-AU", {
          day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
        })
      : "&mdash;";

  const money = (n) =>
    Number.isFinite(Number(n))
      ? "$" + Number(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "&mdash;";

  const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;

  const narrative = (text) =>
    text ? `<p class="narr">${esc(text).replace(/\n/g, "<br/>")}</p>` : `<p class="narr muted">Not recorded.</p>`;

  const bullets = (items) =>
    (items || []).length
      ? `<ul class="bullets">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
      : `<p class="narr muted">None recorded.</p>`;

  const ev = report.evidenceReviewed || {};
  const alert = report.alert || {};
  const caseUid = report.case?.uid || (report.case ? String(report.case) : null);
  const blocking = report.blockingConditions || [];
  const ruleLine = [alert.ruleId, alert.ruleName].filter(Boolean).join(" &middot; ") || null;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm 13mm 18mm; }
  :root { color-scheme: only light; }
  * { box-sizing: border-box; }
  html, body { background: #ffffff; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 9px;
         color: #20232a; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .masthead { border-bottom: 2px solid #005964; padding-bottom: 9px; margin-bottom: 13px; overflow: hidden; }
  .masthead .brand { font-size: 7.5px; letter-spacing: 0.14em; text-transform: uppercase; color: #005964; font-weight: bold; }
  .masthead h1 { font-size: 16px; margin: 4px 0 2px; color: #14161a; }
  .masthead .sub { color: #71767f; font-size: 8.5px; }
  .masthead .right { float: right; text-align: right; font-size: 8px; color: #71767f; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 7.5px;
            font-weight: bold; text-transform: uppercase; letter-spacing: 0.06em;
            background: #f0fbf5; color: #199335; border: 1px solid #cceedd; }
  .status.draft { background: #fff6de; color: #8a6400; border-color: #f6e0a8; }
  .status.withdrawn { background: #f4f5f6; color: #71767f; border-color: #e4e6ea; }

  h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #005964;
       border-bottom: 1px solid #e4e6ea; padding-bottom: 4px; margin: 15px 0 8px; page-break-after: avoid; }
  h3 { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #3d4048;
       margin: 11px 0 4px; page-break-after: avoid; }

  table { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; width: 30%; background: #f6f8f8; color: #3d4048; font-weight: 600;
                padding: 4px 7px; border: 1px solid #e4e6ea; vertical-align: top; }
  table.kv td { padding: 4px 7px; border: 1px solid #e4e6ea; vertical-align: top; }
  tr { page-break-inside: avoid; }

  .narr { font-size: 9px; line-height: 1.55; color: #3d4048; margin: 0 0 7px; text-align: justify; }
  .muted { color: #9aa0aa; }
  .mono { font-family: Consolas, "Courier New", monospace; font-size: 8px; word-break: break-all; }
  .bullets { margin: 0 0 7px; padding-left: 15px; }
  .bullets li { font-size: 9px; line-height: 1.5; color: #3d4048; margin-bottom: 2px; }

  .amounts { display: flex; gap: 12px; margin: 4px 0 10px; }
  .amounts .item { border: 1px solid #e4e6ea; border-radius: 6px; padding: 7px 10px; flex: 1; }
  .amounts .item .lbl { font-size: 7px; text-transform: uppercase; letter-spacing: 0.06em; color: #9aa0aa; }
  .amounts .item .val { font-size: 13px; font-weight: bold; color: #14161a; margin-top: 2px; }

  /* A dismissal our own rules said should not have been made must be
     impossible to miss on the page, not only in the app. */
  .blocked { margin: 10px 0 12px; padding: 9px 11px; background: #fdf1f7; border: 1px solid #f6dbe8;
             border-left: 3px solid #ca2f7f; border-radius: 4px; }
  .blocked .hd { font-size: 8px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.07em;
                 color: #ca2f7f; margin-bottom: 4px; }
  .blocked li { color: #7a2050; }

  .notice { margin-top: 14px; padding: 8px 10px; background: #fafbfb; border: 1px solid #e4e6ea;
            font-size: 7.5px; color: #71767f; line-height: 1.5; }
</style></head><body>

  <div class="masthead">
    <div class="right">
      <div><strong>${val(report.uid)}</strong></div>
      <div>Generated ${fmtDateTime(new Date())}</div>
    </div>
    <div class="brand">${esc(report.client?.name || "Dooit.ai")} &middot; Compliance</div>
    <h1>Alert Dismissal Record</h1>
    <div class="sub">
      ${caseUid ? `Case ${val(caseUid)} &nbsp;&middot;&nbsp; ` : ""}
      <span class="status ${esc(report.status || "draft")}">${val(report.status || "draft")}</span>
      &nbsp;&middot;&nbsp; Record of a decision that an alert was not suspicious
    </div>
  </div>

  ${blocking.length
      ? `<div class="blocked">
           <div class="hd">Escalation advised &mdash; ${blocking.length} unresolved condition${blocking.length === 1 ? "" : "s"}</div>
           <ul class="bullets">${blocking.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
           ${report.status === "approved"
              ? `<p class="narr" style="margin:4px 0 0"><strong>This dismissal was approved with these conditions overridden.</strong></p>`
              : ""}
         </div>`
      : ""}

  <h2>The alert</h2>
  <table class="kv">
    ${row("Alert", `<span class="mono">${val(alert.uid || report.alert)}</span>`)}
    ${row("Detection rule", val(ruleLine))}
    ${row("Alert risk", val(alert.riskLabel))}
    ${row("Alert status", val(alert.status))}
    ${row("Case", val(caseUid))}
  </table>

  <h2>Dismissal basis</h2>
  <table class="kv">
    ${row("Pattern applied", val(report.title))}
    ${row("Template", val(report.dismissalType))}
    ${row("Category", val(report.category))}
  </table>

  <h2>Evidence reviewed</h2>
  <div class="amounts">
    <div class="item"><div class="lbl">Inflow (AUD)</div><div class="val">${money(ev.totalInflowAUD)}</div></div>
    <div class="item"><div class="lbl">Outflow (AUD)</div><div class="val">${money(ev.totalOutflowAUD)}</div></div>
    <div class="item"><div class="lbl">Transactions</div><div class="val">${val(ev.transactionsReviewed)}</div></div>
    <div class="item"><div class="lbl">Alerts</div><div class="val">${val(ev.alertsReviewed)}</div></div>
  </div>
  <table class="kv">
    ${row("Review period", `${fmtDate(ev.reviewPeriod?.start)} &ndash; ${fmtDate(ev.reviewPeriod?.end)}`)}
    ${row("Counterparties reviewed", val(ev.counterpartiesReviewed))}
    ${row("Jurisdictions", val((ev.jurisdictions || []).join(", ") || null))}
    ${row("Risk flags", val((ev.riskFlags || []).join(", ") || null))}
    ${row("Rules triggered", val((ev.rulesTriggered || []).join(", ") || null))}
    ${ev.unconvertedCount
        ? row("Unconverted legs", `${val(ev.unconvertedCount)} transaction(s) carried no AUD conversion and are excluded from the totals above`)
        : ""}
  </table>

  <h2>Assessment</h2>
  ${narrative(report.intro)}
  <h3>Customer profile</h3>${narrative(report.profile)}
  <h3>Transaction analysis</h3>${narrative(report.transactionAnalysis)}
  <h3>Additional information</h3>${narrative(report.additionalInfo)}
  <h3>Conclusion</h3>${narrative(report.conclusion)}

  <h2>Analyst notes</h2>
  ${bullets(ev.analystNotes)}

  <h2>Sign-off</h2>
  <table class="kv">
    ${row("Prepared by", val(report.closedBy?.name))}
    ${row("Prepared", fmtDateTime(report.createdAt))}
    ${row("Approved by", val(report.reviewer?.name))}
    ${row("Approved", fmtDateTime(report.approvedAt))}
  </table>

  <div class="notice">
    The figures in this record were computed from the reporting entity&#39;s own customer, alert and
    transaction data for the review period shown. Narrative sections were drafted with machine
    assistance and reviewed by the named analyst before approval.
    ${report.aiMeta?.error?.code
        ? "The drafting service was unavailable when this record was created, so the narrative sections were written without it."
        : ""}
  </div>

</body></html>`;
};

exports.buildDismissalReportHtml = buildDismissalReportHtml;

exports.exportDismissalPdf = asyncHandler(async (req, res, next) => {
  const { launchPdfBrowser } = require("../utils/puppeteerLaunch");

  const report = await AlertDismissal.findOne({ _id: req.params.id, ...tenantFilter(req) })
    .populate("client", "name")
    .populate("case", "uid title")
    .populate("alert", "uid ruleId ruleName riskLabel status")
    .populate("closedBy reviewer", "name email")
    .lean();

  if (!report) {
    return next(new ErrorResponse(`Dismissal not found with id ${req.params.id}`, 404));
  }

  const html = buildDismissalReportHtml(report);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      // A filed record is photocopied and separated from the rest of the pack;
      // every page carries the uid and its position so a loose sheet stays identifiable.
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%; font-size:7px; color:#8a8a8a; padding:0 13mm;' +
        'font-family: Helvetica, Arial, sans-serif; display:flex; justify-content:space-between;">' +
        "<span>Dismissal " +
        esc(report.uid || "") +
        "</span>" +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
        "</div>",
      margin: { top: "16mm", bottom: "18mm", left: "13mm", right: "13mm" },
    });

    const safeName = String(report.uid || report._id).replace(/[^A-Za-z0-9._-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="DISMISSAL_' + safeName + '.pdf"');
    res.send(Buffer.from(pdfBuffer));
  } finally {
    if (browser) await browser.close();
  }
});
