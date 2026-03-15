const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err;

  // Fallback for unexpected errors
  if (!statusCode) {
    statusCode = 500;
    message = 'Internal Server Error';
  }

  // Log error
  if (statusCode >= 500) {
    logger.error({ err, req: { method: req.method, url: req.url } }, message);
  } else {
    logger.warn({ err, req: { method: req.method, url: req.url } }, message);
  }

  const response = {
    code: statusCode,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };

  res.status(statusCode).json(response);
};

module.exports = errorHandler;
