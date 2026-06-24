const express = require("express");

const {
  photoUpload,
  photoNextUpload,
  removeFile,
  getAllFiles,
  cloudinaryPhotoUpload,
  destroyFile,
} = require("../controllers/fileUploadController");
const advancedResults = require("../middleware/advancedResults");
const File = require("../models/File");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));
router.use(express.urlencoded({ extended: true, limit: "3gb" }));

router.route("/").get(advancedResults(File), getAllFiles);

router.route("/photo").post(photoUpload);
router.route("/photo/client").post(photoNextUpload);
router.route("/:fileName").delete(removeFile);
router.route("/cloud-file/:id").delete(destroyFile);
router.route("/cloud-file").post(cloudinaryPhotoUpload);

module.exports = router;
