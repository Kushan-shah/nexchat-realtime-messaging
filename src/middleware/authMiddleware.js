const jwt = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const { env } = require('../config');

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ApiError(401, 'Unauthorized: No token provided');
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.JWT_SECRET);
    
    // Attach decoded user info to request
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      next(new ApiError(401, 'Unauthorized: Token expired'));
    } else {
      next(new ApiError(401, 'Unauthorized: Invalid token'));
    }
  }
};

module.exports = authMiddleware;
