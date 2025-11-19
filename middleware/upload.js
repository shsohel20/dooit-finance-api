// middleware/upload.js
const multer = require("multer");
const path = require("path");

// store in memory for immediate streaming. For large files you can use diskStorage.
const storage = multer.memoryStorage();

const csvFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (
    ext === ".csv" ||
    file.mimetype === "text/csv" ||
    file.mimetype === "application/vnd.ms-excel"
  ) {
    cb(null, true);
  } else {
    cb(new Error("Only CSV files are allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter: csvFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit — adjust as needed
});

module.exports = upload;
