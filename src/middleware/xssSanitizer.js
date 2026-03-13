const xss = require('xss');

/**
 * Recursively sanitizes input objects or strings to prevent Cross-Site Scripting (XSS).
 */
const sanitize = (data) => {
  if (typeof data === 'string') {
    return xss(data);
  }
  
  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item));
  }
  
  if (typeof data === 'object' && data !== null) {
    const sanitizedObj = {};
    for (const key in data) {
      sanitizedObj[key] = sanitize(data[key]);
    }
    return sanitizedObj;
  }
  
  return data;
};

/**
 * Express Middleware to sanitize req.body, req.query, and req.params
 */
const xssSanitizerREST = (req, res, next) => {
  if (req.body) req.body = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query);
  if (req.params) req.params = sanitize(req.params);
  next();
};

/**
 * Utility for Socket.io message sanitization
 */
const sanitizeSocketPayload = (payload) => {
  return sanitize(payload);
};

module.exports = {
  xssSanitizerREST,
  sanitizeSocketPayload
};
