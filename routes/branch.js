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

const { protect, authorizePermission } = require("../middleware/auth");
// protect all branch routes and allow only admin by default
router.use(protect);
router.use(
  authorizePermission("BRANCH.GET", "BRANCH.ADD", "BRANCH.EDIT", "BRANCH.DELETE"),
);

// list (supports GET with query params and POST with body-filter via advancedResults)
router
  .route("/")
  .post(advancedResults(Branch, "client", filterBranchSection), getBranchesPost)
  .get(advancedResults(Branch, "client"), getBranches);

// create new branch
router.route("/new").post(authorizePermission("BRANCH.ADD"), createBranch);

// create dummy branch

router.route("/dummy").post(authorizePermission("BRANCH.ADD"), createDummyBranch);

// optional: update branch status (if you implement updateBranchStatus in controller)
// router.route("/update-status/:id").put(updateBranchStatus);

// CRUD by id
router
  .route("/:id")
  .get(authorizePermission("BRANCH.GET"), getBranch)
  .put(authorizePermission("BRANCH.EDIT"), updateBranch)
  .delete(authorizePermission("BRANCH.DELETE"), deleteBranch);

// get by slug
router.route("/slug/:slug").get(authorizePermission("BRANCH.GET"), getBranchBySlug);

module.exports = router;
