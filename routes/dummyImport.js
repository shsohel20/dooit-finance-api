const express = require("express");
const { importDummyData } = require("../controllers/dummyImportController");

const router = express.Router();

// Allow large JSON payloads for bulk dummy data imports
router.use(express.json({ limit: "500mb" }));

/**
 * POST /api/v1/dummy-import
 * Bulk import: Client > Branch > Customer > Transactions in one request.
 */
router.route("/").post(importDummyData);

module.exports = router;
