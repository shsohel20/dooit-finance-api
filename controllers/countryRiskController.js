const asyncHandler = require("../middleware/async");
const CountryRisk = require("../models/CountryRisk");
const ErrorResponse = require("../utils/errorResponse");

// @route GET /api/v1/country-risk
exports.getCountries = asyncHandler(async (req, res) => {
  const { riskTier, region, search, page = 1, limit = 100 } = req.query;
  const filter = { active: true };
  if (riskTier) filter.$or = [{ riskTier }, { band: riskTier }];
  if (region) filter.region = region;
  if (search) {
    filter.$or = [
      { countryName: { $regex: search, $options: "i" } },
      { countryCode: { $regex: search, $options: "i" } },
    ];
  }
  const options = {
    page: parseInt(page), limit: parseInt(limit),
    sort: { riskTier: 1, countryName: 1 },
  };
  const result = await CountryRisk.paginate(filter, options);
  res.status(200).json({
    success: true,
    pagination: { page: result.page, total: result.totalDocs, totalPages: result.totalPages },
    data: result.docs,
  });
});

// @route GET /api/v1/country-risk/:code
exports.getCountry = asyncHandler(async (req, res, next) => {
  const country = await CountryRisk.findOne({ countryCode: req.params.code.toUpperCase() });
  if (!country) return next(new ErrorResponse("Country not found", 404));
  res.status(200).json({ success: true, data: country });
});

// @route PUT /api/v1/country-risk/:code
exports.updateCountry = asyncHandler(async (req, res, next) => {
  const allowed = ["riskTier","mlRiskScore","tfRiskScore","sanctionsRisk","corruptionScore","fatfStatus","isSanctioned","isHighRiskByFATF","isFATFBlackList","ausAustracGuidance","overallScore"];
  const update = { lastUpdated: new Date() };
  allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

  const country = await CountryRisk.findOneAndUpdate(
    { countryCode: req.params.code.toUpperCase() },
    update,
    { new: true, runValidators: true }
  );
  if (!country) return next(new ErrorResponse("Country not found", 404));
  res.status(200).json({ success: true, data: country });
});

// @route POST /api/v1/country-risk/bulk-import
exports.bulkImport = asyncHandler(async (req, res) => {
  const { countries } = req.body;
  if (!Array.isArray(countries)) return res.status(400).json({ success: false, message: "countries array required" });

  const ops = countries.map((c) => ({
    updateOne: {
      filter: { countryCode: c.countryCode.toUpperCase() },
      update: { $set: { ...c, countryCode: c.countryCode.toUpperCase() } },
      upsert: true,
    },
  }));
  const result = await CountryRisk.bulkWrite(ops, { ordered: false });
  res.status(200).json({ success: true, data: { upserted: result.upsertedCount, modified: result.modifiedCount } });
});

// @route GET /api/v1/country-risk/lookup/:code  — lightweight for dropdowns
exports.lookup = asyncHandler(async (req, res) => {
  const country = await CountryRisk.findOne(
    { countryCode: req.params.code.toUpperCase() },
    "countryCode countryName riskTier overallScore fatfStatus isSanctioned"
  ).lean();
  res.status(200).json({ success: true, data: country || null });
});
