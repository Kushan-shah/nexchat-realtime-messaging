const jwt = require('jsonwebtoken');
const { env } = require('../config');
const logger = require('../utils/logger');

const socketAuthMiddleware = (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers['x-auth-token'];
    
    if (!token) {
      logger.warn({ socketId: socket.id }, 'Socket connection attempt without token');
      return next(new Error('Authentication error: No token provided'));
    }

    const decoded = jwt.verify(token, env.JWT_SECRET);
    
    // Attach user info to socket instance for future handlers
    socket.user = decoded;
    next();
  } catch (error) {
    logger.warn({ err: error, socketId: socket.id }, 'Socket authentication failed');
    next(new Error('Authentication error: Invalid or expired token'));
  }
};

module.exports = socketAuthMiddleware;
