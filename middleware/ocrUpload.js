const multer = require("multer");

// Mirrors middleware/upload.js's shape (memoryStorage — no CSV parsing
// needed here, the buffer is forwarded as-is to the OCR service). Accepts
// what /process-ekyb-company itself accepts: a single image or PDF (docs/65
// Step 48).
const storage = multer.memoryStorage();

const imageOrPdfFilter = (req, file, cb) => {
  const allowedMimes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
  ];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only image or PDF files are allowed"), false);
  }
};

module.exports = multer({
  storage,
  fileFilter: imageOrPdfFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB — multi-page PDFs
});
