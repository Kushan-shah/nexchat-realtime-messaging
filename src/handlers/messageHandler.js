const prisma = require('../models/prismaClient');
const logger = require('../utils/logger');
const { isDuplicateMessage } = require('../utils/idempotency');
const { checkSocketRateLimit } = require('../middleware/rateLimiter');
const { sanitizeSocketPayload } = require('../middleware/xssSanitizer');
const { generateSmartReply } = require('../services/aiService');
const { getDMRoomId, onlineUsers } = require('./connectionHandler');

let activeMessageProcessingCount = 0;
const MAX_CONCURRENT_MESSAGES = 100; // Backpressure Drop Threshold

/**
 * Handles incoming `send_message` events.
 * Supports both global room and DM messages.
 */
async function handleSendMessage(socket, io, rawPayload, callback) {
  // === EVENT LOOP BACKPRESSURE GUARANTEE ===
  if (activeMessageProcessingCount >= MAX_CONCURRENT_MESSAGES) {
    logger.warn({ userId: socket.user.id }, 'Event loop backpressure active. Dropping message.');
    socket.emit('error', { message: 'Server under severe load. Backpressure active.' });
    if (callback) callback({ status: 'ERROR', message: 'Server busy. Retry shortly.' });
    return;
  }

  activeMessageProcessingCount++;
  const userId = socket.user.id;
  const username = socket.user.username;

  try {
    // 1. Rate Limiting Check
    const allowed = await checkSocketRateLimit(userId);
    if (!allowed) {
      if (callback) callback({ status: 'ERROR', message: 'Rate limit exceeded' });
      return;
    }

    // 2. Sanitization (XSS Defense)
    const payload = sanitizeSocketPayload(rawPayload);
    const { messageId, receiverId, content, isGlobal } = payload;

    if (!messageId || !content) {
      if (callback) callback({ status: 'ERROR', message: 'Missing fields' });
      return;
    }

    // 3. Idempotency Check
    const isDuplicate = await isDuplicateMessage(messageId);
    if (isDuplicate) {
      if (callback) callback({ status: 'DELIVERED', messageId });
      return;
    }

    const messageData = {
      messageId,
      senderId: userId,
      senderName: username,
      content,
      timestamp: new Date().toISOString()
    };

    if (isGlobal) {
      // === GLOBAL ROOM MESSAGE ===
      const { globalChatHistory } = require('./connectionHandler');
      
      const payloadObj = {
        ...messageData,
        isGlobal: true
      };
      
      globalChatHistory.push(payloadObj);
      if (globalChatHistory.length > 100) globalChatHistory.shift();

      // Broadcast to everyone in 'global' room except sender
      socket.to('global').emit('message_received', payloadObj);

      if (callback) callback({ status: 'DELIVERED', messageId });

    } else {
      // === DIRECT MESSAGE ===
      if (!receiverId) {
        if (callback) callback({ status: 'ERROR', message: 'receiverId required for DM' });
        return;
      }

      // Persist to DB
      await prisma.message.create({
        data: {
          id: messageId,
          senderId: userId,
          receiverId,
          content,
          status: 'SENT'
        }
      });

      const roomId = getDMRoomId(userId, receiverId);
      
      // Emit reliably to personal proxy rooms (guarantees delivery across all tabs for both users)
      // socket.to() prevents echoing back to the sender's current tab!
      socket.to([`user_${userId}`, `user_${receiverId}`]).emit('message_received', {
        ...messageData,
        receiverId,
        roomId,
        isGlobal: false
      });

      // Check if receiver is online
      const receiverOnline = onlineUsers.has(receiverId);
      if (receiverOnline) {
        await prisma.message.update({
          where: { id: messageId },
          data: { status: 'DELIVERED' }
        });
        if (callback) callback({ status: 'DELIVERED', messageId });
      } else {
        if (callback) callback({ status: 'SENT', messageId });
      }

      // Async AI
      generateSmartReply(content).then(async (suggestions) => {
        if (suggestions && suggestions.length > 0) {
          const receiverInfo = onlineUsers.get(receiverId);
          if (receiverInfo) {
            io.to(`user_${receiverId}`).emit('ai_suggestion_ready', {
              messageId,
              senderId: userId,
              suggestions
            });
          }
        }
      }).catch(err => {
        logger.error({ err }, 'AI generator async wrapper failed');
      });
    }
  } catch (error) {
    logger.error({ err: error }, 'Error in handleSendMessage');
    if (callback) callback({ status: 'ERROR', message: 'Internal Server Error' });
  } finally {
    // Release Backpressure Slot
    activeMessageProcessingCount--;
  }
}

module.exports = {
  handleSendMessage
};
