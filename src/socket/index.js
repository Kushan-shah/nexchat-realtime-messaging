const { Server } = require('socket.io');
const logger = require('../utils/logger');
const socketAuthMiddleware = require('../middleware/socketAuthMiddleware');
const connectionHandler = require('../handlers/connectionHandler');
const messageHandler = require('../handlers/messageHandler');

let io;

/**
 * Initializes Socket.IO with JWT authentication middleware.
 * Designed for horizontal scaling via Redis Pub/Sub adapter (add when deploying multi-instance).
 */
function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: "*", 
      methods: ["GET", "POST"]
    }
  });

  // Authentication Middleware
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    // 1. Handle Connection & Presence
    connectionHandler.handleConnection(socket, io);

    // 2. Handle Messages
    socket.on('send_message', (payload, callback) => {
      messageHandler.handleSendMessage(socket, io, payload, callback);
    });

    // Handle Disconnect
    socket.on('disconnect', () => {
      connectionHandler.handleDisconnect(socket, io);
    });
  });

  return io;
}

function getIo() {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
}

module.exports = {
  initSocket,
  getIo
};
