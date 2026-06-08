const mongoose = require("mongoose");
const asyncHandler = require("../middleware/async");
const EwraAssessment = require("../models/EwraAssessment");
const EwraRiskFactor = require("../models/EwraRiskFactor");
const EwraControlAssessment = require("../models/EwraControlAssessment");
const Control = require("../models/Control");
const IssueRegister = require("../models/IssueRegister");
const RemediationTask = require("../models/RemediationTask");
const ErrorResponse = require("../utils/errorResponse");

const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// ── Risk matrix (5×5 lookup) ───────────────────────────────────────────────────
// Rows = likelihood 1-5, Cols = consequence/impact 1-5
const RISK_MATRIX = [
  ["Very Low","Low","Low","Medium","Medium"],
  ["Low","Low","Medium","Medium","High"],
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
    const seedFactors = await mongoose.connection
      .collection("ewra_factors").find({}).toArray();
    return factors.map((f) => {
      const seed = seedFactors.find((s) => s.factor_id === f.factorId);
      const defaultScore = seed?.[entityTypeName] ?? null;
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
  await EwraRiskFactor.insertMany(factors);
  await EwraAssessment.findByIdAndUpdate(assessment._id, { factorsTotal: factors.length });

  // N_002 — EWRA Draft Ready
  await dispatchNotification("N_002", { client: clientId, entityProfile, linkedRecord: assessment._id, linkedRecordType: "EwraAssessment" });

  res.status(201).json({ success: true, data: assessment });
});

// @route GET /api/v1/ewra/:id
exports.getAssessment = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findById(req.params.id)
    .populate("entityProfile", "entityName entityType abn licenses status")
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

  const inherentScore = update.inherentScore ?? factor.inherentScore ?? 3;
  if (effectiveness !== null && inherentScore !== null) {
    update.residualScore  = +(inherentScore * (1 - effectiveness / 5)).toFixed(2);
    update.residualRating = ratingFromScore(update.residualScore);
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
  const allowed = ["designRating","performanceRating","evidenceNotes","gaps","actionRequired","status"];
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
  res.status(200).json({ success: true, data: updated });
});

// ── Calculate ──────────────────────────────────────────────────────────────────

// @route POST /api/v1/ewra/:id/calculate
exports.calculate = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findById(req.params.id);
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  const [factors, controls] = await Promise.all([
    EwraRiskFactor.find({ assessmentId: req.params.id, status: "Complete" }),
    EwraControlAssessment.find({ assessmentId: req.params.id, status: "Complete" }),
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

  res.status(200).json({ success: true, data: updated, rapItemsCreated: highFactors.length });
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
