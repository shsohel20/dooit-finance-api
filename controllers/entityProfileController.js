const asyncHandler = require("../middleware/async");
const EntityProfile = require("../models/EntityProfile");
const EntityObligation = require("../models/EntityObligation");
const ObligationLibrary = require("../models/ObligationLibrary");
const EntityType = require("../models/EntityType");
const LicenseType = require("../models/LicenseType");
const DesignatedService = require("../models/DesignatedService");
const CountryRisk = require("../models/CountryRisk");
const ErrorResponse = require("../utils/errorResponse");

// ─── helper: resolve client from request ─────────────────────────────────────
const getClient = (req) => req.user?.client?._id || req.user?.clientBelongs || null;

// @desc   List entity profiles for client
// @route  GET /api/v1/entity-profile
// @access Protected
exports.getEntityProfiles = asyncHandler(async (req, res) => {
  const client = getClient(req);
  const {
    status, category, entityType: entityTypeId,
    license, service, jurisdiction,
    search, page: qPage, limit: qLimit,
  } = req.query;

  const filter = { client };
  if (status)        filter.status = status;
  if (search)        filter.entityName = { $regex: search, $options: "i" };
  if (license)       filter.licenses = { $in: [license] };
  if (service)       filter.designatedServices = { $in: [service] };
  if (jurisdiction)  filter.jurisdictions = { $in: [jurisdiction] };

  // Filter by specific entityType ID
  if (entityTypeId) {
    filter.entityType = entityTypeId;
  } else if (category) {
    // Filter by category: resolve to a set of entityType IDs first
    const types = await EntityType.find({ category }, "_id").lean();
    filter.entityType = { $in: types.map((t) => t._id) };
  }

  const page  = parseInt(qPage)  || 1;
  const limit = parseInt(qLimit) || 25;

  const result = await EntityProfile.paginate(filter, {
    page,
    limit,
    populate: "entityType",
    sort: { createdAt: -1 },
  });

  res.status(200).json({
    success: true,
    totalRecords: result.totalDocs,
    pagination: { page: result.page, totalPages: result.totalPages, total: result.totalDocs },
    data: result.docs,
  });
});

// @desc   Distinct filter options for entity profile list
// @route  GET /api/v1/entity-profile/filter-options
// @access Protected
exports.getEntityProfileFilterOptions = asyncHandler(async (req, res) => {
  // All four master-data sources are global (not client-scoped)
  const [entityTypes, licenses, services, jurisdictions] = await Promise.all([
    // Entity types grouped by tranche category
    EntityType.find({}, "name category").sort({ category: 1, name: 1 }).lean(),

    // Licenses from LicenseType master — code is what EntityProfile.licenses stores
    LicenseType.find({}, "code name").sort({ code: 1 }).lean(),

    // Designated services from DesignatedService master — code is what EntityProfile.designatedServices stores
    DesignatedService.find({}, "code name").sort({ code: 1 }).lean(),

    // Jurisdictions from CountryRisk — countryCode is what EntityProfile.jurisdictions stores
    CountryRisk.find({}, "countryCode countryName").sort({ countryName: 1 }).lean(),
  ]);

  // Deduplicate by their filter key to avoid React key collisions
  const dedup = (arr, key) => {
    const seen = new Set();
    return arr.filter((item) => {
      const k = item[key];
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  res.status(200).json({
    success: true,
    data: {
      entityTypes:   dedup(entityTypes,   "_id"),
      licenses:      dedup(licenses,      "code"),
      services:      dedup(services,      "code"),
      jurisdictions: dedup(jurisdictions, "countryCode"),
      statuses: ["Active", "Draft", "Archived"],
    },
  });
});

// @desc   Get single entity profile + matched obligation count
// @route  GET /api/v1/entity-profile/:id
// @access Protected
exports.getEntityProfile = asyncHandler(async (req, res, next) => {
  const profile = await EntityProfile.findById(req.params.id).populate("entityType createdBy");
  if (!profile) return next(new ErrorResponse("Entity profile not found", 404));

  const obligationCount = await EntityObligation.countDocuments({
    entityProfileId: profile._id,
  });

  res.status(200).json({ success: true, data: profile, obligationCount });
});

// @desc   Create entity profile
// @route  POST /api/v1/entity-profile
// @access Protected
exports.createEntityProfile = asyncHandler(async (req, res) => {
  const client = getClient(req);
  const profile = await EntityProfile.create({
    ...req.body,
    client,
    createdBy: req.user._id,
  });
  res.status(201).json({ success: true, data: profile });
});

// @desc   Update entity profile
// @route  PUT /api/v1/entity-profile/:id
// @access Protected
exports.updateEntityProfile = asyncHandler(async (req, res, next) => {
  const profile = await EntityProfile.findByIdAndUpdate(
    req.params.id,
    { ...req.body, updatedBy: req.user._id },
    { new: true, runValidators: true }
  ).populate("entityType");
  if (!profile) return next(new ErrorResponse("Entity profile not found", 404));
  res.status(200).json({ success: true, data: profile });
});

// @desc   Delete entity profile
// @route  DELETE /api/v1/entity-profile/:id
// @access Protected
exports.deleteEntityProfile = asyncHandler(async (req, res, next) => {
  const profile = await EntityProfile.findById(req.params.id);
  if (!profile) return next(new ErrorResponse("Entity profile not found", 404));

  // Remove instantiated obligations
  await EntityObligation.deleteMany({ entityProfileId: profile._id });
  await profile.deleteOne();

  res.status(200).json({ success: true, data: {} });
});

// @desc   Instantiate matching obligations from library for an entity profile
// @route  POST /api/v1/entity-profile/:id/instantiate-obligations
// @access Protected
exports.instantiateObligations = asyncHandler(async (req, res, next) => {
  const client = getClient(req);
  const profile = await EntityProfile.findById(req.params.id).populate("entityType");
  if (!profile) return next(new ErrorResponse("Entity profile not found", 404));

  const entityTypeName = profile.entityType?.name || "";
  const entityCategory = profile.entityType?.category || "";

  // Build filter to match obligations applicable to this entity
  const obQuery = {
    active: true,
    $or: [
      { applicableEntityTypes: { $in: ["All", "All Entities", "All AFSL Holders", "ALL"] } },
      { applicableEntityTypes: { $regex: entityCategory, $options: "i" } },
      { applicableEntityTypes: { $in: [entityTypeName] } },
    ],
  };

  // Also filter by licenses if entity has any
  if (profile.licenses?.length) {
    obQuery.$or.push({ applicableLicenses: { $in: [...profile.licenses, "Any"] } });
  }

  const obligations = await ObligationLibrary.find(obQuery);

  let created = 0;
  let skipped = 0;

  for (const ob of obligations) {
    const exists = await EntityObligation.findOne({
      entityProfileId: profile._id,
      obligationId: ob.obligationId,
    });
    if (exists) { skipped++; continue; }

    await EntityObligation.create({
      entityProfileId: profile._id,
      obligationId: ob.obligationId,
      obligationCategory: ob.category,
      obligationDescription: ob.description,
      status: "Active",
      client,
      assignedBy: req.user._id,
    });
    created++;
  }

  res.status(200).json({
    success: true,
    message: `${created} obligations instantiated, ${skipped} already existed.`,
    data: { created, skipped, total: obligations.length },
  });
});
