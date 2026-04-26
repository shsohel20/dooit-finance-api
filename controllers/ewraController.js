const asyncHandler = require("../middleware/async");
const EwraAssessment = require("../models/EwraAssessment");
const EwraRiskFactor = require("../models/EwraRiskFactor");
const EwraControlAssessment = require("../models/EwraControlAssessment");
const Control = require("../models/Control");
const ErrorResponse = require("../utils/errorResponse");

const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// ── Risk matrix helper ─────────────────────────────────────────────────────────
const RISK_MATRIX = [
  ["Low","Low","Low","Medium","Medium"],
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
  // Normalise product to 1-5 scale
  return Math.round(((likelihood * impact) / 25) * 4 + 1);
}

function ratingFromScore(score) {
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

// ── Assessment CRUD ────────────────────────────────────────────────────────────

// @route GET /api/v1/ewra
exports.listAssessments = asyncHandler(async (req, res) => {
  const { status, entityProfile, page = 1, limit = 20 } = req.query;
  const filter = { client: getClient(req) };
  if (status) filter.status = status;
  if (entityProfile) filter.entityProfile = entityProfile;

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
    assessmentName, entityProfile, assessmentType, riskTypes,
    periodStart, periodEnd, version,
  } = req.body;

  // Initialise 5 category scores with equal weight
  const categoryScores = ["Customer","Product","Channel","Geographic","Environmental"].map((c) => ({
    category: c, weight: 20,
    inherentScore: null, controlScore: null, residualScore: null, rating: "",
  }));

  const assessment = await EwraAssessment.create({
    assessmentName, entityProfile, assessmentType, riskTypes,
    periodStart, periodEnd, version,
    categoryScores,
    client: clientId,
    createdBy: req.user?.id || null,
  });

  // Seed default risk factors for each category
  const defaultFactors = [
    // Customer
    { category:"Customer", factorName:"Customer Base Profile", description:"Overall risk profile of the customer base including demographics and behaviour patterns", weight:25, sortOrder:1 },
    { category:"Customer", factorName:"Higher-Risk Customers", description:"Exposure to PEPs, high-risk industries, cash-intensive businesses and non-residents", weight:35, sortOrder:2 },
    { category:"Customer", factorName:"Geographic Concentration", description:"Concentration of customers in high-risk or sanctioned jurisdictions", weight:25, sortOrder:3 },
    { category:"Customer", factorName:"Customer Change Impact", description:"Impact of new customer segments, onboarding channel changes or portfolio acquisitions", weight:15, sortOrder:4 },
    // Product
    { category:"Product", factorName:"Product Complexity", description:"Complexity and opacity of products including bearer instruments, structured products and derivatives", weight:25, sortOrder:1 },
    { category:"Product", factorName:"Anonymity Level", description:"Degree to which products allow anonymous or pseudonymous transactions", weight:30, sortOrder:2 },
    { category:"Product", factorName:"Transaction Velocity", description:"Maximum velocity and value of transactions enabled by products and services", weight:25, sortOrder:3 },
    { category:"Product", factorName:"New Product/Service Risk", description:"ML/TF risk introduced by new or materially changed products and services", weight:20, sortOrder:4 },
    // Channel
    { category:"Channel", factorName:"Non-Face-to-Face Channels", description:"Volume of business conducted through digital, remote or automated channels", weight:30, sortOrder:1 },
    { category:"Channel", factorName:"Third-Party / Intermediary Risk", description:"Reliance on agents, introducers and third-party channels for customer acquisition", weight:30, sortOrder:2 },
    { category:"Channel", factorName:"Cash Handling", description:"Extent of cash acceptance and handling across channels", weight:25, sortOrder:3 },
    { category:"Channel", factorName:"Automation Level", description:"Degree of automated processing reducing human oversight of transactions", weight:15, sortOrder:4 },
    // Geographic
    { category:"Geographic", factorName:"Operating Jurisdictions", description:"Risk profile of jurisdictions in which the entity operates or is licensed", weight:30, sortOrder:1 },
    { category:"Geographic", factorName:"Customer Geographic Distribution", description:"Concentration of customers in high-risk or FATF grey/black-listed countries", weight:30, sortOrder:2 },
    { category:"Geographic", factorName:"Transaction Corridors", description:"Risk profile of cross-border transaction corridors used by customers", weight:25, sortOrder:3 },
    { category:"Geographic", factorName:"Counterparty Location Risk", description:"Risk from counterparties, correspondent banks or payment networks in high-risk jurisdictions", weight:15, sortOrder:4 },
    // Environmental
    { category:"Environmental", factorName:"Predicate Offences Environment", description:"Prevalence of predicate offences (drug trafficking, fraud, corruption) in operating markets", weight:20, sortOrder:1 },
    { category:"Environmental", factorName:"Terrorist Financing Threat", description:"Threat level of terrorist financing in jurisdictions where the entity operates", weight:20, sortOrder:2 },
    { category:"Environmental", factorName:"Regulatory Landscape", description:"Stringency and maturity of AML/CTF regulatory environment including AUSTRAC oversight intensity", weight:20, sortOrder:3 },
    { category:"Environmental", factorName:"Governance & Compliance Culture", description:"Strength of internal governance, AML culture and Board/senior management commitment", weight:20, sortOrder:4 },
    { category:"Environmental", factorName:"Business Strategy Risk", description:"ML/TF risk from planned business expansions, M&A activity or new market entry", weight:20, sortOrder:5 },
  ];

  const factors = defaultFactors.map((f) => ({
    ...f,
    assessmentId: assessment._id,
    client: clientId,
  }));

  await EwraRiskFactor.insertMany(factors);

  await EwraAssessment.findByIdAndUpdate(assessment._id, {
    factorsTotal: factors.length,
  });

  res.status(201).json({ success: true, data: assessment });
});

// @route GET /api/v1/ewra/:id
exports.getAssessment = asyncHandler(async (req, res, next) => {
  const assessment = await EwraAssessment.findById(req.params.id)
    .populate("entityProfile", "entityName entityType abn licenses status")
    .lean();
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));
  res.status(200).json({ success: true, data: assessment });
});

// @route PUT /api/v1/ewra/:id
exports.updateAssessment = asyncHandler(async (req, res, next) => {
  const allowed = ["assessmentName","assessmentType","riskTypes","periodStart","periodEnd","version","reviewNotes","categoryScores"];
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

  // Auto-compute scores if likelihood + impact given
  if (update.likelihood !== undefined && update.impact !== undefined) {
    update.inherentScore = matrixScore(update.likelihood, update.impact);
    update.inherentRating = matrixRating(update.likelihood, update.impact);
  }
  // Auto-compute residual if control effectiveness given
  const factor = await EwraRiskFactor.findById(req.params.factorId);
  if (!factor) return next(new ErrorResponse("Factor not found", 404));

  const inherentScore = update.inherentScore ?? factor.inherentScore ?? 3;
  const effectiveness = update.controlEffectiveness ?? factor.controlEffectiveness ?? 3;
  if (effectiveness !== null && inherentScore !== null) {
    update.residualScore = +(inherentScore * (1 - effectiveness / 5)).toFixed(2);
    update.residualRating = ratingFromScore(update.residualScore);
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

  // Compute effectiveness
  const ca = await EwraControlAssessment.findById(req.params.controlAssessId);
  if (!ca) return next(new ErrorResponse("Control assessment not found", 404));

  const design = update.designRating ?? ca.designRating ?? null;
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

  // ── Per-category weighted inherent score ──────────────────────────────────
  const categories = ["Customer","Product","Channel","Geographic","Environmental"];
  const newCategoryScores = assessment.categoryScores.length
    ? assessment.categoryScores
    : categories.map((c) => ({ category: c, weight: 20, inherentScore: null, controlScore: null, residualScore: null, rating: "" }));

  for (const catObj of newCategoryScores) {
    const catFactors = factors.filter((f) => f.category === catObj.category);
    if (catFactors.length === 0) continue;

    const totalWeight = catFactors.reduce((s, f) => s + (f.weight || 1), 0);
    const inherent = catFactors.reduce((s, f) => s + (f.inherentScore || 3) * (f.weight || 1), 0) / totalWeight;
    const residual = catFactors.reduce((s, f) => s + (f.residualScore || f.inherentScore || 3) * (f.weight || 1), 0) / totalWeight;
    const ctrlEff  = catFactors.reduce((s, f) => s + (f.controlEffectiveness || 3) * (f.weight || 1), 0) / totalWeight;

    catObj.inherentScore = +inherent.toFixed(2);
    catObj.controlScore  = +ctrlEff.toFixed(2);
    catObj.residualScore = +residual.toFixed(2);
    catObj.rating        = ratingFromScore(residual);
  }

  // ── Overall scores weighted by category weights ───────────────────────────
  const catTotalWeight = newCategoryScores.reduce((s, c) => s + (c.weight || 20), 0) || 100;
  const overallInherent = newCategoryScores.reduce((s, c) => s + (c.inherentScore || 3) * (c.weight || 20), 0) / catTotalWeight;
  const overallResidual = newCategoryScores.reduce((s, c) => s + (c.residualScore || 3) * (c.weight || 20), 0) / catTotalWeight;

  // Control effectiveness from control assessments
  let ctrlEffScore = null;
  if (controls.length > 0) {
    ctrlEffScore = +(controls.reduce((s, c) => s + (c.effectivenessScore || 3), 0) / controls.length).toFixed(2);
  }

  // Progress counts
  const [factorsTotal, factorsComplete, controlsTotal, controlsComplete] = await Promise.all([
    EwraRiskFactor.countDocuments({ assessmentId: req.params.id }),
    EwraRiskFactor.countDocuments({ assessmentId: req.params.id, status: "Complete" }),
    EwraControlAssessment.countDocuments({ assessmentId: req.params.id }),
    EwraControlAssessment.countDocuments({ assessmentId: req.params.id, status: "Complete" }),
  ]);

  const updated = await EwraAssessment.findByIdAndUpdate(
    req.params.id,
    {
      categoryScores: newCategoryScores,
      inherentRiskScore:  +overallInherent.toFixed(2),
      inherentRiskRating: ratingFromScore(overallInherent),
      controlEffectivenessScore: ctrlEffScore,
      residualRiskScore:  +overallResidual.toFixed(2),
      residualRiskRating: ratingFromScore(overallResidual),
      factorsTotal, factorsComplete, controlsTotal, controlsComplete,
    },
    { new: true }
  );

  res.status(200).json({ success: true, data: updated });
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
  const assessment = await EwraAssessment.findByIdAndUpdate(
    req.params.id,
    {
      status: "Approved",
      approvedBy: req.user?.id,
      approvedAt: new Date(),
      reviewNotes: (req.body || {}).reviewNotes || "",
    },
    { new: true }
  );
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));
  res.status(200).json({ success: true, data: assessment });
});

// @route GET /api/v1/ewra/:id/results
exports.getResults = asyncHandler(async (req, res, next) => {
  const [assessment, factors, controls] = await Promise.all([
    EwraAssessment.findById(req.params.id).populate("entityProfile","entityName entityType").lean(),
    EwraRiskFactor.find({ assessmentId: req.params.id }).sort({ category: 1, sortOrder: 1 }).lean(),
    EwraControlAssessment.find({ assessmentId: req.params.id }).sort({ domain: 1, controlId: 1 }).lean(),
  ]);
  if (!assessment) return next(new ErrorResponse("Assessment not found", 404));

  res.status(200).json({ success: true, data: { assessment, factors, controls } });
});
