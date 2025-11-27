const express = require("express");
const {
  getRFIs,
  getRFIsPost,
  createRFI,
  createDummyRFI,
  getRFI,
  updateRFI,
  deleteRFI,
  sendRFI,
  filterRFISection,
} = require("../controllers/rfiController");

const RFI = require("../models/Rfi");
const advancedResults = require("../middleware/advancedResults");

const router = express.Router();

const { protect, authorize } = require("../middleware/auth");

// protect all RFI routes and allow only admin by default
router.use(protect);
router.use(authorize("admin"));

// list
router
  .route("/")
  .get(
    advancedResults(RFI, [
      { path: "client" },
      { path: "customer" },
      { path: "branch" },
      { path: "case", populate: { path: "transaction" } },
    ]),
    getRFIs
  )
  .post(
    advancedResults(
      RFI,
      [
        { path: "client" },
        { path: "customer" },
        { path: "branch" },
        { path: "case", populate: { path: "transaction" } },
      ],
      filterRFISection
    ),
    getRFIsPost
  );

// create
router.route("/new").post(createRFI);

// create dummy
router.route("/dummy").post(createDummyRFI);

// send (initial|followup|final) -> use query param ?type=initial
router.route("/:id/send").get(sendRFI);

// CRUD
router.route("/:id").get(getRFI).put(updateRFI).delete(deleteRFI);

module.exports = router;
