const ErrorResponse = require('../utils/errorResponse');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  console.log('err', JSON.stringify(err, null, 2));

  ///Mongoose bad Object Id
  if (err.name === 'CastError') {
    const message = `The Entry not found with id of ${err.value}`;
    error = new ErrorResponse(message, 404);
  }
  ///Mongoose Duplicate key
  if (err.code === 11000) {
    const message = `The (${Object.getOwnPropertyNames(
      err.keyValue
    )}) value duplicate entreated`;
    error = new ErrorResponse(message, 400);
  }
  ///Mongoose Validation Errors
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map((val) => val.message);
    error = new ErrorResponse(message, 400);
  }

  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message || 'Sever Error',
  });
};

module.exports = errorHandler;
