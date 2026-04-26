const asyncHandler = require("../middleware/async");
const EntityObligation = require("../models/EntityObligation");
const ObligationLibrary = require("../models/ObligationLibrary");
const ErrorResponse = require("../utils/errorResponse");

const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// @desc   List obligations for an entity profile
// @route  GET /api/v1/entity-obligation/:entityProfileId
// @access Protected
exports.getEntityObligations = asyncHandler(async (req, res) => {
  const { entityProfileId } = req.params;
  const { status, category, obligationCategory, testResult, riskRating, page = 1, limit = 50 } = req.query;

  const filter = { entityProfileId };
  if (status) filter.status = status;
  const cat = obligationCategory || category;
  if (cat) filter.obligationCategory = cat;
  if (testResult) filter.testResult = testResult;
  if (riskRating) filter.riskRating = riskRating;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [data, total] = await Promise.all([
    EntityObligation.find(filter)
      .sort({ obligationId: 1 })
      .skip(skip)
      .limit(parseInt(limit)),
    EntityObligation.countDocuments(filter),
  ]);

  // Enrich with library data for display
  const enriched = await Promise.all(
    data.map(async (eo) => {
      const lib = await ObligationLibrary.findOne(
        { obligationId: eo.obligationId },
        "regulatorySource applicableEntityTypes controlRefs policyTemplate riskCategory"
      ).lean();
      return { ...eo.toObject(), library: lib };
    })
  );

  res.status(200).json({
    success: true,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
    },
    data: enriched,
  });
});

// @desc   Get a single entity obligation
// @route  GET /api/v1/entity-obligation/item/:id
// @access Protected
exports.getEntityObligation = asyncHandler(async (req, res, next) => {
  const eo = await EntityObligation.findById(req.params.id);
  if (!eo) return next(new ErrorResponse("Entity obligation not found", 404));

  const lib = await ObligationLibrary.findOne({ obligationId: eo.obligationId }).lean();
  res.status(200).json({ success: true, data: { ...eo.toObject(), library: lib } });
});

// @desc   Update entity obligation (status, owner, test result, etc.)
// @route  PUT /api/v1/entity-obligation/item/:id
// @access Protected
exports.updateEntityObligation = asyncHandler(async (req, res, next) => {
  const allowed = [
    "status", "controlOwner", "oversightOwner", "monitoringFrequency",
    "lastTestedDate", "nextReviewDate", "testResult", "remediationStatus",
    "riskRating", "notes",
  ];
  const update = {};
  allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

  const eo = await EntityObligation.findByIdAndUpdate(req.params.id, update, {
    new: true,
    runValidators: true,
  });
  if (!eo) return next(new ErrorResponse("Entity obligation not found", 404));
  res.status(200).json({ success: true, data: eo });
});

// @desc   Bulk update obligations for an entity (e.g. set all owners at once)
// @route  PUT /api/v1/entity-obligation/bulk/:entityProfileId
// @access Protected
exports.bulkUpdateEntityObligations = asyncHandler(async (req, res) => {
  const { entityProfileId } = req.params;
  const { updates } = req.body;
  // updates = [{ obligationId, controlOwner, status, ... }, ...]

  if (!Array.isArray(updates)) {
    return res.status(400).json({ success: false, message: "updates array required" });
  }

  const results = await Promise.all(
    updates.map((u) =>
      EntityObligation.findOneAndUpdate(
        { entityProfileId, obligationId: u.obligationId },
        u,
        { new: true }
      )
    )
  );

  res.status(200).json({ success: true, count: results.length, data: results });
});

// @desc   Get distinct filter option values for an entity's obligations
// @route  GET /api/v1/entity-obligation/filter-options/:entityProfileId
// @access Protected
exports.getObligationFilterOptions = asyncHandler(async (req, res) => {
  const { entityProfileId } = req.params;
  const base = { entityProfileId };

  const [categories, statuses, testResults, riskRatings] = await Promise.all([
    EntityObligation.distinct("obligationCategory", base),
    EntityObligation.distinct("status", base),
    EntityObligation.distinct("testResult", base),
    EntityObligation.distinct("riskRating", base),
  ]);

  const clean = (arr) => arr.filter(Boolean).sort();

  res.status(200).json({
    success: true,
    data: {
      categories:  clean(categories),
      statuses:    clean(statuses),
      testResults: clean(testResults),
      riskRatings: clean(riskRatings),
    },
  });
});

// @desc   Get compliance summary stats for an entity
// @route  GET /api/v1/entity-obligation/summary/:entityProfileId
// @access Protected
exports.getObligationSummary = asyncHandler(async (req, res) => {
  const { entityProfileId } = req.params;

  const [total, compliant, partial, nonCompliant, notTested, overdue] = await Promise.all([
    EntityObligation.countDocuments({ entityProfileId }),
    EntityObligation.countDocuments({ entityProfileId, testResult: "Pass" }),
    EntityObligation.countDocuments({ entityProfileId, testResult: "Partial" }),
    EntityObligation.countDocuments({ entityProfileId, testResult: "Fail" }),
    EntityObligation.countDocuments({ entityProfileId, testResult: { $in: ["Not Tested", ""] } }),
    EntityObligation.countDocuments({
      entityProfileId,
      nextReviewDate: { $lt: new Date() },
      status: "Active",
    }),
  ]);

  const complianceHealth = total > 0 ? Math.round((compliant / total) * 100) : 0;

  res.status(200).json({
    success: true,
    data: { total, compliant, partial, nonCompliant, notTested, overdue, complianceHealth },
  });
});
