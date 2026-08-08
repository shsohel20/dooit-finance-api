const express = require("express");
const { importDummyData } = require("../controllers/dummyImportController");
const { protect, authorizeUserType } = require("../middleware/auth");

const router = express.Router();

// Allow large JSON payloads for bulk dummy data imports
router.use(express.json({ limit: "500mb" }));

/**
 * POST /api/v1/dummy-import
 * Bulk import: Client > Branch > Customer > Transactions in one request.
 * Platform tooling — dooit only (writes real rows into live collections).
 */
router.route("/").post(protect, authorizeUserType("dooit"), importDummyData);

module.exports = router;
