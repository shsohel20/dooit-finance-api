/**
 * FileVault Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Base path: /api/v1/file-vault
 *
 * Endpoint summary
 * ────────────────────────────────────────────────
 * POST   /upload           Upload a single file
 * POST   /chunk            Upload a file chunk (large files)
 * GET    /                 List files (pagination + filters)
 * GET    /:id              Stream / download a file
 * GET    /:id/url          Get direct URL for a file
 * DELETE /bulk/delete      Bulk soft-delete files
 * POST   /restore          Restore soft-deleted files
 * DELETE /:id              Soft-delete a single file
 */

const express = require("express");
const multer = require("multer");

const {
  uploadFile,
  uploadChunk,
  listFiles,
  getFile,
  getFileUrl,
  deleteFile,
  bulkDeleteFiles,
  restoreFiles,
} = require("../controllers/fileVaultController");

const { protect } = require("../middleware/auth");

const router = express.Router();

// ── Multer — memory storage, accept any file type, max 50 MB ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// All routes require a valid JWT
router.use(protect);
router.use(express.json());

// ── Upload ────────────────────────────────────────────────────────────────────
router.post("/upload", upload.single("file"), uploadFile);
router.post("/chunk", upload.single("chunk"), uploadChunk);

// ── List ──────────────────────────────────────────────────────────────────────
router.get("/", listFiles);

// ── Bulk & Restore (must come before /:id to avoid param collision) ───────────
router.delete("/bulk/delete", bulkDeleteFiles);
router.post("/restore", restoreFiles);

// ── Single file operations ────────────────────────────────────────────────────
router.get("/:id/url", getFileUrl);
router.get("/:id", getFile);
router.delete("/:id", deleteFile);

module.exports = router;
