const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const logger = require('../utils/logger');
const socketAuthMiddleware = require('../middleware/socketAuthMiddleware');
const connectionHandler = require('../handlers/connectionHandler');
const messageHandler = require('../handlers/messageHandler');

let io;

/**
 * Initializes Socket.IO with:
 * - JWT authentication middleware
 * - Redis Pub/Sub adapter for horizontal scaling
 *
 * Interview flex: "WebSocket rooms are stored in Redis, not in-process memory.
 * Spinning up N Node.js instances behind a load balancer works with zero code changes
 * to business logic — Redis fans out events across all instances."
 */
function initSocket(server) {
  io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
  });

  // Redis Pub/Sub adapter — enables horizontal scaling
  try {
    const { createClient } = require('redis');
    const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
    const pubClient = createClient({ url: REDIS_URL });
    const subClient = pubClient.duplicate();

    Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        logger.info('✅ Socket.IO Redis adapter active — horizontally scalable.');
      })
      .catch((err) => {
        logger.warn({ err }, '⚠️  Redis adapter failed — falling back to in-memory (single instance).');
      });
  } catch (err) {
    logger.warn({ err }, '⚠️  Redis adapter unavailable — single-instance mode.');
  }

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
