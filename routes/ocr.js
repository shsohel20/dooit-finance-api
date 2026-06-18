const express = require("express");
const { ocrDocument } = require("../controllers/ocrController");
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(express.json({ limit: "15mb" }));

// Standalone document OCR — works for any entity (staff, customer, etc.)
router.post("/document", protect, ocrDocument);

module.exports = router;
