// routes/branches.js
const express = require("express");
const {
  getBranches,
  createBranch,
  getBranch,
  updateBranch,
  deleteBranch,
  filterBranchSection,
  getBranchBySlug,
  getBranchesPost,
  createDummyBranch,
} = require("../controllers/branchController");

const Branch = require("../models/Branch");
const advancedResults = require("../middleware/advancedResults");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const { protect, authorize } = require("../middleware/auth");
// protect all branch routes and allow only admin by default
router.use(protect);
router.use(authorize("admin branch"));

// list (supports GET with query params and POST with body-filter via advancedResults)
router
  .route("/")
  .post(advancedResults(Branch, "client", filterBranchSection), getBranchesPost)
  .get(advancedResults(Branch, "client"), getBranches);

// create new branch
router.route("/new").post(createBranch);

// create dummy branch

router.route("/dummy").post(createDummyBranch);

// optional: update branch status (if you implement updateBranchStatus in controller)
// router.route("/update-status/:id").put(updateBranchStatus);

// CRUD by id
router.route("/:id").get(getBranch).put(updateBranch).delete(deleteBranch);

// get by slug
router.route("/slug/:slug").get(getBranchBySlug);

module.exports = router;
