const express = require("express");
const {
  getTTRs,
  getTTRsPost,
  createTTR,
  createDummyTTR,
  getTTR,
  updateTTR,
  deleteTTR,
  submitTTR,
  approveTTR,
  filterTTRSection,
} = require("../controllers/ttrController");

const TTR = require("../models/TtrReport");
const advancedResults = require("../middleware/advancedResults");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

const { protect, authorize } = require("../middleware/auth");

// Protect all TTR routes and allow only admin
router.use(protect);
// router.use(authorize("admin"));

// list (GET query / POST body-filter)
router
  .route("/")
  .get(
    advancedResults(TTR, ["partA.customers", "partC.transaction"], null),
    getTTRs,
  )
  .post(
    advancedResults(
      TTR,
      ["partA.customers", "partC.transaction"],
      filterTTRSection,
    ),
    getTTRsPost,
  );

// create
router.route("/new").post(createTTR);

// create dummy
router.route("/dummy").post(createDummyTTR);

// submit & approve
router.route("/:id/submit").put(submitTTR);
router.route("/:id/approve").put(approveTTR);

// CRUD
router.route("/:id").get(getTTR).put(updateTTR).delete(deleteTTR);

module.exports = router;
