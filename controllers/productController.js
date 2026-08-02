// controllers/productController.js
//
// Billing product catalogue — the reusable SKUs a plan is assembled from.
//
// Access model (docs/billingmodule/schema-design.md §2.3):
//   READ   — any authenticated user. A client must be able to see the catalogue;
//            it names the rows on their usage table and invoices.
//   WRITE  — dooit only. Enforced on the router with authorizeUserType('dooit')
//            AND re-asserted here, so a mis-wired route cannot open a write path.
//
// Money: `defaultUnitPrice` is Decimal128 on the way in (toDecimal) and a plain
// number on the way out (the model's toJSON transform).

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Product = require("../models/Product");
const BillingPlan = require("../models/BillingPlan");
const { toDecimal } = require("../utils/money");
const {
  assertUserType,
  assertActingAs,
  actorId,
  USER_TYPE_DOOIT,
} = require("../services/billing/assertUserType");
const {
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
  METER_SOURCES,
} = require("../models/constants/billing");

// Fields a dooit user may set on create. Anything else in the body is ignored —
// an allow-list, so a future schema field is never mass-assignable by accident.
const CREATABLE = [
  "name",
  "code",
  "description",
  "category",
  "unit",
  "meterSource",
  "meterEvent",
  "currency",
  "defaultUnitPrice",
  "billable",
  "status",
  "metadata",
];

// `code` is deliberately absent: usage records and plan snapshots reference it
// by value, so it is immutable once the product exists (enforced in the model).
const UPDATABLE = CREATABLE.filter((f) => f !== "code");

const pick = (src, fields) =>
  fields.reduce((acc, f) => {
    if (src[f] !== undefined) acc[f] = src[f];
    return acc;
  }, {});

// ─────────────────────────────────────────────────────────────────────────────

// @desc   List products (filter by category/status/search, paginated)
// @route  GET /api/v1/product
// @access Protected — any authenticated user
exports.getProducts = asyncHandler(async (req, res) => {
  const {
    category,
    status,
    billable,
    search,
    includeDeleted = "false",
    page = 1,
    limit = 50,
    sort = "name",
  } = req.query;

  const filter = {};
  if (includeDeleted !== "true") filter.isDeleted = false;
  if (category) filter.category = category;
  if (status && status !== "all") filter.status = status;
  if (billable !== undefined && billable !== "all") {
    filter.billable = billable === "true";
  }
  if (search) {
    // Escape regex metacharacters — a user-supplied '(' would otherwise throw.
    const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: { $regex: safe, $options: "i" } },
      { code: { $regex: safe, $options: "i" } },
      { description: { $regex: safe, $options: "i" } },
    ];
  }

  const SORTS = {
    name: { name: 1 },
    "-name": { name: -1 },
    price: { defaultUnitPrice: 1 },
    "-price": { defaultUnitPrice: -1 },
    category: { category: 1, name: 1 },
    created: { createdAt: 1 },
    "-created": { createdAt: -1 },
  };

  const result = await Product.paginate(filter, {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(200, Math.max(1, parseInt(limit, 10) || 50)),
    sort: SORTS[sort] || SORTS.name,
  });

  res.status(200).json({
    success: true,
    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.totalDocs,
      totalPages: result.totalPages,
    },
    data: result.docs,
  });
});

// @desc   Category summary with product counts
// @route  GET /api/v1/product/categories
// @access Protected — any authenticated user
exports.getCategories = asyncHandler(async (req, res) => {
  const counts = await Product.aggregate([
    { $match: { isDeleted: false, status: "active" } },
    {
      $group: {
        _id: "$category",
        count: { $sum: 1 },
        minPrice: { $min: "$defaultUnitPrice" },
        maxPrice: { $max: "$defaultUnitPrice" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byName = Object.fromEntries(counts.map((c) => [c._id, c]));

  // Return every known category, including empty ones, so the UI filter list is
  // stable rather than appearing and disappearing with the data.
  const data = PRODUCT_CATEGORIES.map((category) => ({
    category,
    count: byName[category]?.count ?? 0,
    minPrice: byName[category] ? parseFloat(byName[category].minPrice) : null,
    maxPrice: byName[category] ? parseFloat(byName[category].maxPrice) : null,
  }));

  res.status(200).json({ success: true, data });
});

// @desc   Enum values for building product forms
// @route  GET /api/v1/product/meta
// @access Protected — any authenticated user
exports.getMeta = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      categories: PRODUCT_CATEGORIES,
      units: PRODUCT_UNITS,
      meterSources: METER_SOURCES,
    },
  });
});

// @desc   Get a single product
// @route  GET /api/v1/product/:id
// @access Protected — any authenticated user
exports.getProduct = asyncHandler(async (req, res, next) => {
  const product = await Product.findById(req.params.id);
  if (!product || product.isDeleted) {
    return next(new ErrorResponse("Product not found", 404));
  }
  res.status(200).json({ success: true, data: product });
});

// @desc   Create a product
// @route  POST /api/v1/product
// @access dooit only
exports.createProduct = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const createdBy = actorId(req);
  await assertUserType(createdBy, USER_TYPE_DOOIT, "createdBy");

  const payload = pick(req.body, CREATABLE);

  if (payload.defaultUnitPrice !== undefined) {
    payload.defaultUnitPrice = toDecimal(payload.defaultUnitPrice);
  }
  payload.createdBy = createdBy;

  // Surface the duplicate-code case as a clean 409 rather than a Mongo E11000.
  if (payload.code) {
    const exists = await Product.findOne({
      code: String(payload.code).toLowerCase(),
    }).select("_id");
    if (exists) {
      return next(
        new ErrorResponse(`Product code "${payload.code}" already exists`, 409)
      );
    }
  }

  const product = await Product.create(payload);
  res.status(201).json({ success: true, data: product });
});

// @desc   Update a product (code is immutable)
// @route  PUT /api/v1/product/:id
// @access dooit only
exports.updateProduct = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const product = await Product.findById(req.params.id);
  if (!product || product.isDeleted) {
    return next(new ErrorResponse("Product not found", 404));
  }

  // Say so explicitly rather than silently dropping it — a caller who thinks
  // they renamed a code needs to know they did not.
  if (
    req.body.code !== undefined &&
    String(req.body.code).toLowerCase() !== product.code
  ) {
    return next(
      new ErrorResponse(
        "Product code is immutable — create a new product instead",
        400
      )
    );
  }

  const payload = pick(req.body, UPDATABLE);
  if (payload.defaultUnitPrice !== undefined) {
    payload.defaultUnitPrice = toDecimal(payload.defaultUnitPrice);
  }

  Object.assign(product, payload, { updatedBy: actorId(req) });
  await product.save();

  res.status(200).json({ success: true, data: product });
});

// @desc   Activate / deactivate a product
// @route  PATCH /api/v1/product/:id/status
// @access dooit only
exports.setProductStatus = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const { status } = req.body;
  if (!["active", "inactive"].includes(status)) {
    return next(
      new ErrorResponse("status must be either 'active' or 'inactive'", 400)
    );
  }

  const product = await Product.findById(req.params.id);
  if (!product || product.isDeleted) {
    return next(new ErrorResponse("Product not found", 404));
  }

  // Deactivating a product that published plans still sell is allowed, but the
  // caller should know the blast radius — published plans are frozen and keep
  // selling it, so this only affects NEW plans.
  let affectedPlans = 0;
  if (status === "inactive") {
    affectedPlans = await BillingPlan.countDocuments({
      "products.productId": product._id,
      status: "published",
      isDeleted: false,
    });
  }

  product.status = status;
  product.updatedBy = actorId(req);
  await product.save();

  res.status(200).json({
    success: true,
    data: product,
    meta: {
      affectedPublishedPlans: affectedPlans,
      note:
        affectedPlans > 0
          ? "Published plans are immutable and continue to sell this product; only new plans are affected."
          : undefined,
    },
  });
});

// @desc   Soft-delete a product
// @route  DELETE /api/v1/product/:id
// @access dooit only
exports.deleteProduct = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const product = await Product.findById(req.params.id);
  if (!product || product.isDeleted) {
    return next(new ErrorResponse("Product not found", 404));
  }

  // Refuse if any plan still references it. A product is referenced by value in
  // plan snapshots and usage records; deleting one that is still sold would
  // leave those pointing at nothing.
  const inUse = await BillingPlan.countDocuments({
    "products.productId": product._id,
    status: { $ne: "archived" },
    isDeleted: false,
  });
  if (inUse > 0) {
    return next(
      new ErrorResponse(
        `Cannot delete: ${inUse} non-archived plan(s) still include this product. Deactivate it instead.`,
        409
      )
    );
  }

  product.isDeleted = true;
  product.deletedAt = new Date();
  product.status = "inactive";
  product.updatedBy = actorId(req);
  await product.save();

  res.status(200).json({ success: true, data: {} });
});

// @desc   Bulk upsert products by code (catalogue seeding / price updates)
// @route  POST /api/v1/product/bulk-import
// @access dooit only
exports.bulkImport = asyncHandler(async (req, res, next) => {
  assertActingAs(req, USER_TYPE_DOOIT);

  const createdBy = actorId(req);
  await assertUserType(createdBy, USER_TYPE_DOOIT, "createdBy");

  const items = Array.isArray(req.body) ? req.body : req.body?.products;
  if (!Array.isArray(items) || items.length === 0) {
    return next(
      new ErrorResponse("Body must be an array of products, or { products: [] }", 400)
    );
  }
  if (items.length > 500) {
    return next(new ErrorResponse("Bulk import is limited to 500 products", 400));
  }

  const results = { created: 0, updated: 0, failed: [] };

  // Sequential rather than bulkWrite: the schema's validators and hooks (code
  // immutability, price scale) only run on document saves, and correctness here
  // matters more than throughput for a ~30-row catalogue.
  for (const [i, raw] of items.entries()) {
    try {
      const payload = pick(raw, CREATABLE);
      if (!payload.code) throw new Error("code is required");
      if (payload.defaultUnitPrice !== undefined) {
        payload.defaultUnitPrice = toDecimal(payload.defaultUnitPrice);
      }

      const code = String(payload.code).toLowerCase();
      const existing = await Product.findOne({ code });

      if (existing) {
        delete payload.code; // immutable
        Object.assign(existing, payload, { updatedBy: createdBy });
        await existing.save();
        results.updated += 1;
      } else {
        await Product.create({ ...payload, createdBy });
        results.created += 1;
      }
    } catch (err) {
      results.failed.push({ index: i, code: raw?.code ?? null, error: err.message });
    }
  }

  res.status(200).json({
    success: results.failed.length === 0,
    data: results,
  });
});
