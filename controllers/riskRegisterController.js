const RiskRegister = require("../models/RiskRegister");
const RiskPoolItem = require("../models/RiskPoolItem");
const EntityConfig = require("../models/EntityConfig");
const Client       = require("../models/Client");
const { buildRiskRegister, summarize } = require("../utils/riskRegisterEngine");
const { inherentBand, residualBand, BAND_LABELS } = require("../utils/ewraRiskRegister");
const { evaluateCondition, applyLMods }  = require("../utils/conditionEvaluator");
const { RISK_POOL_SEED, ENTITY_CONFIG_SEED } = require("../data/riskPoolSeed");

// ── CTRL_CATEGORY (factorId → ctrl-eff bucket) ───────────────────────────────

const CTRL_CATEGORY = {
  EW_C_001:"cdd",  EW_C_002: "cdd",
  EW_CH_001:"cdd", EW_CH_002:"cdd",
  EW_CH_003:"tm",  EW_CH_004:"tm",
  EW_P_001:"tm",   EW_P_002:"scr",
  EW_P_003:"tm",   EW_P_004:"gov",
  EW_G_001:"scr",  EW_G_002:"scr",
  EW_G_003:"geo",
  EW_C_003:"cdd",  EW_C_004:"cdd",
  EW_G_004:"geo",
  EW_E_001:"gov",  EW_E_002:"gov",  EW_E_003:"gov",  EW_E_004:"gov",  EW_E_005:"gov",
};

// ── helpers ───────────────────────────────────────────────────────────────────

const ok  = (res, data, code = 200) => res.status(code).json({ success: true,  data });
const err = (res, msg,  code = 400) => res.status(code).json({ success: false, error: msg });

function parseCtrlEff(raw = {}) {
  const keys = ["cdd", "tm", "scr", "geo", "gov"];
  const out  = {};
  keys.forEach(k => {
    const v = Number(raw[k]);
    out[k] = (v >= 1 && v <= 5) ? v : 3;
  });
  return out;
}

function buildSummary(rows) {
  return summarize(rows);
}

// ── clientType → entityType fuzzy map ────────────────────────────────────────

const VALID_ENTITY_TYPES = [
  "Lawyers/Conveyancers", "Accountants", "Real Estate Agents",
  "Precious Metal Dealers", "TCSPs",
  "Banks & ADIs", "Remittance", "VASP/DCEP",
  "Gambling/Casino", "Insurance",
];

const CLIENT_TYPE_MAP = [
  [/lawyer|conveyancer/i,              "Lawyers/Conveyancers"],
  [/accountant/i,                      "Accountants"],
  [/real\s*estate/i,                   "Real Estate Agents"],
  [/precious\s*metal/i,                "Precious Metal Dealers"],
  [/tcsp|trust.*company/i,             "TCSPs"],
  [/bank|adi|credit\s*union/i,         "Banks & ADIs"],
  [/remittance|money\s*transfer/i,     "Remittance"],
  [/vasp|crypto|dcep|digital\s*asset/i,"VASP/DCEP"],
  [/gambl|casino/i,                    "Gambling/Casino"],
  [/insurance/i,                       "Insurance"],
];

function resolveEntityType(clientType = "") {
  if (VALID_ENTITY_TYPES.includes(clientType)) return clientType;
  for (const [re, mapped] of CLIENT_TYPE_MAP) {
    if (re.test(clientType)) return mapped;
  }
  return null;
}

// ── DB risk-pool engine ───────────────────────────────────────────────────────

async function buildFromDB(answers, ctrlEff, cid = null) {
  try {
    const rawItems = await RiskPoolItem
      .find({
        isActive: true,
        $or: [{ client: null }, ...(cid ? [{ client: cid }] : [])],
      })
      .sort({ sortOrder: 1, sec: 1 })
      .lean();

    let items = rawItems;
    if (items.length === 0) {
      const ops = RISK_POOL_SEED.map(row => ({
        updateOne: {
          filter: { ref: row.ref, client: null },
          update: { $setOnInsert: { ...row, client: null } },
          upsert: true,
        },
      }));
      await RiskPoolItem.bulkWrite(ops, { ordered: false });

      const cfgOps = ENTITY_CONFIG_SEED.map(cfg => ({
        updateOne: { filter: { entityType: cfg.entityType }, update: { $setOnInsert: cfg }, upsert: true },
      }));
      await EntityConfig.bulkWrite(cfgOps, { ordered: false });

      items = await RiskPoolItem
        .find({ isActive: true, $or: [{ client: null }, ...(cid ? [{ client: cid }] : [])] })
        .sort({ sortOrder: 1, sec: 1 })
        .lean();
    }

    // Client-specific items override globals of the same ref
    const seen        = new Set();
    const deduped     = [];
    const clientItems = items.filter(r => r.client != null);
    const globalItems = items.filter(r => r.client == null);
    clientItems.forEach(r => { seen.add(r.ref); deduped.push(r); });
    globalItems.forEach(r => { if (!seen.has(r.ref)) deduped.push(r); });
    deduped.sort((a, b) => (a.sortOrder - b.sortOrder) || a.ref.localeCompare(b.ref));
    items = deduped;

    const entityType = answers.entity_type || "";
    const ce         = { cdd: 3, tm: 3, scr: 3, geo: 3, gov: 3, ...ctrlEff };
    const owner      = answers.co_name || "AML/CTF CO";
    const prepBy     = answers.co_name || "CO";
    const revBy      = answers.sm_name || "CO";

    return items
      .filter(row => {
        const ents = row.entities;
        if (ents !== "ALL" && Array.isArray(ents) && !ents.includes(entityType)) return false;
        return evaluateCondition(row.condition, answers);
      })
      .map((row, idx) => {
        const L   = applyLMods(row.lMods, answers, row.L);
        const C   = row.C;
        const inh = inherentBand(L, C);
        const cat = CTRL_CATEGORY[row.ctrlFactor] || "gov";
        const ceV = ce[cat];
        const res = residualBand(inh, ceV);

        return {
          rowNum:               idx + 1,
          sec:                  row.sec,
          secName:              row.secName,
          ref:                  row.ref,
          riskType:             row.riskType,
          ch:                   row.ch,
          riskName:             row.riskName,
          description:          row.description,
          pfSanctionsNote:      row.pfSanctionsNote,
          L, C,
          inherentRisk:         inh,
          inherentRiskLabel:    BAND_LABELS[inh] || inh,
          existingControls:     row.existingControls,
          controlIds:           row.controlIds || [],
          ctrlFactor:           row.ctrlFactor,
          category:             cat,
          controlEffectiveness: ceV,
          residualRisk:         res,
          residualRiskLabel:    BAND_LABELS[res] || res,
          actionRequired:       res === "H" || res === "E",
          withinRiskAppetite:   !(res === "H" || res === "E"),
          controlsOwner:        owner,
          preparedBy:           prepBy,
          reviewedBy:           revBy,
          status:               "Draft",
          manualL:              undefined,
          manualC:              undefined,
        };
      });
  } catch (dbErr) {
    console.error("[riskRegister] DB engine error, falling back to static:", dbErr.message);
    return buildRiskRegister(answers, ctrlEff);
  }
}

// ── Excel export helper ───────────────────────────────────────────────────────

const BAND_STYLE = {
  VL: "background:#BDD7EE;color:#1F4E79;",
  L:  "background:#E2EFDA;color:#375623;",
  M:  "background:#FFEB9C;color:#7D5A00;",
  H:  "background:#FFC7CE;color:#9C0006;",
  E:  "background:#C00000;color:#FFFFFF;",
};
const SEC_HDR  = "background:#1F3864;color:#FFFFFF;font-weight:bold;font-size:11pt;";
const COL_HDR  = "background:#2E4057;color:#FFFFFF;font-weight:bold;font-size:9pt;";
const ENT_HDR  = "background:#17375E;color:#FFFFFF;font-weight:bold;font-size:10pt;";
const NUM_COLS = 18;

const COL_HEADERS = [
  "ref","risk_type","channel","risk_name","description_cause_red_flags",
  "pf_sanctions_note","likelihood","consequence","inherent_risk",
  "existing_controls","ctrl_eff","residual_risk","action_required",
  "control_ids","controls_owner","risk_appetite","prepared_by","reviewed_by",
];

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function td(v, style = "") {
  return `<td${style ? ` style="${style}"` : ""}>${esc(v)}</td>`;
}
function tdRisk(code) {
  return `<td style="text-align:center;font-weight:bold;${BAND_STYLE[code] || ""}">${esc(code)}</td>`;
}
function tdMerge(v, colspan, style = "") {
  return `<td${style ? ` style="${style}"` : ""} colspan="${colspan}">${esc(v)}</td>`;
}

function buildXlsHtml(register) {
  const { answers = {}, ctrlEff = {}, rows = [] } = register;
  const entityName = register.entityName || answers.name    || "ENTITY";
  const entityType = register.entityType || "—";
  const coName     = register.coName     || answers.co_name || "—";
  const smName     = register.smName     || answers.sm_name || "—";
  const assessDate = register.assessDate
    ? new Date(register.assessDate).toISOString().slice(0, 10)
    : "—";

  const secMap = {};
  const secs   = [];
  rows.forEach(r => {
    if (!secMap[r.sec]) { secMap[r.sec] = []; secs.push(r.sec); }
    secMap[r.sec].push(r);
  });

  let dataRows = "";
  secs.forEach(sec => {
    const srows   = secMap[sec];
    const secName = srows[0].secName;
    dataRows += `<tr>${tdMerge(`${sec} — ${secName.toUpperCase()}`, NUM_COLS, SEC_HDR)}</tr>`;
    dataRows += `<tr>${COL_HEADERS.map(h => `<td style="${COL_HDR}text-align:center;">${esc(h)}</td>`).join("")}</tr>`;
    srows.forEach(r => {
      const base = "vertical-align:top;font-size:8.5pt;";
      const wrap = base + "word-wrap:break-word;white-space:pre-wrap;";
      const mono = base + "font-family:Consolas,monospace;font-size:8pt;";
      const ctr  = base + "text-align:center;font-weight:bold;";
      dataRows += `<tr>
        ${td(r.ref,          "font-weight:bold;color:#1F3864;font-family:Consolas,monospace;" + base)}
        ${td(r.riskType,     base)}
        ${td(r.ch,           mono + "text-align:center;")}
        ${td(r.riskName,     "font-weight:600;" + wrap)}
        ${td(r.description,  wrap + "color:#444;")}
        ${td(r.pfSanctionsNote, wrap + "color:#444;font-size:8pt;")}
        ${td(r.L,            ctr)}
        ${td(r.C,            ctr)}
        ${tdRisk(r.inherentRisk)}
        ${td(r.existingControls, wrap + "color:#444;font-size:8pt;")}
        ${td(r.controlEffectiveness, ctr)}
        ${tdRisk(r.residualRisk)}
        ${td(r.actionRequired ? "Yes" : "No", r.actionRequired
            ? "background:#FF0000;color:#FFFFFF;font-weight:bold;text-align:center;" + base
            : "color:#375623;text-align:center;" + base)}
        ${td((r.controlIds || []).join(", "), mono + "font-size:7.5pt;color:#666;")}
        ${td(r.controlsOwner, base)}
        ${td("Y",             ctr + "color:#375623;")}
        ${td(r.preparedBy,    base)}
        ${td(r.reviewedBy,    base)}
      </tr>`;
    });
  });

  const inh      = { VL: 0, L: 0, M: 0, H: 0, E: 0 };
  const res      = { VL: 0, L: 0, M: 0, H: 0, E: 0 };
  const actionCnt = rows.filter(r => r.actionRequired).length;
  rows.forEach(r => { if (inh[r.inherentRisk] !== undefined) inh[r.inherentRisk]++; });
  rows.forEach(r => { if (res[r.residualRisk]  !== undefined) res[r.residualRisk]++; });

  dataRows += `<tr>${tdMerge(
    `RISK REGISTER SUMMARY — ${entityName} | Total: ${rows.length} risks | ` +
    `Inherent: VL=${inh.VL} L=${inh.L} M=${inh.M} H=${inh.H} E=${inh.E} | ` +
    `Residual: VL=${res.VL} L=${res.L} M=${res.M} H=${res.H} E=${res.E} | ` +
    `Action required: ${actionCnt} | Prepared: ${coName} | Reviewed: ${smName} | Date: ${assessDate}`,
    NUM_COLS, "background:#F2F2F2;font-size:8pt;color:#444;"
  )}</tr>`;

  dataRows += `<tr>${tdMerge(
    "Bands: VL=Very Low · L=Low · M=Medium · H=High · E=Extreme | " +
    "Inherent = L×C (5×5 matrix) | Residual = Inherent band adjusted by Control Effectiveness | " +
    "Channel: F=Face to face · D=Digital/Email · T=Telephone",
    NUM_COLS, "background:#EEF4FB;font-size:8pt;color:#1F4E79;"
  )}</tr>`;

  const colgroup = [
    "60px","80px","55px","180px","280px","160px",
    "40px","40px","80px","280px","40px","80px",
    "70px","200px","100px","70px","100px","100px",
  ].map(w => `<col style="width:${w}"/>`).join("");

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
       xmlns:x="urn:schemas-microsoft-com:office:excel"
       xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8"/>
<!--[if gte mso 9]><xml>
<x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Risk Register</x:Name>
<x:WorksheetOptions>
  <x:FreezePanes/><x:FrozenNoSplit/>
  <x:SplitHorizontal>5</x:SplitHorizontal>
  <x:TopRowBottomPane>5</x:TopRowBottomPane>
  <x:ActivePane>2</x:ActivePane>
</x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook>
</xml><![endif]-->
<style>
  table { border-collapse:collapse; width:100%; }
  td { border:1px solid #C9C9C9; padding:4px 6px; font-family:Calibri,Arial,sans-serif; font-size:9pt; vertical-align:top; }
</style>
</head>
<body><table>
  <colgroup>${colgroup}</colgroup>
  <tr style="height:28px;">${tdMerge(
    `${entityName} — ML/TF/PF Risk Register | dooit.ai EWRA | ${assessDate}`,
    NUM_COLS, ENT_HDR + "font-size:12pt;"
  )}</tr>
  <tr style="height:22px;">${tdMerge(
    `Entity: ${entityName} · Type: ${entityType} · CO: ${coName} · SM: ${smName}`,
    NUM_COLS, ENT_HDR + "font-size:9pt;"
  )}</tr>
  <tr style="height:18px;">${tdMerge(
    `Assessment Date: ${assessDate} · Total Risks: ${rows.length} · Action Required: ${actionCnt} items`,
    NUM_COLS, ENT_HDR + "font-size:8.5pt;"
  )}</tr>
  <tr style="height:16px;">${tdMerge(
    "Channels: F=Face to Face | D=Digital/Email | T=Telephone",
    NUM_COLS, "background:#EEF4FB;color:#1F4E79;font-size:8pt;"
  )}</tr>
  <tr style="height:4px;">${tdMerge("", NUM_COLS, "background:#1F3864;")}</tr>
  ${dataRows}
</table></body></html>`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

exports.createRegister = async (req, res) => {
  try {
    const { answers = {}, ctrlEff: ctrlEffRaw = {} } = req.body;

    if (!answers.entity_type) return err(res, "answers.entity_type is required");
    if (!answers.name)        return err(res, "answers.name (entity name) is required");

    const ctrlEff = parseCtrlEff(ctrlEffRaw);
    const rows    = await buildFromDB(answers, ctrlEff, req.user?.client);
    const summary = buildSummary(rows);

    const doc = await RiskRegister.create({
      entityName: answers.name,
      entityType: answers.entity_type,
      abn:        answers.abn       || "",
      assessDate: answers.assessDate ? new Date(answers.assessDate) : new Date(),
      coName:     answers.co_name   || "",
      coEmail:    answers.co_email  || "",
      coPhone:    answers.co_phone  || "",
      smName:     answers.sm_name   || "",
      smEmail:    answers.sm_email  || "",
      answers,
      ctrlEff,
      rows,
      ...summary,
      client:    req.user?.client,
      createdBy: req.user?._id,
    });

    return ok(res, doc, 201);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

/**
 * Core logic for building a RiskRegister from a Client record.
 * Exported so other controllers (e.g. onboarding flow) can call it directly.
 *
 * @param {string} clientId       - Client._id
 * @param {Object} ctrlEffOverride - Raw ctrlEff object from request body (optional)
 * @param {Object} user            - req.user (provides client ref + createdBy)
 * @returns {Promise<Document>}    - Created RiskRegister document
 */
const createRiskRegisterFromClient = async (clientId, ctrlEffOverride = {}, user = {}) => {
  const client = await Client.findById(clientId).lean();
  if (!client) {
    const e = new Error("Client not found");
    e.statusCode = 404;
    throw e;
  }

  const rq = client.riskQuestions || {};

  const entityType =
    rq.entity_type ||
    resolveEntityType(client.clientType) ||
    "Lawyers/Conveyancers";

  const answers = {
    name:       client.name,
    abn:        rq.abn        || client.registrationNumber || "",
    assessDate: rq.assessDate || new Date().toISOString().slice(0, 10),
    co_name:    rq.co_name    || client.legalRepresentative?.name  || "",
    co_email:   rq.co_email   || client.legalRepresentative?.email || client.email || "",
    co_phone:   rq.co_phone   || client.legalRepresentative?.phone || client.phone || "",
    sm_name:    rq.sm_name    || "",
    sm_email:   rq.sm_email   || "",
    ...rq,
    entity_type: entityType,
  };

  const ctrlEff = parseCtrlEff(ctrlEffOverride || rq.ctrlEff || {});
  const rows    = await buildFromDB(answers, ctrlEff, user?.client);
  const summary = buildSummary(rows);

  return RiskRegister.create({
    entityName: client.name,
    entityType,
    abn:        answers.abn       || "",
    assessDate: answers.assessDate ? new Date(answers.assessDate) : new Date(),
    coName:     answers.co_name   || "",
    coEmail:    answers.co_email  || "",
    coPhone:    answers.co_phone  || "",
    smName:     answers.sm_name   || "",
    smEmail:    answers.sm_email  || "",
    answers,
    ctrlEff,
    rows,
    ...summary,
    client:    user?.client,
    createdBy: user?._id,
  });
};

exports.createRiskRegisterFromClient = createRiskRegisterFromClient;
exports.resolveEntityType = resolveEntityType;

exports.createFromClient = async (req, res) => {
  try {
    const doc = await createRiskRegisterFromClient(
      req.params.clientId,
      req.body.ctrlEff,
      req.user
    );
    return ok(res, doc, 201);
  } catch (e) {
    return err(res, e.message, e.statusCode || 500);
  }
};

exports.listRegisters = async (req, res) => {
  try {
    const filter = { client: req.user?.client };
    if (req.query.status)     filter.status     = req.query.status;
    if (req.query.entityType) filter.entityType = req.query.entityType;
    if (req.query.entityName) filter.entityName = req.query.entityName;

    const page  = Math.max(Number(req.query.page)  || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const skip  = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      RiskRegister.find(filter)
        .select("-rows")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      RiskRegister.countDocuments(filter),
    ]);

    return ok(res, { registers: docs, total, page, pages: Math.ceil(total / limit) });
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.getRegisterByEntityName = async (req, res) => {
  try {
    const name = req.params.entityName?.trim();
    if (!name) return err(res, "entityName param is required");

    const doc = await RiskRegister.findOne({
      client:     req.user?.client,
      entityName: { $regex: `^${name}$`, $options: "i" },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!doc) return err(res, `No risk register found for entity "${name}"`, 404);
    return ok(res, doc);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.getRegister = async (req, res) => {
  try {
    const doc = await RiskRegister.findOne({
      _id: req.params.id, client: req.user?.client,
    }).lean();
    if (!doc) return err(res, "Risk register not found", 404);
    return ok(res, doc);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.updateRegister = async (req, res) => {
  try {
    const doc = await RiskRegister.findOne({
      _id: req.params.id, client: req.user?.client,
    });
    if (!doc) return err(res, "Risk register not found", 404);
    if (doc.status === "Approved") return err(res, "Approved registers cannot be edited");

    const answers = req.body.answers || doc.answers;
    const ctrlEff = parseCtrlEff(req.body.ctrlEff || doc.ctrlEff.toObject?.() || doc.ctrlEff);
    const rows    = await buildFromDB(answers, ctrlEff, req.user?.client);
    const summary = buildSummary(rows);

    doc.answers    = answers;
    doc.ctrlEff    = ctrlEff;
    doc.rows       = rows;
    doc.entityName = answers.name        || doc.entityName;
    doc.entityType = answers.entity_type || doc.entityType;
    doc.abn        = answers.abn         || doc.abn;
    doc.coName     = answers.co_name     || doc.coName;
    doc.coEmail    = answers.co_email    || doc.coEmail;
    doc.smName     = answers.sm_name     || doc.smName;
    doc.updatedBy  = req.user?._id;
    Object.assign(doc, summary);

    await doc.save();
    return ok(res, doc);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.recalculate = async (req, res) => {
  try {
    const doc = await RiskRegister.findOne({
      _id: req.params.id, client: req.user?.client,
    });
    if (!doc) return err(res, "Risk register not found", 404);

    const ctrlEff = parseCtrlEff(doc.ctrlEff.toObject?.() || doc.ctrlEff);
    const rows    = await buildFromDB(doc.answers, ctrlEff, req.user?.client);
    const summary = buildSummary(rows);

    doc.rows      = rows;
    doc.updatedBy = req.user?._id;
    Object.assign(doc, summary);
    await doc.save();
    return ok(res, doc);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.patchScenario = async (req, res) => {
  try {
    const doc = await RiskRegister.findOne({
      _id: req.params.id, client: req.user?.client,
    });
    if (!doc) return err(res, "Risk register not found", 404);

    const rowIndex = doc.rows.findIndex(r => r.ref === req.params.ref);
    if (rowIndex === -1) return err(res, `Scenario ${req.params.ref} not found`, 404);

    const row = doc.rows[rowIndex];
    const { L, C, ctrlEff: ceOverride, reviewerNotes, status } = req.body;

    if (L            !== undefined) { row.manualL       = Number(L);          row.L = Number(L); }
    if (C            !== undefined) { row.manualC       = Number(C);          row.C = Number(C); }
    if (ceOverride   !== undefined) { row.manualCtrlEff = Number(ceOverride); row.controlEffectiveness = Number(ceOverride); }
    if (reviewerNotes !== undefined) row.reviewerNotes  = reviewerNotes;
    if (status        !== undefined) row.status         = status;

    const inh = inherentBand(row.L, row.C);
    const res_ = residualBand(inh, row.controlEffectiveness);
    row.inherentRisk       = inh;
    row.inherentRiskLabel  = BAND_LABELS[inh]  || inh;
    row.residualRisk       = res_;
    row.residualRiskLabel  = BAND_LABELS[res_] || res_;
    row.actionRequired     = res_ === "H" || res_ === "E";
    row.withinRiskAppetite = !row.actionRequired;

    doc.rows[rowIndex] = row;
    doc.markModified("rows");
    const summary = buildSummary(doc.rows);
    Object.assign(doc, summary);
    doc.updatedBy = req.user?._id;
    await doc.save();

    return ok(res, { row: doc.rows[rowIndex], summary });
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.submitRegister = async (req, res) => {
  try {
    const doc = await RiskRegister.findOne({
      _id: req.params.id, client: req.user?.client,
    });
    if (!doc)                    return err(res, "Risk register not found", 404);
    if (doc.status !== "Draft")  return err(res, "Only Draft registers can be submitted");

    doc.status      = "In Review";
    doc.submittedAt = new Date();
    doc.updatedBy   = req.user?._id;
    await doc.save();
    return ok(res, doc);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.approveRegister = async (req, res) => {
  try {
    const doc = await RiskRegister.findOne({
      _id: req.params.id, client: req.user?.client,
    });
    if (!doc)                       return err(res, "Risk register not found", 404);
    if (doc.status !== "In Review") return err(res, "Only In Review registers can be approved");

    doc.status     = "Approved";
    doc.approvedAt = new Date();
    doc.approvedBy = req.user?._id;
    doc.updatedBy  = req.user?._id;
    await doc.save();
    return ok(res, doc);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.amendRegister = async (req, res) => {
  try {
    const original = await RiskRegister.findOne({
      _id: req.params.id, client: req.user?.client,
    }).lean();
    if (!original) return err(res, "Risk register not found", 404);
    if (original.status !== "Approved") return err(res, "Only Approved registers can be amended");

    const { _id, createdAt, updatedAt, submittedAt, approvedAt, approvedBy, __v, ...rest } = original;

    const amendment = await RiskRegister.create({
      ...rest,
      status:      "Draft",
      version:     (original.version || 1) + 1,
      amendedFrom: original._id,
      createdBy:   req.user?._id,
      updatedBy:   req.user?._id,
      client:      req.user?.client,
    });

    return ok(res, amendment, 201);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.deleteRegister = async (req, res) => {
  try {
    const doc = await RiskRegister.findOneAndDelete({
      _id: req.params.id, client: req.user?.client,
    });
    if (!doc) return err(res, "Risk register not found", 404);
    return ok(res, { message: "Deleted", id: req.params.id });
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.exportExcel = async (req, res) => {
  try {
    const doc = await RiskRegister.findOne({
      _id: req.params.id, client: req.user?.client,
    }).lean();
    if (!doc)              return err(res, "Risk register not found", 404);
    if (!doc.rows?.length) return err(res, "Register has no rows to export");

    const html     = buildXlsHtml(doc);
    const safeName = (doc.entityName || "ENTITY").replace(/[^a-z0-9]/gi, "_");
    const filename = `${safeName}_EWRA_Risk_Register.xls`;

    res.setHeader("Content-Type", "application/vnd.ms-excel;charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(html);
  } catch (e) {
    return err(res, e.message, 500);
  }
};
