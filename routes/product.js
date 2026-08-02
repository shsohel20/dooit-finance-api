const express = require("express");

const {
  getProducts,
  getCategories,
  getMeta,
  getProduct,
  createProduct,
  updateProduct,
  setProductStatus,
  deleteProduct,
  bulkImport,
} = require("../controllers/productController");

const { protect, authorizeUserType } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(protect);
// Express 5 leaves req.body UNDEFINED when a request carries no body (Express 4
// gave {}). Several handlers read req.body.<field> directly — e.g. a POST with no
// payload — so normalise once here rather than guarding at every call site.
router.use((req, _res, next) => {
  if (req.body == null) req.body = {};
  next();
});


// ─────────────────────────────────────────────────────────────────────────────
// Billing product catalogue.
//
// READS are open to any authenticated user: a client must be able to see the
// catalogue because it names the rows on their usage table and invoices.
//
// WRITES are dooit-only. `authorizeUserType("dooit")` is the dooit-ONLY form —
// every other userType fails the membership test. Note that passing extra types
// (e.g. authorizeUserType("dooit", "client")) would NOT tighten anything: the
// middleware lets dooit through unconditionally (middleware/auth.js:199), so the
// list only ever widens access.
//
// The controller re-asserts the acting userType, so a mis-wired route here
// cannot by itself open a write path.
// ─────────────────────────────────────────────────────────────────────────────

const dooitOnly = authorizeUserType("dooit");

// Static routes before /:id, or 'categories' would be parsed as an id.
router.route("/categories").get(getCategories);
router.route("/meta").get(getMeta);
router.route("/bulk-import").post(dooitOnly, bulkImport);

router.route("/").get(getProducts).post(dooitOnly, createProduct);

router
  .route("/:id")
  .get(getProduct)
  .put(dooitOnly, updateProduct)
  .delete(dooitOnly, deleteProduct);

router.route("/:id/status").patch(dooitOnly, setProductStatus);

module.exports = router;
