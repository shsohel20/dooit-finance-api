// controllers/smrController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const SMR = require("../models/SmrReport");
const { resolveCaseLinkage, hasLinkageRef, linkageOverrides } = require("../utils/resolveCaseLinkage");
const { fillTemplate } = require("../utils/email-template/rfiTemplates");
const sendEmail = require("../utils/sendEmail");

// simple filter helper (for advancedResults POST filtering)
exports.filterSMRSection = (doc, requestBody = {}) => {
  if (requestBody.reportId) {
    return (
      doc.reportId &&
      doc.reportId.toLowerCase().includes(requestBody.reportId.toLowerCase())
    );
  }
  if (requestBody.primaryName) {
    const name = doc.partC?.personOrganisation?.[0]?.name || "";
    return name.toLowerCase().includes(requestBody.primaryName.toLowerCase());
  }
  return true;
};

// GET list
exports.getSMRs = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});
exports.getSMRsPost = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// CREATE
exports.createSMR = asyncHandler(async (req, res, next) => {
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  // minimal validation: ensure required parts exist
  const body = req.body || {};
  if (
    !body.partA ||
    !body.partB ||
    !body.partC ||
    !body.partD ||
    !body.partE ||
    !body.partF ||
    !body.partG ||
    !body.partH
  ) {
    return next(new ErrorResponse("Missing required SMR parts", 400));
  }

  // Resolve the investigation hub: accepts a Case id/uid OR a legacy Alert
  // id/uid, and derives the owning Case from Alert.linkedCase.
  //
  // Resolved separately because resolveCaseLinkage collapses `caseId` and
  // `caseNumber` into one ref (caseId wins) — sending both would drop the
  // Alert. caseId is the hub, alert is provenance; keep both.
  const alertLink = await resolveCaseLinkage({
    caseNumber: body.caseNumber,
    alertId: body.alertId || body.alert,
  });
  const caseLink = body.caseId
    ? await resolveCaseLinkage({ caseId: body.caseId })
    : null;

  const link = {
    // An explicitly picked Case wins; otherwise fall back to Alert.linkedCase.
    caseId: caseLink?.caseId || alertLink.caseId || null,
    alert: alertLink.alert || null,
    customer: caseLink?.customer || alertLink.customer || null,
    client: caseLink?.client || alertLink.client || null,
    branch: caseLink?.branch || alertLink.branch || null,
    caseNumber: alertLink.caseNumber || caseLink?.caseNumber || null,
  };

  // create
  const smr = await SMR.create({
    client: client || link.client,
    branch: branch || link.branch,
    customer: body.customer || link.customer,
    caseId: link.caseId, // Case hub (null until the alert is escalated)
    alert: link.alert,   // originating Alert (provenance)
    caseNumber: body.caseNumber || link.caseNumber,
    partA: body.partA,
    partB: body.partB,
    partC: body.partC,
    partD: body.partD,
    partE: body.partE,
    partF: body.partF,
    partG: body.partG,
    partH: body.partH,
    metadata: {
      ...body.metadata,
      createdBy: req.user?.id,
      version: body.metadata?.version || "1.0",
    },
    status: body.status || "draft",
  });

  // add initial workflow event
  smr.metadata = smr.metadata || {};
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created",
    fromStatus: null,
    toStatus: smr.status,
    notes: body.metadata?.notes || "Created via API",
  });
  await smr.save();

  res.status(201).json({ succeed: true, data: smr, id: smr._id });
});

// CREATE DUMMY
exports.createDummySMR = asyncHandler(async (req, res, next) => {
  const {
    primaryName = "John Doe",
    caseNumber = `DUMMY-${Date.now()}`,
    clientName,
  } = req.body;

  const smr = await SMR.create({
    reportId: `D-${Date.now()}`,
    partA: {
      designatedServices: ["Remittance services (money transfers)"],
      serviceStatus: "provided",
      suspicionReasons: ["Unusual transfer"],
      otherReasons: [],
    },
    partB: {
      groundsForSuspicion:
        "Large unexplained remittance to high-risk jurisdiction",
    },
    partC: {
      personOrganisation: {
        name: primaryName,
        businessAddress: {},
        isCustomer: true,
      },
    },
    partD: { hasOtherParties: false, otherParties: [] },
    partE: { hasUnidentifiedPersons: false, unidentifiedPersons: [] },
    partF: { transactions: [] },
    partG: {
      likelyOffence: ["Money laundering"],
      previousReports: [],
      otherGovernmentBodies: [],
      attachments: [],
    },
    partH: {
      reportingEntity: {
        name: clientName || process.env.FIRM_NAME || "Client",
        address: {},
        completedBy: {
          name: req.user?.name || "System",
          jobTitle: "Analyst",
          phone: "",
          email: req.user?.email || "",
        },
      },
    },
    metadata: { createdBy: req.user?.id, submissionDate: null },
    status: "draft",
  });

  smr.metadata = smr.metadata || {};
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "created_dummy",
    fromStatus: null,
    toStatus: smr.status,
    notes: `Dummy created - ${caseNumber}`,
  });
  await smr.save();

  res.status(201).json({ succeed: true, data: smr, id: smr._id });
});

// GET single
exports.getSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );
  res.status(200).json({ succeed: true, data: smr });
});

// UPDATE
exports.updateSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );

  Object.assign(smr, req.body);
  if (hasLinkageRef(req.body)) Object.assign(smr, await linkageOverrides(req.body, "caseId"));
  smr.metadata = smr.metadata || {};
  smr.metadata.updatedBy = req.user?.id;
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "updated",
    fromStatus: smr.status,
    toStatus: smr.status,
    notes: req.body.metadata?.notes || "Updated via API",
  });

  await smr.save();
  res.status(200).json({ succeed: true, data: smr });
});

// DELETE
exports.deleteSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );
  await smr.deleteOne();
  res.status(200).json({ succeed: true, data: req.params.id });
});

// SUBMIT (change status draft -> review and optionally send email)
exports.submitSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );

  const from = smr.status;
  smr.status = "review";
  smr.metadata.submissionDate = new Date();
  smr.metadata.updatedBy = req.user?.id;
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "submitted",
    fromStatus: from,
    toStatus: smr.status,
    notes: req.body.notes || "Submitted for review",
  });

  await smr.save();

  // optionally send notification email
  if (req.body.notify && req.body.notifyEmail) {
    const content = fillTemplate("submit", smr, {
      submittedBy: req.user?.name,
      submittedAt: smr.metadata.submissionDate,
    });
    await sendEmail({
      to: req.body.notifyEmail,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
  }

  res.status(200).json({ succeed: true, data: smr });
});

// APPROVE
exports.approveSMR = asyncHandler(async (req, res, next) => {
  const smr = await SMR.findById(req.params.id);
  if (!smr)
    return next(
      new ErrorResponse(`SMR not found with id ${req.params.id}`, 404)
    );
  const from = smr.status;
  smr.status = "approved";
  smr.metadata.updatedBy = req.user?.id;
  smr.metadata.workflowHistory = smr.metadata.workflowHistory || [];
  smr.metadata.workflowHistory.push({
    timestamp: new Date(),
    user: req.user?.id,
    action: "approved",
    fromStatus: from,
    toStatus: smr.status,
    notes: req.body.notes || "Approved",
  });
  await smr.save();

  res.status(200).json({ succeed: true, data: smr });
});

// @desc   Export a single SMR as a filing-grade PDF
// @route  GET /api/v1/smr-report/:id/export-pdf
// @access Private
//
// A suspicious matter report is a statutory instrument: parts A–H in a fixed
// order, with parts A and G printed as the full checklist so a reader can see
// what was NOT selected. The document carries its own provenance and a page
// footer, so a sheet separated from the case pack stays identifiable.

const {
  DESIGNATED_SERVICES,
  SUSPICION_REASONS,
  OFFENCE_TYPES,
  SERVICE_STATUSES,
  splitAgainstOptions,
} = require("../utils/smrFormOptions");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const val = (v) => (v === 0 ? "0" : v ? esc(v) : "&mdash;");

const fmtDate = (d) =>
  d && !Number.isNaN(new Date(d).getTime())
    ? new Date(d).toLocaleDateString("en-AU", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "&mdash;";

const fmtDateTime = (d) =>
  d && !Number.isNaN(new Date(d).getTime())
    ? new Date(d).toLocaleString("en-AU", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "&mdash;";

const fmtMoney = (m) =>
  m && Number.isFinite(Number(m.amount))
    ? `${esc(m.currencyCode || "")} ${Number(m.amount).toLocaleString("en-AU", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`.trim()
    : "&mdash;";

const fmtAddress = (a) =>
  a
    ? esc(
        [a.street, [a.city, a.state, a.postcode].filter(Boolean).join(" "), a.country]
          .filter(Boolean)
          .join(", ")
      )
    : "&mdash;";

// Markdown emphasis in the generated grounds narrative — printed raw it shows
// literal asterisks around every offence and amount.
const narrative = (text) =>
  text
    ? `<p class="narr">${esc(text)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br/>")}</p>`
    : `<p class="narr muted">Not recorded.</p>`;

const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;

/** Ticked / unticked box, printed for every option on the statutory list. */
const checkbox = (on, text, extra = false) =>
  `<div class="chk"><span class="box${on ? (extra ? " on extra" : " on") : ""}">${
    on ? "&#10003;" : ""
  }</span><span class="${on ? "sel" : "unsel"}">${esc(text)}</span></div>`;

const checklist = (options, values) => {
  const { selected, extras } = splitAgainstOptions(options, values);
  const boxes = options.map((o) => checkbox(selected.has(o), o)).join("");
  const extraBoxes = extras.length
    ? `<div class="extras"><div class="extras-note">Recorded on this report but not on the current standard list:</div>${extras
        .map((e) => checkbox(true, e, true))
        .join("")}</div>`
    : "";
  return `<div class="grid3">${boxes}</div>${extraBoxes}`;
};

const buildSmrReportHtml = (report) => {
  const partA = report.partA || {};
  const partB = report.partB || {};
  const person = report.partC?.personOrganisation || {};
  const otherParties = report.partD?.otherParties || [];
  const unidentified = report.partE?.unidentifiedPersons || [];
  const transactions = report.partF?.transactions || [];
  const partG = report.partG || {};
  const entity = report.partH?.reportingEntity || {};
  const meta = report.metadata || {};
  const history = meta.workflowHistory || [];

  const partySection = (label, party) =>
    party?.name
      ? `<td><div class="pname">${esc(party.name)}</div>${(party.institutions || [])
          .map(
            (i) =>
              `<div class="pinst">${esc(i.name || "")}</div><div class="paddr">${fmtAddress(
                i.address
              )}</div>`
          )
          .join("")}</td>`
      : `<td class="muted">&mdash;</td>`;

  const transactionBlocks = transactions.length
    ? transactions
        .map(
          (t, i) => `
    <div class="txn">
      <div class="txn-head">
        <span><strong>Transaction ${i + 1} of ${transactions.length}</strong>
          &nbsp;&middot;&nbsp; ${esc(t.type || "")}
          &nbsp;<span class="${t.completed ? "ok" : "flag"}">${
            t.completed ? "COMPLETED" : "NOT COMPLETED"
          }</span></span>
        <span class="amt">${fmtMoney(t.totalAmount)}</span>
      </div>
      <table class="kv">
        ${row("Date", fmtDateTime(t.date))}
        ${row("Reference number", val(t.referenceNumber))}
        ${row("Cash amount", fmtMoney(t.cashAmount))}
        ${row(
          "Foreign currency",
          t.foreignCurrencies?.length
            ? t.foreignCurrencies.map((f) => fmtMoney(f)).join(", ")
            : "&mdash;"
        )}
        ${row(
          "Digital currency",
          t.digitalCurrencies?.length
            ? t.digitalCurrencies
                .map(
                  (d) =>
                    `${esc(d.type || "")} ${d.amount ?? ""}${
                      d.walletAddress ? ` <span class="mono">${esc(d.walletAddress)}</span>` : ""
                    }`
                )
                .join("<br/>")
            : "&mdash;"
        )}
      </table>
      <table class="grid">
        <thead><tr><th style="width:33%">Sender</th><th style="width:33%">Payee</th><th>Beneficiary</th></tr></thead>
        <tbody><tr>
          ${partySection("Sender", t.sender)}
          ${partySection("Payee", t.payee)}
          ${partySection("Beneficiary", t.beneficiary)}
        </tr></tbody>
      </table>
    </div>`
        )
        .join("")
    : `<p class="narr muted">No transactions recorded.</p>`;

  return `<!DOCTYPE html>
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
            background: #fff3d6; color: #9a6b00; border: 1px solid #f2dfa6; }

  h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #005964;
       border-bottom: 1px solid #e4e6ea; padding-bottom: 4px; margin: 15px 0 8px; page-break-after: avoid; }
  h3 { font-size: 9px; color: #14161a; margin: 11px 0 5px; page-break-after: avoid; }

  table { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; width: 30%; background: #f6f8f8; color: #3d4048; font-weight: 600;
                padding: 4px 7px; border: 1px solid #e4e6ea; vertical-align: top; }
  table.kv td { padding: 4px 7px; border: 1px solid #e4e6ea; vertical-align: top; }
  table.grid th { background: #005964; color: #fff; text-align: left; padding: 4px 7px; font-size: 8px; }
  table.grid td { border: 1px solid #e4e6ea; padding: 4px 7px; vertical-align: top; }
  tr { page-break-inside: avoid; }

  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px 10px; margin-top: 4px; }
  .chk { display: flex; align-items: flex-start; gap: 5px; font-size: 8px; line-height: 1.35; }
  .box { display: inline-block; width: 8px; height: 8px; border: 1px solid #b8bcc4; border-radius: 2px;
         text-align: center; line-height: 8px; font-size: 7px; color: #fff; flex-shrink: 0; margin-top: 1px; }
  .box.on { background: #005964; border-color: #005964; }
  .box.on.extra { background: #8a5a2b; border-color: #8a5a2b; }
  .sel { color: #14161a; font-weight: 600; }
  .unsel { color: #9aa0aa; }
  .extras { margin-top: 6px; }
  .extras-note { font-size: 7.5px; color: #8a5a2b; margin-bottom: 3px; }

  .narr { font-size: 9px; line-height: 1.55; color: #3d4048; margin: 0 0 7px; text-align: justify; }
  .quote { border-left: 3px solid #005964; padding-left: 12px; }
  .muted { color: #9aa0aa; }
  .mono { font-family: Consolas, "Courier New", monospace; font-size: 8px; word-break: break-all; }

  .txn { border: 1px solid #e4e6ea; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; page-break-inside: avoid; }
  .txn-head { display: flex; justify-content: space-between; align-items: center; gap: 10px;
              background: #faf7f4; border: 1px solid #f0e6dc; border-radius: 5px; padding: 6px 10px; margin-bottom: 8px; font-size: 8.5px; }
  .txn-head .amt { font-size: 12px; font-weight: bold; color: #14161a; }
  .ok { color: #1f7a4d; font-weight: bold; font-size: 7.5px; }
  .flag { color: #ca2f7f; font-weight: bold; font-size: 7.5px; }
  .pname { font-weight: 600; color: #14161a; }
  .pinst { color: #3d4048; margin-top: 2px; }
  .paddr { color: #8b909a; font-size: 8px; margin-top: 1px; }

  .notice { margin-top: 14px; padding: 8px 10px; background: #fafbfb; border: 1px solid #e4e6ea;
            font-size: 7.5px; color: #71767f; line-height: 1.5; }
</style></head><body>

  <div class="masthead">
    <div class="right">
      <div><strong>${val(report.uid)}</strong></div>
      <div>Generated ${fmtDateTime(new Date())}</div>
    </div>
    <div class="brand">${esc(report.client?.name || "Dooit.ai")} &middot; Compliance</div>
    <h1>Suspicious Matter Report</h1>
    <div class="sub">
      Case ${val(report.caseNumber)} &nbsp;&middot;&nbsp;
      <span class="status">${val(report.status || "draft")}</span>
      &nbsp;&middot;&nbsp; Reported under s41, AML/CTF Act 2006
    </div>
  </div>

  <h2>Report particulars</h2>
  <table class="kv">
    ${row("Report UID", `<span class="mono">${val(report.uid)}</span>`)}
    ${row("Case number", `<span class="mono">${val(report.caseNumber)}</span>`)}
    ${row("Sequence", report.sequence != null ? `#${esc(report.sequence)}` : "&mdash;")}
    ${row("Created", fmtDate(report.createdAt))}
    ${row("Submission date", fmtDate(meta.submissionDate))}
    ${row("AUSTRAC reference", val(meta.austracReference))}
    ${row("Form version", val(meta.version))}
  </table>

  <h2>Part A &mdash; Designated services</h2>
  <h3>1. Designated service(s) to which the suspicious matter relates</h3>
  ${checklist(DESIGNATED_SERVICES, partA.designatedServices)}
  <h3>Was the designated service(s)</h3>
  <div class="grid3">
    ${SERVICE_STATUSES.map((s) => checkbox(partA.serviceStatus === s.value, s.label)).join("")}
  </div>
  <h3>2. Reason(s) for the suspicion</h3>
  ${checklist(SUSPICION_REASONS, partA.suspicionReasons)}
  <h3>Other reasons specified</h3>
  ${
    partA.otherReasons?.length
      ? partA.otherReasons.map((r) => `<p class="narr">&mdash; ${esc(r)}</p>`).join("")
      : `<p class="narr muted">None recorded.</p>`
  }

  <h2>Part B &mdash; Grounds for suspicion</h2>
  <div class="quote">${narrative(partB.groundsForSuspicion)}</div>

  <h2>Part C &mdash; Person or organisation</h2>
  <table class="kv">
    ${row("Name", val(person.name))}
    ${row("Other names", val((person.otherNames || []).join(", ")))}
    ${row("Is a customer", person.isCustomer ? "Yes" : "No")}
    ${row("Authorised agent", person.isAuthorisedAgent ? "Yes" : "No")}
    ${row("Date of birth", fmtDate(person.personDetails?.dateOfBirth))}
    ${row("Nationality", val(person.personDetails?.nationality))}
    ${row("Occupation", val(person.occupation))}
    ${row("Address", fmtAddress(person.businessAddress))}
    ${row("Phone", val((person.phoneNumbers || []).join(", ")))}
    ${row("Email", val((person.emails || []).join(", ")))}
    ${row("Documentation", val(person.documentation))}
  </table>

  ${
    person.accounts?.length || person.digitalWallets?.length
      ? `<h3>Accounts and wallets</h3>
  <table class="grid">
    <thead><tr><th style="width:22%">Type</th><th style="width:38%">Identifier</th><th>Institution / provider</th></tr></thead>
    <tbody>
      ${(person.accounts || [])
        .map(
          (a) =>
            `<tr><td>${val(a.type)}</td><td class="mono">${val(a.number)}</td><td>${val(
              a.institution
            )}</td></tr>`
        )
        .join("")}
      ${(person.digitalWallets || [])
        .map(
          (w) =>
            `<tr><td>${val(w.type)}</td><td class="mono">${val(w.identifier)}</td><td>${val(
              w.provider
            )}</td></tr>`
        )
        .join("")}
    </tbody>
  </table>`
      : ""
  }

  ${
    person.beneficialOwners?.length || person.officeHolders?.length
      ? `<h3>Beneficial owners and office holders</h3>
  <table class="grid">
    <thead><tr><th style="width:22%">Role</th><th style="width:28%">Name</th><th>Detail</th></tr></thead>
    <tbody>
      ${(person.beneficialOwners || [])
        .map(
          (b) =>
            `<tr><td>Beneficial owner</td><td>${val(b.name)}</td><td>${fmtAddress(
              b.address
            )}</td></tr>`
        )
        .join("")}
      ${(person.officeHolders || [])
        .map((o) => `<tr><td>Office holder</td><td>${val(o.name)}</td><td>${val(o.position)}</td></tr>`)
        .join("")}
    </tbody>
  </table>`
      : ""
  }

  ${
    person.identityVerification
      ? `<h3>Identity verification</h3>
  <table class="grid">
    <thead><tr><th style="width:22%">Method</th><th style="width:33%">Detail</th><th>Reference</th></tr></thead>
    <tbody>
      ${(person.identityVerification.documents || [])
        .map(
          (d) =>
            `<tr><td>Document</td><td>${val(d.type)} ${val(d.number)}</td><td>${val(
              d.country
            )}${d.expiry ? ` &middot; expires ${fmtDate(d.expiry)}` : ""}</td></tr>`
        )
        .join("")}
      ${(person.identityVerification.electronicSources || [])
        .map(
          (s) =>
            `<tr><td>Electronic source</td><td>${val(s.type)}</td><td class="mono">${val(
              s.identifier
            )}</td></tr>`
        )
        .join("")}
      ${(person.identityVerification.deviceIdentifiers || [])
        .map(
          (d) =>
            `<tr><td>Device</td><td>${val(d.type)}</td><td class="mono">${val(
              d.identifier
            )}</td></tr>`
        )
        .join("")}
    </tbody>
  </table>`
      : ""
  }

  <h2>Part D &mdash; Other parties</h2>
  ${
    otherParties.length
      ? `<table class="grid">
    <thead><tr><th style="width:30%">Name</th><th style="width:16%">Customer</th><th>Address</th></tr></thead>
    <tbody>${otherParties
      .map(
        (p) =>
          `<tr><td>${val(p.name)}</td><td>${p.isCustomer ? "Yes" : "No"}</td><td>${fmtAddress(
            p.businessAddress
          )}</td></tr>`
      )
      .join("")}</tbody>
  </table>`
      : `<p class="narr muted">No other parties recorded.</p>`
  }

  <h2>Part E &mdash; Unidentified persons</h2>
  ${
    unidentified.length
      ? `<table class="grid">
    <thead><tr><th style="width:60%">Description</th><th>Documentation held</th></tr></thead>
    <tbody>${unidentified
      .map((u) => `<tr><td>${val(u.description)}</td><td>${val(u.documentation)}</td></tr>`)
      .join("")}</tbody>
  </table>`
      : `<p class="narr muted">No unidentified persons recorded.</p>`
  }

  <h2>Part F &mdash; Transaction details</h2>
  ${transactionBlocks}

  <h2>Part G &mdash; Additional information</h2>
  <h3>Likely offence</h3>
  <div class="grid3">
    ${(() => {
      const { selected, extras } = splitAgainstOptions(OFFENCE_TYPES, partG.likelyOffence);
      return (
        OFFENCE_TYPES.map((o) => checkbox(selected.has(o), o)).join("") +
        extras.map((e) => checkbox(true, e, true)).join("")
      );
    })()}
  </div>

  ${
    partG.previousReports?.length
      ? `<h3>Previous reports</h3>
  <table class="grid">
    <thead><tr><th style="width:40%">Reference</th><th>Date lodged</th></tr></thead>
    <tbody>${partG.previousReports
      .map(
        (p) => `<tr><td class="mono">${val(p.referenceNumber)}</td><td>${fmtDate(p.date)}</td></tr>`
      )
      .join("")}</tbody>
  </table>`
      : ""
  }

  ${
    partG.otherGovernmentBodies?.length
      ? `<h3>Other government bodies notified</h3>
  <table class="grid">
    <thead><tr><th style="width:28%">Body</th><th style="width:16%">Date</th><th>Information provided</th></tr></thead>
    <tbody>${partG.otherGovernmentBodies
      .map(
        (g) =>
          `<tr><td>${val(g.name)}</td><td>${fmtDate(g.dateReported)}</td><td>${val(
            g.informationProvided
          )}</td></tr>`
      )
      .join("")}</tbody>
  </table>`
      : ""
  }

  ${
    partG.attachments?.length
      ? `<h3>Attachments</h3><p class="narr">${partG.attachments
          .map((a) => esc(a))
          .join("<br/>")}</p>`
      : ""
  }

  <h2>Part H &mdash; Reporting entity</h2>
  <table class="kv">
    ${row("Entity", val(entity.name))}
    ${row("Address", fmtAddress(entity.address))}
    ${row("Branch", val(entity.branchName))}
    ${row("Internal reference", `<span class="mono">${val(entity.internalReference)}</span>`)}
    ${row("Completed by", val(entity.completedBy?.name))}
    ${row("Job title", val(entity.completedBy?.jobTitle))}
    ${row("Contact", `${val(entity.completedBy?.phone)} &middot; ${val(entity.completedBy?.email)}`)}
  </table>

  ${
    history.length
      ? `<h2>Workflow history</h2>
  <table class="grid">
    <thead><tr><th style="width:17%">Timestamp</th><th style="width:12%">Action</th><th style="width:11%">Status</th><th>Notes</th></tr></thead>
    <tbody>${history
      .map(
        (h) =>
          `<tr><td>${fmtDateTime(h.timestamp)}</td><td>${val(h.action)}</td><td>${val(
            h.toStatus
          )}</td><td>${esc(h.notes || "")
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</td></tr>`
      )
      .join("")}</tbody>
  </table>`
      : ""
  }

  <div class="notice">
    <strong>Confidential &mdash; suspicious matter report.</strong>
    Lodged under s41 of the Anti-Money Laundering and Counter-Terrorism Financing Act 2006.
    Disclosing the existence or contents of this report to the person it concerns, or to any
    person other than as permitted by the Act, may constitute an offence of tipping off under
    s123. Retain in accordance with the entity's record-keeping obligations.
  </div>

</body></html>`;
};

exports.buildSmrReportHtml = buildSmrReportHtml;

exports.exportSmrReportPdf = asyncHandler(async (req, res, next) => {
  const { launchPdfBrowser } = require("../utils/puppeteerLaunch");

  const report = await SMR.findById(req.params.id).populate("client").lean();

  if (!report) {
    return next(new ErrorResponse(`SMR not found with id ${req.params.id}`, 404));
  }

  const html = buildSmrReportHtml(report);

  let browser;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      // A lodged report is filed and photocopied; a loose sheet has to remain
      // identifiable, so every page carries the uid, case number and position.
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%; font-size:7px; color:#8a8a8a; padding:0 13mm;' +
        'font-family: Helvetica, Arial, sans-serif; display:flex; justify-content:space-between;">' +
        "<span>SMR " +
        esc(report.uid || "") +
        " &middot; " +
        esc(report.caseNumber || "") +
        "</span>" +
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
        "</div>",
      margin: { top: "16mm", bottom: "18mm", left: "13mm", right: "13mm" },
    });

    const safeName = String(report.uid || report._id).replace(/[^A-Za-z0-9._-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="SMR_' + safeName + '.pdf"');
    res.send(Buffer.from(pdfBuffer));
  } finally {
    if (browser) await browser.close();
  }
});

