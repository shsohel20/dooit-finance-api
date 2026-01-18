const ErrorResponse = require("../utils/errorResponse");
const sendErrorResponse = require("../utils/sendErrorResponse");

const errorHandler = (err, req, res, next) => {
  let error = err;

  console.error("err", err);

  // Invalid ObjectId
  if (err.name === "CastError") {
    error = new ErrorResponse(
      `Resource not found with id of ${err.value}`,
      404
    );
  }

  // Duplicate key (MongoDB + Mongoose)
  if (err.code === 11000) {
    let fields = "unknown field";

    if (err.keyValue) {
      fields = Object.keys(err.keyValue).join(", ");
    } else if (err.errorResponse?.errmsg) {
      const match = err.errorResponse.errmsg.match(/Index '(.+?)'/);
      if (match) {
        fields = match[1].replace("_1", "");
      }
    }

    error = new ErrorResponse(
      `Duplicate value for field(s): ${fields}`,
      409
    );
  }

  // Validation error
  if (err.name === "ValidationError" && err.errors) {
    const message = Object.values(err.errors)
      .map((val) => val.message)
      .join(", ");
    error = new ErrorResponse(message, 400);
  }

  return sendErrorResponse(error, res);
};

module.exports = errorHandler;
