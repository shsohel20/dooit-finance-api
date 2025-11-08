const path = require("path");
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const uniqId = require("../utils/uniIdGenerator");
const File = require("../models/File");
const fs = require("fs");
var cloudinary = require("cloudinary").v2;

exports.photoUpload = asyncHandler(async (req, res, next) => {
  if (!req.files) {
    return next(new ErrorResponse(`Please upload a file`, 400));
  }

  const file = req.files.file;
  ///Make sure the image is a photo
  if (!file.mimetype.startsWith("image")) {
    return next(new ErrorResponse(`Please upload a photo`, 400));
  }
  ///Check filesize
  if (!file.size > process.env.MAX_FILE_UPLOAD) {
    return next(
      new ErrorResponse(
        `Please upload an image less than ${process.env.MAX_FILE_UPLOAD}`,
        400,
      ),
    );
  }

  console.log(file);

  //Create Custom File Name
  file.name = `photo_${uniqId()}${path.parse(file.name).ext}`;

  file.mv(`${process.env.FILE_UPLOAD_PATH}/${file.name}`, async (err) => {
    if (err) {
      return next(new ErrorResponse(`Problem with file upload `, 500));
    }

    const uploadedFile = await File.create({ fileUrl: file.name });

    res.status(200).json({
      success: true,
      data: uploadedFile,
    });
  });
});

exports.photoNextUpload = asyncHandler(async (req, res, next) => {
  if (!req.files) {
    return next(new ErrorResponse(`Please upload a file}`, 400));
  }

  const file = req.files.file;
  ///Make sure the image is a photo
  if (!file.mimetype.startsWith("image")) {
    return next(new ErrorResponse(`Please upload a photo`, 400));
  }
  ///Check filesize
  if (!file.size > process.env.MAX_FILE_UPLOAD) {
    return next(
      new ErrorResponse(
        `Please upload an image less than ${process.env.MAX_FILE_UPLOAD}`,
        400,
      ),
    );
  }

  //Create Custom File Name
  file.name = `photo_${uniqId()}${path.parse(file.name).ext}`;

  file.mv(`${process.env.FILE_UPLOAD_PATH}/${file.name}`, async (err) => {
    if (err) {
      return next(new ErrorResponse(`Problem with file upload `, 500));
    }

    res.status(200).json({
      success: true,
      data: file.name,
    });
  });
});

exports.removeFile = asyncHandler(async (req, res, next) => {
  const file = await File.findOne({ fileUrl: req.params.fileName });
  const filePath = `${process.env.FILE_UPLOAD_PATH}/${req.params.fileName}`;

  if (!file) {
    return next(new ErrorResponse(`File is not found`, 400));
  }

  try {
    fs.unlinkSync(filePath);
    file.deleteOne();
    res.status(200).json({
      success: true,
      data: "",
      message: "Delete File Successfully",
    });
  } catch (error) {
    return next(new ErrorResponse(`File is not Deleted`, 400));
  }
});

exports.cloudinaryPhotoUpload = asyncHandler(async (req, res, next) => {
  if (!req.files) {
    return next(new ErrorResponse(`Please upload a file`, 400));
  }

  const file = req.files.file;
  ///Make sure the image is a photo
  if (!file.mimetype.startsWith("image")) {
    return next(new ErrorResponse(`Please upload a photo`, 400));
  }
  ///Check filesize
  if (!file.size > process.env.MAX_FILE_UPLOAD) {
    return next(
      new ErrorResponse(
        `Please upload an image less than ${process.env.MAX_FILE_UPLOAD}`,
        400,
      ),
    );
  }

  //Create Custom File Name
  file.name = `photo_${uniqId()}${path.parse(file.name).ext}`;

  cloudinary.uploader
    .upload(file.tempFilePath)
    .then(async (result) => {
      const uploadedFile = await File.create({
        fileUrl: result.secure_url,
        publicFileUrl: result.url,
        couldinaryId: result.public_id,
      });
      res.status(200).json({
        success: true,
        data: uploadedFile,
      });
    })
    .catch((err) => {
      res.status(400).json({
        success: false,
        data: err,
      });
    });
});

exports.destroyFile = asyncHandler(async (req, res, next) => {
  const file = await File.findById(req.params.id);

  if (!file) {
    return next(new ErrorResponse(`File is not found`, 400));
  }

  try {
    if (file.couldinaryId) {
      cloudinary.uploader.destroy(file.couldinaryId, function (result) {
        file.deleteOne();
        res.status(200).json({
          success: true,
          data: "",
          message: "Delete File Successfully",
        });
      });
    } else {
      file.deleteOne();
      res.status(200).json({
        success: true,
        data: "",
        message: "Delete File Successfully",
      });
    }
  } catch (error) {
    return next(new ErrorResponse(`File is not Deleted`, 400));
  }
});

// @desc   Get all Files
// @route   /api/v1/fileUpload
// @access   Public
exports.getAllFiles = asyncHandler(async (req, res, next) => {
  ///see the route
  res.status(200).json(res.advancedResults);
});
