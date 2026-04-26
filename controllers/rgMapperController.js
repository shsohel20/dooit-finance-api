const asyncHandler = require("../middleware/async");
const RegulatoryGuide = require("../models/RegulatoryGuide");
const ObligationLibrary = require("../models/ObligationLibrary");
const EntityObligation = require("../models/EntityObligation");
const EntityProfile = require("../models/EntityProfile");
const ErrorResponse = require("../utils/errorResponse");

const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// ─── List guides ──────────────────────────────────────────────────────────────
// GET /api/v1/rg-mapper
exports.getGuides = asyncHandler(async (req, res) => {
  const { regulator, status, search, page = 1, limit = 20 } = req.query;
  const client = getClient(req);

  const filter = {};
  if (client) filter.$or = [{ client }, { client: { $exists: false } }, { client: null }];
  if (regulator) filter.regulator = regulator;
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: "i" } },
      { guideCode: { $regex: search, $options: "i" } },
      { guideId: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [data, total] = await Promise.all([
    RegulatoryGuide.find(filter)
      .sort({ guideId: 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    RegulatoryGuide.countDocuments(filter),
  ]);

  // Attach obligation count to each guide
  const enriched = data.map((g) => ({
    ...g,
    obligationCount: (g.obligationIds || []).length,
  }));

  res.status(200).json({
    success: true,
    totalRecords: total,
    pagination: { page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    data: enriched,
  });
});

// ─── Get single guide (with full obligation details) ──────────────────────────
// GET /api/v1/rg-mapper/:id
exports.getGuide = asyncHandler(async (req, res, next) => {
  const guide = await RegulatoryGuide.findById(req.params.id).lean();
  if (!guide) return next(new ErrorResponse("Regulatory guide not found", 404));

  // Fetch full obligation library entries for each obligationId in the guide
  const obligations = await ObligationLibrary.find(
    { obligationId: { $in: guide.obligationIds || [] }, active: true },
    "obligationId category description regulatorySource riskCategory controlRefs defaultWeight"
  )
    .sort({ obligationId: 1 })
    .lean();

  res.status(200).json({
    success: true,
    data: { ...guide, obligations },
  });
});

// ─── Create guide ─────────────────────────────────────────────────────────────
// POST /api/v1/rg-mapper
exports.createGuide = asyncHandler(async (req, res) => {
  const client = getClient(req);
  const guide = await RegulatoryGuide.create({
    ...req.body,
    client: client || undefined,
    createdBy: req.user._id,
  });
  res.status(201).json({ success: true, data: guide });
});

// ─── Update guide ─────────────────────────────────────────────────────────────
// PUT /api/v1/rg-mapper/:id
exports.updateGuide = asyncHandler(async (req, res, next) => {
  const guide = await RegulatoryGuide.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!guide) return next(new ErrorResponse("Regulatory guide not found", 404));
  res.status(200).json({ success: true, data: guide });
});

// ─── Delete guide ─────────────────────────────────────────────────────────────
// DELETE /api/v1/rg-mapper/:id
exports.deleteGuide = asyncHandler(async (req, res, next) => {
  const guide = await RegulatoryGuide.findByIdAndDelete(req.params.id);
  if (!guide) return next(new ErrorResponse("Regulatory guide not found", 404));
  res.status(200).json({ success: true, data: {} });
});

// ─── Gap analysis ─────────────────────────────────────────────────────────────
// GET /api/v1/rg-mapper/:id/gap-analysis?entityProfileId=xxx
// Returns which obligations in the guide are already mapped vs missing for this entity
exports.getGapAnalysis = asyncHandler(async (req, res, next) => {
  const { entityProfileId } = req.query;
  if (!entityProfileId) return next(new ErrorResponse("entityProfileId query param required", 400));

  const guide = await RegulatoryGuide.findById(req.params.id).lean();
  if (!guide) return next(new ErrorResponse("Regulatory guide not found", 404));

  // Fetch entity profile for display
  const entity = await EntityProfile.findById(entityProfileId, "entityName entityType").lean();

  // Fetch all obligations in the guide from the library
  const obligations = await ObligationLibrary.find(
    { obligationId: { $in: guide.obligationIds || [] }, active: true },
    "obligationId category description regulatorySource riskCategory controlRefs"
  )
    .sort({ obligationId: 1 })
    .lean();

  // Fetch existing entity obligations for this entity
  const existing = await EntityObligation.find(
    { entityProfileId, obligationId: { $in: guide.obligationIds || [] } },
    "obligationId status testResult riskRating controlOwner nextReviewDate"
  ).lean();

  const existingMap = new Map(existing.map((eo) => [eo.obligationId, eo]));

  // Classify each obligation
  const mapped = [];
  const unmapped = [];

  for (const ob of obligations) {
    const eo = existingMap.get(ob.obligationId);
    if (eo) {
      mapped.push({ ...ob, entityObligation: eo });
    } else {
      unmapped.push(ob);
    }
  }

  res.status(200).json({
    success: true,
    data: {
      guide: { _id: guide._id, guideId: guide.guideId, title: guide.title, regulator: guide.regulator },
      entity: entity || { _id: entityProfileId, entityName: "Unknown Entity" },
      summary: {
        total: obligations.length,
        mapped: mapped.length,
        unmapped: unmapped.length,
        coveragePct: obligations.length > 0 ? Math.round((mapped.length / obligations.length) * 100) : 0,
      },
      mapped,
      unmapped,
    },
  });
});

// ─── Map obligations to entity ────────────────────────────────────────────────
// POST /api/v1/rg-mapper/:id/map
// Body: { entityProfileId, obligationIds (optional, default = all unmapped), controlOwner, monitoringFrequency }
exports.mapToEntity = asyncHandler(async (req, res, next) => {
  const { entityProfileId, obligationIds, controlOwner, monitoringFrequency } = req.body;
  if (!entityProfileId) return next(new ErrorResponse("entityProfileId is required", 400));

  const client = getClient(req);
  if (!client) return next(new ErrorResponse("Client context required", 400));

  const guide = await RegulatoryGuide.findById(req.params.id).lean();
  if (!guide) return next(new ErrorResponse("Regulatory guide not found", 404));

  // Determine which obligationIds to map
  const targetIds = Array.isArray(obligationIds) && obligationIds.length > 0
    ? obligationIds
    : guide.obligationIds || [];

  if (!targetIds.length) {
    return res.status(200).json({ success: true, message: "No obligations to map", data: { created: 0, skipped: 0 } });
  }

  // Fetch obligation library data for snapshot
  const libObligations = await ObligationLibrary.find(
    { obligationId: { $in: targetIds }, active: true },
    "obligationId category description"
  ).lean();

  const libMap = new Map(libObligations.map((o) => [o.obligationId, o]));

  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const obId of targetIds) {
    const lib = libMap.get(obId);
    if (!lib) { skipped++; continue; }

    try {
      await EntityObligation.findOneAndUpdate(
        { entityProfileId, obligationId: obId },
        {
          $setOnInsert: {
            entityProfileId,
            obligationId: obId,
            obligationCategory: lib.category,
            obligationDescription: lib.description,
            status: "Active",
            testResult: "Not Tested",
            client,
            assignedBy: req.user._id,
            ...(controlOwner && { controlOwner }),
            ...(monitoringFrequency && { monitoringFrequency }),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      created++;
    } catch (err) {
      if (err.code === 11000) {
        skipped++; // already exists
      } else {
        errors.push({ obligationId: obId, error: err.message });
      }
    }
  }

  res.status(200).json({
    success: true,
    message: `${created} obligations mapped, ${skipped} already existed`,
    data: { created, skipped, errors },
  });
});

// ─── Remove obligation from entity ───────────────────────────────────────────
// DELETE /api/v1/rg-mapper/:id/unmap
// Body: { entityProfileId, obligationId }
exports.unmapFromEntity = asyncHandler(async (req, res, next) => {
  const { entityProfileId, obligationId } = req.body;
  if (!entityProfileId || !obligationId) {
    return next(new ErrorResponse("entityProfileId and obligationId are required", 400));
  }

  const result = await EntityObligation.findOneAndDelete({ entityProfileId, obligationId });
  if (!result) return next(new ErrorResponse("Entity obligation not found", 404));

  res.status(200).json({ success: true, data: {} });
});

// ─── Add/remove obligations from a guide ─────────────────────────────────────
// PUT /api/v1/rg-mapper/:id/obligations
// Body: { add: ["AML-001"], remove: ["CDD-002"] }
exports.updateGuideObligations = asyncHandler(async (req, res, next) => {
  const { add = [], remove = [] } = req.body;

  const guide = await RegulatoryGuide.findById(req.params.id);
  if (!guide) return next(new ErrorResponse("Regulatory guide not found", 404));

  if (add.length) {
    guide.obligationIds = [...new Set([...guide.obligationIds, ...add.map((id) => id.toUpperCase())])];
  }
  if (remove.length) {
    const removeSet = new Set(remove.map((id) => id.toUpperCase()));
    guide.obligationIds = guide.obligationIds.filter((id) => !removeSet.has(id));
  }

  await guide.save();

  res.status(200).json({ success: true, data: guide });
});

// ─── Summary stats across all guides ─────────────────────────────────────────
// GET /api/v1/rg-mapper/stats
exports.getStats = asyncHandler(async (req, res) => {
  const client = getClient(req);
  const filter = {};
  if (client) filter.$or = [{ client }, { client: { $exists: false } }, { client: null }];

  const [total, active, draft, superseded, guides] = await Promise.all([
    RegulatoryGuide.countDocuments(filter),
    RegulatoryGuide.countDocuments({ ...filter, status: "Active" }),
    RegulatoryGuide.countDocuments({ ...filter, status: "Draft" }),
    RegulatoryGuide.countDocuments({ ...filter, status: "Superseded" }),
    RegulatoryGuide.find(filter, "regulator obligationIds").lean(),
  ]);

  // Obligations covered across all active guides
  const allObligationIds = new Set();
  guides.forEach((g) => (g.obligationIds || []).forEach((id) => allObligationIds.add(id)));

  // By regulator
  const byRegulator = guides.reduce((acc, g) => {
    acc[g.regulator] = (acc[g.regulator] || 0) + 1;
    return acc;
  }, {});

  res.status(200).json({
    success: true,
    data: {
      total,
      active,
      draft,
      superseded,
      totalObligationsCovered: allObligationIds.size,
      byRegulator,
    },
  });
});
