const multer = require("multer");
const path = require("path");

// store in memory for small CSV files
const storage = multer.memoryStorage();

const csvFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedMimes = ["text/csv", "application/csv", "application/vnd.ms-excel"];

  console.log("Uploading file:", file.originalname, "with mimetype:", file.mimetype);

  if (ext === ".csv" || allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only CSV files are allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter: csvFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

module.exports = upload;
