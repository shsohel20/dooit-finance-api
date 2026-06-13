const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const EwraAssessment = require("../models/EwraAssessment");
const EwraRiskFactor = require("../models/EwraRiskFactor");
const EwraControlAssessment = require("../models/EwraControlAssessment");
const EwraRiskScenario = require("../models/EwraRiskScenario");
const Control = require("../models/Control");
const IssueRegister = require("../models/IssueRegister");
const RemediationTask = require("../models/RemediationTask");
const ErrorResponse = require("../utils/errorResponse");
const {
  inherentBand,
  residualBand,
  loadTemplateScenarios,
  BAND_LABELS,
  LABEL_TO_CODE,
  BAND_MIDPOINT,
  DEFAULT_REGISTER_SECTIONS,
  EXTRA_TEMPLATE_SCENARIOS,
} = require("../utils/ewraRiskRegister");

const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// ── Risk matrix (5×5 lookup) ───────────────────────────────────────────────────
// Rows = likelihood 1-5, Cols = consequence/impact 1-5
// Corrected 12 Jun 2026 against Risk_Matrix.md (L1C2=Very Low, L2C1=Very Low);
// canonical code-form grid lives in utils/ewraRiskRegister.js
const RISK_MATRIX = [
  ["Very Low","Very Low","Low","Medium","Medium"],
  ["Very Low","Low","Medium","Medium","High"],
  ["Low","Medium","Medium","High","Extreme"],
  ["Medium","Medium","High","Extreme","Extreme"],
  ["Medium","High","Extreme","Extreme","Extreme"],
];

function matrixRating(likelihood, impact) {
  const l = Math.min(5, Math.max(1, Math.round(likelihood))) - 1;
  const i = Math.min(5, Math.max(1, Math.round(impact))) - 1;
  return RISK_MATRIX[l][i];
}

function matrixScore(likelihood, impact) {
  return Math.round(((likelihood * impact) / 25) * 4 + 1);
}

function ratingFromScore(score) {
  if (score <= 1.0) return "Very Low";
  if (score <= 1.5) return "Low";
  if (score <= 2.5) return "Medium";
  if (score <= 3.5) return "High";
  return "Extreme";
}

function effectivenessLabel(score) {
  if (!score) return "";
  if (score <= 2) return "Ineffective";
  if (score <= 3) return "Partially Effective";
  if (score <= 4) return "Effective";
  return "Highly Effective";
}

// Review cycle years from entity_config seed collection
async function getReviewCycleYears(entityTypeName) {
  try {
    const cfg = await mongoose.connection
      .collection("entity_config")
      .findOne({ config_field: "default_review_cycle_years" });
    return cfg?.values?.[entityTypeName] ?? cfg?.[entityTypeName] ?? 3;
  } catch {
    return 3;
  }
}

// RAP template lookup from rap_templates seed collection
async function getRapTemplates() {
  try {
    return await mongoose.connection.collection("rap_templates").find({}).toArray();
  } catch {
    return [];
  }
}

// Dispatch notification helper (fire-and-forget; fails silently if model absent)
async function dispatchNotification(ruleId, payload = {}) {
  try {
    const AppNotification = require("../models/AppNotification");
    const NotificationRule = require("../models/NotificationRule");
    const rule = await NotificationRule.findOne({ notifId: ruleId }).lean();
    if (!rule) return;
    await AppNotification.create({
      ruleId,
      title: rule.notifName,
      urgency: rule.urgency,
      actionLabel: rule.actionButtonLabel,
      actionUrl: rule.actionDestination,
      ...payload,
    });
  } catch {
    // notification engine not yet mounted — safe to skip
  }
}

// Default 21 risk factors (name, category, sortOrder, weight, factorId)
const DEFAULT_FACTORS = [
  { factorId:"EW_C_001", category:"Customer",     factorName:"Customer Base Profile",         description:"Overall risk profile of the customer base including demographics and behaviour patterns", weight:25, sortOrder:1 },
  { factorId:"EW_C_002", category:"Customer",     factorName:"Higher-Risk Customers",          description:"Exposure to PEPs, high-risk industries, cash-intensive businesses and non-residents", weight:35, sortOrder:2 },
  { factorId:"EW_C_003", category:"Customer",     factorName:"Geographic Concentration",       description:"Concentration of customers in high-risk or sanctioned jurisdictions", weight:25, sortOrder:3 },
  { factorId:"EW_C_004", category:"Customer",     factorName:"Customer Change Impact",         description:"ML/TF risk introduced by new customer segments, onboarding channel changes or portfolio acquisitions", weight:15, sortOrder:4 },
  { factorId:"EW_P_001", category:"Product",      factorName:"Product Complexity",             description:"Complexity and opacity of products including bearer instruments, structured products and derivatives", weight:25, sortOrder:1 },
  { factorId:"EW_P_002", category:"Product",      factorName:"Anonymity Level",                description:"Degree to which products allow anonymous or pseudonymous transactions", weight:30, sortOrder:2 },
  { factorId:"EW_P_003", category:"Product",      factorName:"Transaction Velocity",           description:"Maximum velocity and value of transactions enabled by products and services", weight:25, sortOrder:3 },
  { factorId:"EW_P_004", category:"Product",      factorName:"New Product/Service Risk",       description:"ML/TF risk introduced by new or materially changed products and services", weight:20, sortOrder:4 },
  { factorId:"EW_CH_001",category:"Channel",      factorName:"Non-Face-to-Face Channels",      description:"Volume of business conducted through digital, remote or automated channels", weight:30, sortOrder:1 },
  { factorId:"EW_CH_002",category:"Channel",      factorName:"Third-Party / Intermediary Risk",description:"Reliance on agents, introducers and third-party channels for customer acquisition", weight:30, sortOrder:2 },
  { factorId:"EW_CH_003",category:"Channel",      factorName:"Cash Handling",                  description:"Extent of cash acceptance and handling across channels", weight:25, sortOrder:3 },
  { factorId:"EW_CH_004",category:"Channel",      factorName:"Automation Level",               description:"Degree of automated processing reducing human oversight of transactions", weight:15, sortOrder:4 },
  { factorId:"EW_G_001", category:"Geographic",   factorName:"Operating Jurisdictions",        description:"Risk profile of jurisdictions in which the entity operates or is licensed", weight:30, sortOrder:1 },
  { factorId:"EW_G_002", category:"Geographic",   factorName:"Customer Geographic Distribution",description:"Concentration of customers in high-risk or FATF grey/black-listed countries", weight:30, sortOrder:2 },
  { factorId:"EW_G_003", category:"Geographic",   factorName:"Transaction Corridors",          description:"Risk profile of cross-border transaction corridors used by customers", weight:25, sortOrder:3 },
  { factorId:"EW_G_004", category:"Geographic",   factorName:"Counterparty Location Risk",     description:"Risk from counterparties, correspondent banks or payment networks in high-risk jurisdictions", weight:15, sortOrder:4 },
  { factorId:"EW_E_001", category:"Environmental",factorName:"Predicate Offences Environment", description:"Prevalence of predicate offences (drug trafficking, fraud, corruption) in operating markets", weight:20, sortOrder:1 },
  { factorId:"EW_E_002", category:"Environmental",factorName:"Terrorist Financing Threat",     description:"Threat level of terrorist financing in jurisdictions where the entity operates", weight:20, sortOrder:2 },
  { factorId:"EW_E_003", category:"Environmental",factorName:"Regulatory Landscape",           description:"Stringency and maturity of AML/CTF regulatory environment including AUSTRAC oversight intensity", weight:20, sortOrder:3 },
  { factorId:"EW_E_004", category:"Environmental",factorName:"Governance & Compliance Culture",description:"Strength of internal governance, AML culture and Board/senior management commitment", weight:20, sortOrder:4 },
  { factorId:"EW_E_005", category:"Environmental",factorName:"Business Strategy Risk",         description:"ML/TF risk from planned business expansions, M&A activity or new market entry", weight:20, sortOrder:5 },
];

// Enrich default factors with entity-type inherent score defaults from seed
async function enrichWithEntityDefaults(factors, entityTypeName) {
  try {
    // ewra_factors columns are keyed by BARE entity type names
    // ("Lawyers/Conveyancers", "Real Estate Agents"), while EntityType.name is
    // tranche-prefixed ("Tranche 2 - Real Estate") — normalise via the shared
    // mapper (also handles Real Estate → Real Estate Agents).
    const { mapEntityTypeName } = require("../utils/craEntityType");
    const columnName = mapEntityTypeName(entityTypeName);

    const seedFactors = await mongoose.connection
      .collection("ewra_factors").find({}).toArray();
    return factors.map((f) => {
      const seed = seedFactors.find((s) => s.factor_id === f.factorId);
      const defaultScore =
        (columnName ? seed?.[columnName] : null) ?? seed?.[entityTypeName] ?? null;
      return { ...f, likelihood: defaultScore };
    });
  } catch {
    return factors;
  }
}

// ── Assessment CRUD ────────────────────────────────────────────────────────────

// @route GET /api/v1/ewra
exports.listAssessments = asyncHandler(async (req, res) => {
  const { status, entityProfile, amendmentType, page = 1, limit = 20 } = req.query;
  const filter = { client: getClient(req) };
  if (status) filter.status = status;
  if (entityProfile) filter.entityProfile = entityProfile;
  if (amendmentType) filter.amendmentType = amendmentType;

  const options = {
    page: parseInt(page),
    limit: parseInt(limit),
    sort: { createdAt: -1 },
    populate: { path: "entityProfile", select: "entityName entityType" },
  };
  const result = await EwraAssessment.paginate(filter, options);

  res.status(200).json({
    success: true,
    pagination: { page: result.page, limit: result.limit, total: result.totalDocs, totalPages: result.totalPages },
    data: result.docs,
  });
});

// @route POST /api/v1/ewra
/**
 * Seed the 28 template risk scenarios (VDG register format) for a new
 * assessment, linking each to its parent EWRA factor by factorRef.
 */
async function seedTemplateScenarios(assessmentId, clientId, factorDocs = []) {
  const byRef = new Map(factorDocs.map((f) => [f.factorId, f._id]));
  const templates = [...loadTemplateScenarios(), ...EXTRA_TEMPLATE_SCENARIOS];
  if (!templates.length) return;

  await EwraRiskScenario.insertMany(
    templates.map((t) => ({
      ...t,
      assessmentId,
      factorId: byRef.get(t.factorRef) || null,
      source: "template",
      templateRef: t.ref,
      status: "Draft",
      client: clientId,
    })),
  );
}

exports.createAssessment = asyncHandler(async (req, res) => {
  const clientId = getClient(req);
  const {
    assessmentName, entityProfile, assessmentType = "EWRA", riskTypes,
    periodStart, periodEnd, version, ewraAnswers,
  } = req.body;

  const categoryScores = ["Customer","Product","Channel","Geographic","Environmental"].map((c) => ({
    category: c, weight: 20,
    inherentScore: null, controlScore: null, residualScore: null, rating: "",
  }));

  const assessment = await EwraAssessment.create({
    assessmentName, entityProfile, assessmentType, riskTypes,
    periodStart, periodEnd, version,
    amendmentType: "initial",
    categoryScores,
    registerSections: DEFAULT_REGISTER_SECTIONS,
    ewraAnswers: ewraAnswers || {},
    client: clientId,
    createdBy: req.user?.id || null,
  });

  // Resolve entity type name for seed defaults
  let entityTypeName = null;
  try {
    const ep = await mongoose.connection.collection("entityprofiles")
      .findOne({ _id: new mongoose.Types.ObjectId(entityProfile) });
    if (ep?.entityType) {
      const et = await mongoose.connection.collection("entitytypes")
        .findOne({ _id: new mongoose.Types.ObjectId(ep.entityType) });
      entityTypeName = et?.name || null;
    }
  } catch { /* non-fatal */ }

  const enriched = await enrichWithEntityDefaults(DEFAULT_FACTORS, entityTypeName);
  const factors = enriched.map((f) => ({ ...f, assessmentId: assessment._id, client: clientId }));
  const insertedFactors = await EwraRiskFactor.insertMany(factors);
  await EwraAssessment.findByIdAndUpdate(assessment._id, { factorsTotal: factors.length });

  // Seed the scenario-level risk register from the template
  // (sample_risk_register.json) — CO adjusts scores to the entity's reality
  await seedTemplateScenarios(assessment._id, clientId, insertedFactors);

  // N_002 — EWRA Draft Ready
  await dispatchNotification("N_002", { client: clientId, entityProfile, linkedRecord: assessment._id, linkedRecordType: "EwraAssessment" });

  res.status(201).json({ success: true, data: assessment });
});

// @route GET /api/v1/ewra/:id
exports.getAssessment = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findById(req.params.id)
    .populate({
      path: "entityProfile",
      select: "entityName entityType abn licenses status",
      // entityType.name drives the NRA floor banner and the entity-scoped
      // product factor picker in the UI
      populate: { path: "entityType", select: "name category" },
    })
    .populate("priorAssessmentId", "assessmentName residualRiskRating approvedAt")
    .lean();
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));
  res.status(200).json({ success: true, data: assessment });
});

// @route PUT /api/v1/ewra/:id
exports.updateAssessment = asyncHandler(async (req, res, next) => {
  const allowed = [
    "assessmentName","assessmentType","riskTypes","periodStart","periodEnd","version",
    "reviewNotes","categoryScores","ewraAnswers","triggerReason","amendmentType",
  ];
  const update = {};
  allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  update.updatedBy = req.user?.id || null;

  const assessment = await EwraAssessment.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));
  res.status(200).json({ success: true, data: assessment });
});

// @route DELETE /api/v1/ewra/:id
exports.deleteAssessment = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findById(req.params.id);
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));
  if (assessment.status === "Approved") return next(new ErrorResponse("Cannot delete an approved assessment", 400));

  await Promise.all([
    EwraRiskFactor.deleteMany({ assessmentId: req.params.id }),
    EwraControlAssessment.deleteMany({ assessmentId: req.params.id }),
    assessment.deleteOne(),
  ]);
  res.status(200).json({ success: true, data: {} });
});

// ── Amendment ──────────────────────────────────────────────────────────────────

// @route POST /api/v1/ewra/:id/amend
exports.createAmendment = asyncHandler(async (req, res, next) => {
  const prior = await EwraAssessment.findById(req.params.id).lean();
  if (!prior) return next(new ErrorResponse("Assessment not found", 404));
  if (!["Approved","In Review"].includes(prior.status)) {
    return next(new ErrorResponse("Only Approved or In Review assessments can be amended", 400));
  }

  const clientId = getClient(req);
  const { triggerReason = "", amendmentType = "trigger_update" } = req.body;

  // Create amendment as a new Draft, linked to prior
  const { _id, createdAt, updatedAt, __v, ...priorData } = prior;
  const amendment = await EwraAssessment.create({
    ...priorData,
    status: "Draft",
    amendmentType,
    triggerReason,
    priorAssessmentId: prior._id,
    amendmentPending: false,
    submittedBy: null, submittedAt: null,
    approvedBy: null,  approvedAt: null,
    reviewNotes: "",
    factorsComplete: 0,
    createdBy: req.user?.id || null,
    updatedBy: null,
    client: clientId,
  });

  // Copy prior factors into amendment with delta tracking
  const priorFactors = await EwraRiskFactor.find({ assessmentId: prior._id }).lean();
  if (priorFactors.length) {
    await EwraRiskFactor.insertMany(
      priorFactors.map(({ _id: fid, createdAt: fc, updatedAt: fu, __v: fv, ...f }) => ({
        ...f,
        assessmentId: amendment._id,
        priorInherentScore: f.inherentScore,
        priorResidualScore: f.residualScore,
        status: "Not Started",
        delta: "",
        client: clientId,
      }))
    );
  }

  // Carry the scenario register forward (CO-adjusted values preserved),
  // re-linking each scenario to the amendment's copied factor by factorRef
  const priorScenarios = await EwraRiskScenario.find({ assessmentId: prior._id }).lean();
  if (priorScenarios.length) {
    const newFactors = await EwraRiskFactor.find({ assessmentId: amendment._id })
      .select("factorId").lean();
    const byRef = new Map(newFactors.map((f) => [f.factorId, f._id]));
    await EwraRiskScenario.insertMany(
      priorScenarios.map(({ _id: sid, createdAt: sc, updatedAt: su, __v: sv, ...s }) => ({
        ...s,
        assessmentId: amendment._id,
        factorId: byRef.get(s.factorRef) || null,
        priorInherentRisk: s.inherentRisk,
        priorResidualRisk: s.residualRisk,
        delta: "",
        status: "Draft",
        client: clientId,
      }))
    );
  }

  // Mark prior as amendment pending
  await EwraAssessment.findByIdAndUpdate(prior._id, { amendmentPending: true });

  // N_012 — Trigger event / amendment started
  await dispatchNotification("N_012", {
    client: clientId,
    linkedRecord: amendment._id,
    linkedRecordType: "EwraAssessment",
    body: triggerReason,
  });

  res.status(201).json({ success: true, data: amendment });
});

// @route GET /api/v1/ewra/:id/amend-diff
exports.getAmendmentDiff = asyncHandler(async (req, res, next) => {
  const amendment = await EwraAssessment.findById(req.params.id).lean();
  if (!amendment) return next(new ErrorResponse("Assessment not found", 404));
  if (!amendment.priorAssessmentId) {
    return res.status(200).json({ success: true, data: { hasPrior: false, factors: [] } });
  }

  const [currentFactors, priorFactors] = await Promise.all([
    EwraRiskFactor.find({ assessmentId: amendment._id }).lean(),
    EwraRiskFactor.find({ assessmentId: amendment.priorAssessmentId }).lean(),
  ]);

  const diff = currentFactors.map((f) => {
    const prior = priorFactors.find((p) => p.factorId === f.factorId || p.factorName === f.factorName);
    const priorResidual = prior?.residualScore ?? f.priorResidualScore ?? null;
    let delta = "new";
    if (priorResidual !== null) {
      delta = f.residualScore > priorResidual ? "up" : f.residualScore < priorResidual ? "down" : "same";
    }
    return {
      factorId:        f.factorId,
      factorName:      f.factorName,
      category:        f.category,
      currentResidual: f.residualScore,
      currentRating:   f.residualRating,
      priorResidual,
      priorRating:     prior?.residualRating ?? null,
      delta,
    };
  });

  res.status(200).json({
    success: true,
    data: {
      hasPrior: true,
      priorAssessmentId: amendment.priorAssessmentId,
      triggerReason: amendment.triggerReason,
      amendmentType: amendment.amendmentType,
      priorOverallRating: (await EwraAssessment.findById(amendment.priorAssessmentId).select("residualRiskRating").lean())?.residualRiskRating,
      currentOverallRating: amendment.residualRiskRating,
      factors: diff,
    },
  });
});

// ── Risk Factors ───────────────────────────────────────────────────────────────

// @route GET /api/v1/ewra/:id/factors
exports.getFactors = asyncHandler(async (req, res) => {
  const { category } = req.query;
  const filter = { assessmentId: req.params.id };
  if (category) filter.category = category;
  const factors = await EwraRiskFactor.find(filter).sort({ category: 1, sortOrder: 1 });
  res.status(200).json({ success: true, count: factors.length, data: factors });
});

// @route POST /api/v1/ewra/:id/factors
exports.addFactor = asyncHandler(async (req, res) => {
  const factor = await EwraRiskFactor.create({
    ...req.body,
    assessmentId: req.params.id,
    client: getClient(req),
  });
  res.status(201).json({ success: true, data: factor });
});

// @route PUT /api/v1/ewra/:id/factors/:factorId
exports.updateFactor = asyncHandler(async (req, res, next) => {
  const allowed = ["factorName","description","weight","likelihood","impact","controlEffectiveness","rationale","keyIndicators","status","assignedTo"];
  const update = {};
  allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

  const factor = await EwraRiskFactor.findById(req.params.factorId);
  if (!factor) return next(new ErrorResponse("Factor not found", 404));

  const likelihood  = update.likelihood  ?? factor.likelihood  ?? 3;
  const impact      = update.impact      ?? factor.impact      ?? 3;
  const effectiveness = update.controlEffectiveness ?? factor.controlEffectiveness ?? 3;

  if (update.likelihood !== undefined || update.impact !== undefined) {
    update.inherentScore  = matrixScore(likelihood, impact);
    update.inherentRating = matrixRating(likelihood, impact);
  }

  // Residual via the Risk_Matrix.md band matrix (eff 3 keeps the band,
  // eff 4 drops one, eff 1 raises one) — NOT inherent × (1 − eff/5), which
  // understates risk (it zeroed out even Extreme at eff 5; matrix says Medium).
  const inherentRatingNow =
    update.inherentRating ?? factor.inherentRating ??
    (likelihood && impact ? matrixRating(likelihood, impact) : "");
  if (effectiveness !== null && inherentRatingNow) {
    const inhCode = LABEL_TO_CODE[inherentRatingNow];
    if (inhCode) {
      const resCode = residualBand(inhCode, effectiveness);
      update.residualRating = BAND_LABELS[resCode] || "";
      update.residualScore  = BAND_MIDPOINT[resCode] ?? null;
    }
  }

  // Track delta vs prior
  if (factor.priorResidualScore !== null && update.residualScore !== undefined) {
    if (update.residualScore > factor.priorResidualScore) update.delta = "up";
    else if (update.residualScore < factor.priorResidualScore) update.delta = "down";
    else update.delta = "same";
  }

  update.status = "Complete";

  const updated = await EwraRiskFactor.findByIdAndUpdate(req.params.factorId, update, { new: true, runValidators: true });
  res.status(200).json({ success: true, data: updated });
});

// @route DELETE /api/v1/ewra/:id/factors/:factorId
exports.deleteFactor = asyncHandler(async (req, res, next) => {
  const factor = await EwraRiskFactor.findByIdAndDelete(req.params.factorId);
  if (!factor) return next(new ErrorResponse("Factor not found", 404));
  res.status(200).json({ success: true, data: {} });
});

// ── Risk Register Scenarios (micro layer — VDG register format) ───────────────

/**
 * Derive scenario control-effectiveness from the assessment's ASSESSED
 * controls (the register is a report over factors + controls — scenario
 * eff must follow the Controls tab, not free-typed numbers).
 *
 * For every scenario whose controlIds match ≥1 assessed control:
 *   controlEffectiveness = round(avg(linked effectivenessScores)) clamped 1–5
 *   residualRisk         = residual matrix(inherent band, derived eff)
 *   ctrlEffSource        = "derived"
 * Scenarios with no assessed linked controls keep their manual values.
 *
 * @param {ObjectId|string} assessmentId
 * @param {{controlId?: string, scenarioId?: string}} scope — optional narrowing
 * @returns {Promise<number>} scenarios updated
 */
async function syncScenarioCtrlEff(assessmentId, scope = {}) {
  const scenarioFilter = {
    assessmentId,
    "controlIds.0": { $exists: true },
    ...(scope.controlId ? { controlIds: scope.controlId } : {}),
    ...(scope.scenarioId ? { _id: scope.scenarioId } : {}),
  };
  const [scenarios, controls] = await Promise.all([
    EwraRiskScenario.find(scenarioFilter).lean(),
    EwraControlAssessment.find({ assessmentId, effectivenessScore: { $ne: null } })
      .select("controlId effectivenessScore").lean(),
  ]);
  if (!scenarios.length) return 0;

  const effBy = new Map(controls.map((c) => [c.controlId, c.effectivenessScore]));
  const ops = [];
  for (const s of scenarios) {
    const scores = (s.controlIds || []).map((cid) => effBy.get(cid)).filter((v) => v != null);
    if (!scores.length) continue;
    const derived = Math.min(5, Math.max(1, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)));
    const residual = s.inherentRisk ? residualBand(s.inherentRisk, derived) : s.residualRisk;
    if (
      derived !== s.controlEffectiveness ||
      residual !== s.residualRisk ||
      s.ctrlEffSource !== "derived" ||
      s.linkedControlsAssessed !== scores.length
    ) {
      ops.push({
        updateOne: {
          filter: { _id: s._id },
          update: {
            $set: {
              controlEffectiveness: derived,
              residualRisk: residual,
              ctrlEffSource: "derived",
              linkedControlsAssessed: scores.length,
            },
          },
        },
      });
    }
  }
  if (ops.length) await EwraRiskScenario.bulkWrite(ops, { ordered: false });
  return ops.length;
}

/**
 * Ensure every control referenced by the register exists in the assessment's
 * Controls tab — the register defines the control SCOPE; the Controls tab is
 * where they get rated. Returns the number auto-added from the library.
 */
async function scopeReferencedControls(assessmentId, clientId, scenarios) {
  const referenced = [...new Set(scenarios.flatMap((s) => s.controlIds || []))];
  if (!referenced.length) return 0;

  const existing = await EwraControlAssessment.find({ assessmentId })
    .select("controlId").lean();
  const have = new Set(existing.map((c) => c.controlId));
  const missing = referenced.filter((cid) => !have.has(cid));
  if (!missing.length) return 0;

  const libraryControls = await Control.find({ controlId: { $in: missing } }).lean();
  if (!libraryControls.length) return 0;

  await EwraControlAssessment.bulkWrite(
    libraryControls.map((c) => ({
      updateOne: {
        filter: { assessmentId, controlId: c.controlId },
        update: {
          $setOnInsert: {
            assessmentId,
            controlId: c.controlId,
            controlTitle: c.title,
            domain: c.domain,
            controlOwner: c.owner || "",
            client: clientId,
            status: "Not Started",
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return libraryControls.length;
}

/** Recompute inherent/residual band codes from the matrix engine. */
function applyScenarioBands(doc) {
  if (doc.likelihood && doc.consequence) {
    doc.inherentRisk = inherentBand(doc.likelihood, doc.consequence);
  }
  if (doc.inherentRisk && doc.controlEffectiveness) {
    doc.residualRisk = residualBand(doc.inherentRisk, doc.controlEffectiveness);
  }
  return doc;
}

// @route GET /api/v1/ewra/:id/scenarios
exports.getScenarios = asyncHandler(async (req, res) => {
  const scenarios = await EwraRiskScenario.find({ assessmentId: req.params.id })
    .sort({ riskSection: 1, ref: 1 })
    .lean();
  res.status(200).json({ success: true, count: scenarios.length, data: scenarios });
});

// @route POST /api/v1/ewra/:id/scenarios
exports.addScenario = asyncHandler(async (req, res) => {
  const clientId = getClient(req);
  const last = await EwraRiskScenario.findOne({ assessmentId: req.params.id })
    .sort({ ref: -1 }).select("ref").lean();

  // derive category/riskType from the section definition when not supplied
  let { category, riskType } = req.body;
  if (req.body.riskSection && !category) {
    const assessment = await EwraAssessment.findById(req.params.id).select("registerSections").lean();
    const section = (assessment?.registerSections || []).find((s) => s.code === req.body.riskSection);
    category = section?.category || "";
    riskType = riskType || section?.label?.replace(/^SECTION \d+ — /i, "") || "";
  }

  const payload = applyScenarioBands({
    ...req.body,
    category,
    riskType,
    assessmentId: req.params.id,
    ref: req.body.ref || (last?.ref || 0) + 1,
    source: "manual",
    client: clientId,
  });
  const scenario = await EwraRiskScenario.create(payload);
  res.status(201).json({ success: true, data: scenario });
});

// ── Register sections (dynamic taxonomy) ──────────────────────────────────────

// @route POST /api/v1/ewra/:id/sections
exports.addSection = asyncHandler(async (req, res, next) => {
  const { label, category = "Customer", basis = "" } = req.body;
  if (!label?.trim()) return next(new ErrorResponse("Section label is required", 400));

  const assessment = await EwraAssessment.findById(req.params.id).select("registerSections").lean();
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  const sections = assessment.registerSections || [];
  const maxNum = sections.reduce((m, s) => Math.max(m, Number(String(s.code).replace(/^S/i, "")) || 0), 0);
  const newSection = {
    code: `S${maxNum + 1}`,
    label: label.trim().toUpperCase().startsWith("SECTION")
      ? label.trim()
      : `SECTION ${maxNum + 1} — ${label.trim().toUpperCase()}`,
    category,
    sortOrder: maxNum + 1,
    basis,
    source: "custom",
  };

  const updated = await EwraAssessment.findByIdAndUpdate(
    req.params.id,
    { $push: { registerSections: newSection } },
    { new: true },
  );
  res.status(201).json({ success: true, data: updated.registerSections });
});

// @route DELETE /api/v1/ewra/:id/sections/:code — custom + empty sections only
exports.deleteSection = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findById(req.params.id).select("registerSections").lean();
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  const section = (assessment.registerSections || []).find((s) => s.code === req.params.code);
  if (!section) return next(new ErrorResponse("Section not found", 404));
  if (section.source !== "custom") {
    return next(new ErrorResponse("Default sections cannot be removed", 400));
  }
  const inUse = await EwraRiskScenario.countDocuments({
    assessmentId: req.params.id,
    riskSection: req.params.code,
  });
  if (inUse > 0) {
    return next(new ErrorResponse(`Section has ${inUse} scenario(s) — move or delete them first`, 400));
  }

  const updated = await EwraAssessment.findByIdAndUpdate(
    req.params.id,
    { $pull: { registerSections: { code: req.params.code } } },
    { new: true },
  );
  res.status(200).json({ success: true, data: updated.registerSections });
});

// @route PUT /api/v1/ewra/:id/scenarios/:scenarioId
exports.updateScenario = asyncHandler(async (req, res, next) => {
  const existing = await EwraRiskScenario.findOne({
    _id: req.params.scenarioId,
    assessmentId: req.params.id,
  }).lean();
  if (!existing) return next(new ErrorResponse("Scenario not found", 404));

  const allowed = [
    "riskName","riskType","riskSection","category","factorRef","description",
    "pfSanctionsNote","applicableChannels","likelihood","consequence",
    "existingControls","controlEffectiveness","actionRequired","controlIds",
    "controlsOwner","withinRiskAppetite","proposedTreatment","reviewerNotes","status",
  ];
  const update = {};
  for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

  // recompute bands from the merged values
  const merged = applyScenarioBands({ ...existing, ...update });
  update.inherentRisk = merged.inherentRisk;
  update.residualRisk = merged.residualRisk;

  // amendment delta vs prior assessment (band severity ordering)
  if (existing.priorResidualRisk) {
    const order = { VL: 1, L: 2, M: 3, H: 4, E: 5 };
    const prev = order[existing.priorResidualRisk] || 0;
    const now = order[update.residualRisk] || 0;
    update.delta = now > prev ? "up" : now < prev ? "down" : "same";
  }

  let scenario = await EwraRiskScenario.findByIdAndUpdate(
    req.params.scenarioId, update, { new: true },
  );

  // re-derive control effectiveness when linked controls are assessed —
  // derived values always win over manual entry (the register is a report)
  const synced = await syncScenarioCtrlEff(req.params.id, { scenarioId: scenario._id });
  if (synced) scenario = await EwraRiskScenario.findById(scenario._id);

  res.status(200).json({ success: true, data: scenario });
});

// @route DELETE /api/v1/ewra/:id/scenarios/:scenarioId
exports.deleteScenario = asyncHandler(async (req, res, next) => {
  const deleted = await EwraRiskScenario.findOneAndDelete({
    _id: req.params.scenarioId,
    assessmentId: req.params.id,
  });
  if (!deleted) return next(new ErrorResponse("Scenario not found", 404));
  res.status(200).json({ success: true, data: {} });
});

// ── Control Assessments ────────────────────────────────────────────────────────

// @route GET /api/v1/ewra/:id/controls
exports.getControlAssessments = asyncHandler(async (req, res) => {
  const controls = await EwraControlAssessment.find({ assessmentId: req.params.id }).sort({ domain: 1, controlId: 1 });
  res.status(200).json({ success: true, count: controls.length, data: controls });
});

// @route POST /api/v1/ewra/:id/controls/add-from-library
exports.addControlsFromLibrary = asyncHandler(async (req, res) => {
  const { domain, controlIds } = req.body;
  const clientId = getClient(req);

  const filter = { active: true };
  if (domain) filter.domain = domain;
  if (controlIds?.length) filter.controlId = { $in: controlIds };

  const libraryControls = await Control.find(filter).lean();
  const ops = libraryControls.map((c) => ({
    updateOne: {
      filter: { assessmentId: req.params.id, controlId: c.controlId },
      update: {
        $setOnInsert: {
          assessmentId: req.params.id,
          controlId: c.controlId,
          controlTitle: c.title,
          domain: c.domain,
          controlOwner: c.owner || "",
          client: clientId,
          status: "Not Started",
        },
      },
      upsert: true,
    },
  }));

  const result = await EwraControlAssessment.bulkWrite(ops, { ordered: false });
  await EwraAssessment.findByIdAndUpdate(req.params.id, {
    controlsTotal: await EwraControlAssessment.countDocuments({ assessmentId: req.params.id }),
  });

  res.status(200).json({
    success: true,
    data: { upserted: result.upsertedCount, existing: ops.length - result.upsertedCount },
  });
});

// @route PUT /api/v1/ewra/:id/controls/:controlAssessId
exports.updateControlAssessment = asyncHandler(async (req, res, next) => {
  const allowed = ["designRating","performanceRating","evidenceNotes","gaps","actionRequired","status","controlOwner"];
  const update = {};
  allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

  const ca = await EwraControlAssessment.findById(req.params.controlAssessId);
  if (!ca) return next(new ErrorResponse("Control assessment not found", 404));

  const design = update.designRating      ?? ca.designRating      ?? null;
  const perf   = update.performanceRating ?? ca.performanceRating ?? null;
  if (design !== null && perf !== null) {
    const avg = (design + perf) / 2;
    update.effectivenessScore = +avg.toFixed(2);
    update.effectivenessLabel = effectivenessLabel(avg);
    update.status = "Complete";
  }

  const updated = await EwraControlAssessment.findByIdAndUpdate(req.params.controlAssessId, update, { new: true });

  // live-connect: a control rating change re-derives the register scenarios
  // that cite this control (the register is a report over controls)
  let scenariosSynced = 0;
  if (update.effectivenessScore !== undefined) {
    scenariosSynced = await syncScenarioCtrlEff(req.params.id, { controlId: updated.controlId });
  }

  res.status(200).json({ success: true, data: updated, scenariosSynced });
});

// ── Calculate ──────────────────────────────────────────────────────────────────

// @route POST /api/v1/ewra/:id/calculate
exports.calculate = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findById(req.params.id);
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  const [factors, controls, scenarios] = await Promise.all([
    EwraRiskFactor.find({ assessmentId: req.params.id, status: "Complete" }),
    EwraControlAssessment.find({ assessmentId: req.params.id, status: "Complete" }),
    EwraRiskScenario.find({ assessmentId: req.params.id }).lean(),
  ]);

  if (factors.length === 0) {
    return res.status(400).json({ success: false, message: "No completed risk factors to calculate from" });
  }

  // ── Per-category weighted scores ──────────────────────────────────────────
  const categories = ["Customer","Product","Channel","Geographic","Environmental"];
  const newCategoryScores = assessment.categoryScores.length
    ? assessment.categoryScores.toObject ? assessment.categoryScores.toObject() : JSON.parse(JSON.stringify(assessment.categoryScores))
    : categories.map((c) => ({ category: c, weight: 20, inherentScore: null, controlScore: null, residualScore: null, rating: "" }));

  for (const catObj of newCategoryScores) {
    const catFactors = factors.filter((f) => f.category === catObj.category);
    if (catFactors.length === 0) continue;

    const totalWeight = catFactors.reduce((s, f) => s + (f.weight || 1), 0);
    const inherent = catFactors.reduce((s, f) => s + (f.inherentScore || 3) * (f.weight || 1), 0) / totalWeight;
    const residual = catFactors.reduce((s, f) => s + (f.residualScore || f.inherentScore || 3) * (f.weight || 1), 0) / totalWeight;
    const ctrlEff  = catFactors.reduce((s, f) => s + (f.controlEffectiveness || 3) * (f.weight || 1), 0) / totalWeight;

    const priorCat = assessment.priorAssessmentId
      ? (await EwraAssessment.findById(assessment.priorAssessmentId).select("categoryScores").lean())
          ?.categoryScores?.find((c) => c.category === catObj.category)
      : null;

    catObj.inherentScore     = +inherent.toFixed(2);
    catObj.controlScore      = +ctrlEff.toFixed(2);
    catObj.residualScore     = +residual.toFixed(2);
    catObj.rating            = ratingFromScore(residual);
    catObj.priorResidualScore = priorCat?.residualScore ?? null;
    if (catObj.priorResidualScore !== null) {
      catObj.delta = residual > catObj.priorResidualScore ? "up"
                   : residual < catObj.priorResidualScore ? "down" : "same";
    }
  }

  // ── Overall scores ────────────────────────────────────────────────────────
  const catTotalWeight  = newCategoryScores.reduce((s, c) => s + (c.weight || 20), 0) || 100;
  const overallInherent = newCategoryScores.reduce((s, c) => s + (c.inherentScore || 3) * (c.weight || 20), 0) / catTotalWeight;
  const overallResidual = newCategoryScores.reduce((s, c) => s + (c.residualScore || 3) * (c.weight || 20), 0) / catTotalWeight;
  const overallRating   = ratingFromScore(overallResidual);

  let ctrlEffScore = null;
  if (controls.length > 0) {
    ctrlEffScore = +(controls.reduce((s, c) => s + (c.effectivenessScore || 3), 0) / controls.length).toFixed(2);
  }

  // ── Progress counts ───────────────────────────────────────────────────────
  const [factorsTotal, factorsComplete, controlsTotal, controlsComplete] = await Promise.all([
    EwraRiskFactor.countDocuments({ assessmentId: req.params.id }),
    EwraRiskFactor.countDocuments({ assessmentId: req.params.id, status: "Complete" }),
    EwraControlAssessment.countDocuments({ assessmentId: req.params.id }),
    EwraControlAssessment.countDocuments({ assessmentId: req.params.id, status: "Complete" }),
  ]);

  const updated = await EwraAssessment.findByIdAndUpdate(
    req.params.id,
    {
      categoryScores:            newCategoryScores,
      inherentRiskScore:         +overallInherent.toFixed(2),
      inherentRiskRating:        ratingFromScore(overallInherent),
      controlEffectivenessScore: ctrlEffScore,
      residualRiskScore:         +overallResidual.toFixed(2),
      residualRiskRating:        overallRating,
      factorsTotal, factorsComplete, controlsTotal, controlsComplete,
    },
    { new: true }
  );

  // ── Auto-create RAP items for High / Extreme residual factors ─────────────
  const clientId = getClient(req);
  const rapTemplates = await getRapTemplates();
  const highFactors = factors.filter((f) => ["High","Extreme"].includes(f.residualRating));

  for (const factor of highFactors) {
    const tmpl = rapTemplates.find((t) =>
      t.factor_id === factor.factorId ||
      t.risk_factor_name?.toLowerCase().includes(factor.factorName.toLowerCase().split(" ")[0].toLowerCase())
    );
    const isExtreme = factor.residualRating === "Extreme";
    const dueDays   = isExtreme ? 7 : 30;
    const dueDate   = new Date(Date.now() + dueDays * 86400000);

    // Check if an open issue already exists for this factor + assessment
    const existingIssue = await IssueRegister.findOne({
      linkedEwra: req.params.id,
      title: { $regex: factor.factorName, $options: "i" },
      status: { $in: ["Open","In Progress","Under Review"] },
    });
    if (existingIssue) continue;

    const issue = await IssueRegister.create({
      client: clientId,
      title: `EWRA ${factor.residualRating} Risk — ${factor.factorName}`,
      description: tmpl?.action_description || `Residual risk rated ${factor.residualRating}. Immediate remediation required per AUSTRAC guidance.`,
      domain: "RA",
      severity: isExtreme ? "Critical" : "High",
      source: "EWRA",
      linkedEwra: req.params.id,
      dueDate,
      createdBy: req.user?.id || null,
    });

    await RemediationTask.create({
      client: clientId,
      issue: issue._id,
      title: tmpl?.action_description || issue.title,
      description: tmpl?.success_criteria || "",
      priority: isExtreme ? "Critical" : "High",
      dueDate,
      createdBy: req.user?.id || null,
    });
  }

  // ── Connect register ↔ controls (the register is a REPORT) ────────────────
  // 1. every control named in the register is scoped into the Controls tab
  // 2. scenario control-effectiveness derives from the assessed controls
  const controlsAutoAdded = await scopeReferencedControls(req.params.id, clientId, scenarios);
  const scenariosSynced = await syncScenarioCtrlEff(req.params.id);
  const liveScenarios = (controlsAutoAdded || scenariosSynced)
    ? await EwraRiskScenario.find({ assessmentId: req.params.id }).lean()
    : scenarios;

  // ── Scenario → factor roll-up (supporting evidence, never overrides) ──────
  const SEV = { VL: 1, L: 2, M: 3, H: 4, E: 5 };
  const rollupByFactor = new Map();
  for (const s of liveScenarios) {
    if (!s.factorId) continue;
    const k = String(s.factorId);
    const r = rollupByFactor.get(k) || { count: 0, actionCount: 0, worstInherent: "", worstResidual: "", effSum: 0, effN: 0 };
    r.count++;
    if (s.actionRequired) r.actionCount++;
    if ((SEV[s.inherentRisk] || 0) > (SEV[r.worstInherent] || 0)) r.worstInherent = s.inherentRisk;
    if ((SEV[s.residualRisk] || 0) > (SEV[r.worstResidual] || 0)) r.worstResidual = s.residualRisk;
    if (s.controlEffectiveness) { r.effSum += s.controlEffectiveness; r.effN++; }
    rollupByFactor.set(k, r);
  }
  if (rollupByFactor.size) {
    await EwraRiskFactor.bulkWrite(
      [...rollupByFactor].map(([fid, r]) => ({
        updateOne: {
          filter: { _id: fid },
          update: {
            $set: {
              scenarioRollup: {
                count: r.count,
                actionCount: r.actionCount,
                worstInherent: r.worstInherent,
                worstResidual: r.worstResidual,
                avgCtrlEff: r.effN ? +(r.effSum / r.effN).toFixed(1) : null,
              },
            },
          },
        },
      })),
      { ordered: false },
    );
  }

  // ── Auto-create RAP items for action-required register scenarios ──────────
  // Priority per Risk_Matrix.md §6: E → Critical/7d · H → High/30d · M+ → Medium/90d
  let scenarioRapCount = 0;
  for (const s of liveScenarios.filter((x) => x.actionRequired)) {
    const sev = s.residualRisk === "E" ? "Critical" : s.residualRisk === "H" ? "High" : "Medium";
    const dueDays = s.residualRisk === "E" ? 7 : s.residualRisk === "H" ? 30 : 90;
    const issueTitle = `Risk Register Action — Ref ${s.ref}: ${s.riskName}`.substring(0, 200);

    const existingIssue = await IssueRegister.findOne({
      linkedEwra: req.params.id,
      title: issueTitle,
      status: { $in: ["Open", "In Progress", "Under Review"] },
    });
    if (existingIssue) continue;

    const issue = await IssueRegister.create({
      client: clientId,
      title: issueTitle,
      description: `${s.description || s.riskName}\n\nResidual risk: ${s.residualRisk || "—"} · Controls: ${(s.controlIds || []).join(", ") || "—"} · Owner: ${s.controlsOwner || "AML/CTF CO"}`,
      domain: "RA",
      severity: sev,
      source: "EWRA",
      linkedEwra: req.params.id,
      dueDate: new Date(Date.now() + dueDays * 86400000),
      createdBy: req.user?.id || null,
    });
    await RemediationTask.create({
      client: clientId,
      issue: issue._id,
      title: issueTitle,
      description: s.proposedTreatment || s.existingControls || "",
      priority: sev,
      dueDate: new Date(Date.now() + dueDays * 86400000),
      createdBy: req.user?.id || null,
    });
    scenarioRapCount++;
  }

  // ── Notify if High/Extreme residual ──────────────────────────────────────
  if (["High","Extreme"].includes(overallRating)) {
    await dispatchNotification("N_014", {
      client: clientId,
      linkedRecord: req.params.id,
      linkedRecordType: "EwraAssessment",
      body: `Overall residual risk rated ${overallRating} — ${highFactors.length} factor(s) require immediate action.`,
      urgency: "Urgent",
      repeating: true,
    });
  }

  res.status(200).json({
    success: true,
    data: updated,
    rapItemsCreated: highFactors.length,
    scenarioRapItemsCreated: scenarioRapCount,
    controlsAutoAdded,
    scenariosSynced,
  });
});

// ── Workflow ───────────────────────────────────────────────────────────────────

// @route POST /api/v1/ewra/:id/submit
exports.submitForReview = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findByIdAndUpdate(
    req.params.id,
    { status: "In Review", submittedBy: req.user?.id, submittedAt: new Date() },
    { new: true }
  );
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));
  res.status(200).json({ success: true, data: assessment });
});

// @route POST /api/v1/ewra/:id/approve
exports.approve = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findById(req.params.id)
    .populate({ path: "entityProfile", populate: { path: "entityType", select: "name" } });
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  // Resolve review cycle from entity type
  const entityTypeName = assessment.entityProfile?.entityType?.name || null;
  const reviewYears = await getReviewCycleYears(entityTypeName);
  const reviewDate = new Date();
  reviewDate.setFullYear(reviewDate.getFullYear() + reviewYears);

  const updated = await EwraAssessment.findByIdAndUpdate(
    req.params.id,
    {
      status: "Approved",
      approvedBy: req.user?.id,
      approvedAt: new Date(),
      reviewNotes: req.body?.reviewNotes || "",
      reviewDate,
      reviewCycleYears: reviewYears,
      amendmentPending: false,
    },
    { new: true }
  );

  // If this is an amendment, archive the prior assessment
  if (assessment.priorAssessmentId) {
    await EwraAssessment.findByIdAndUpdate(assessment.priorAssessmentId, {
      status: "Archived",
      amendmentPending: false,
    });
  }

  res.status(200).json({ success: true, data: updated });
});

// @route GET /api/v1/ewra/:id/results
exports.getResults = asyncHandler(async (req, res, next) => {
  const [assessment, factors, controls] = await Promise.all([
    EwraAssessment.findById(req.params.id)
      .populate("entityProfile","entityName entityType")
      .populate("priorAssessmentId","assessmentName residualRiskRating approvedAt")
      .lean(),
    EwraRiskFactor.find({ assessmentId: req.params.id }).sort({ category: 1, sortOrder: 1 }).lean(),
    EwraControlAssessment.find({ assessmentId: req.params.id }).sort({ domain: 1, controlId: 1 }).lean(),
  ]);
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  // Attach open RAP items
  const rapItems = await IssueRegister.find({
    linkedEwra: req.params.id,
    status: { $in: ["Open","In Progress","Under Review"] },
  }).select("issueId title severity status dueDate").lean();

  res.status(200).json({ success: true, data: { assessment, factors, controls, rapItems } });
});
