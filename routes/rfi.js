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
router.use(express.json({ limit: "100kb" }));

const { protect, authorizePermission } = require("../middleware/auth");

// Every RFI route needs an RFI grant; each route below narrows by verb.
router.use(protect);
router.use(authorizePermission("RFI.GET", "RFI.ADD", "RFI.EDIT", "RFI.DELETE"));

// list
router
  .route("/")
  .get(
    advancedResults(RFI, [
      { path: "client" },
      { path: "customer" },
      { path: "branch" },
      // Investigation hub (null until the alert is escalated) and the
      // originating alert — the alert-details page lists RFIs by `?alert=<id>`.
      { path: "case", select: "uid title status caseType riskLabel priority customer linkedTransactions", populate: { path: "linkedTransactions", select: "uid amount currency type status timestamp" } },
      { path: "alert", select: "uid status caseType riskScore riskLabel priority customer transaction linkedCase", populate: { path: "transaction", select: "uid amount currency type status timestamp" } },
    ]),
    getRFIs,
  )
  .post(
    advancedResults(
      RFI,
      [
        { path: "client" },
        { path: "customer" },
        { path: "branch" },
        // Investigation hub (null until the alert is escalated) and the
      // originating alert — the alert-details page lists RFIs by `?alert=<id>`.
      { path: "case", select: "uid title status caseType riskLabel priority customer linkedTransactions", populate: { path: "linkedTransactions", select: "uid amount currency type status timestamp" } },
      { path: "alert", select: "uid status caseType riskScore riskLabel priority customer transaction linkedCase", populate: { path: "transaction", select: "uid amount currency type status timestamp" } },
      ],
      filterRFISection,
    ),
    getRFIsPost,
  );

// create
router.route("/new").post(authorizePermission("RFI.ADD"), createRFI);

// create dummy
router.route("/dummy").post(authorizePermission("RFI.ADD"), createDummyRFI);

// send (initial|followup|final) -> use query param ?type=initial
router.route("/:id/send").get(authorizePermission("RFI.EDIT"), sendRFI);

// CRUD
router
  .route("/:id")
  .get(authorizePermission("RFI.GET"), getRFI)
  .put(authorizePermission("RFI.EDIT"), updateRFI)
  .delete(authorizePermission("RFI.DELETE"), deleteRFI);

module.exports = router;
