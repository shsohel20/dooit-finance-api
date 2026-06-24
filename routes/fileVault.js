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

// ── JSON parser — ONLY for routes whose body is application/json ─────────────
// NEVER mount express.json() at router level here.
// This router handles multipart/form-data uploads; a router-level JSON parser
// grabs the raw body stream before multer can read it and throws:
//   SyntaxError: Unexpected token - in JSON at position 0  (entity.parse.failed)
// because it tries to parse the binary multipart payload as JSON.
const jsonBody = express.json({ limit: "100mb" });

// ── Multer — memory storage, accept any file type, max 50 MB ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

const router = express.Router();

// All routes require a valid JWT
router.use(protect);

// ── Upload ────────────────────────────────────────────────────────────────────
router.post("/upload", upload.single("file"), uploadFile);
router.post("/chunk", upload.single("chunk"), uploadChunk);

// ── List ──────────────────────────────────────────────────────────────────────
router.get("/", listFiles);

// ── Bulk & Restore (must come before /:id to avoid param collision) ───────────
// jsonBody applied inline — only these two routes send an application/json body
router.delete("/bulk/delete", jsonBody, bulkDeleteFiles);
router.post("/restore", jsonBody, restoreFiles);

// ── Single file operations ────────────────────────────────────────────────────
router.get("/:id/url", getFileUrl);
router.get("/:id", getFile);
router.delete("/:id", deleteFile);

module.exports = router;
