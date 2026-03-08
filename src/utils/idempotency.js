const redisClient = require('../config/redis');
const logger = require('./logger');

/**
 * Checks if a messageId has already been processed recently.
 * Uses Redis to store the messageId with a 5 minute expiration.
 * @param {string} messageId - The unique token sent by the client.
 * @returns {Promise<boolean>} - True if it's a duplicate, false if it's new.
 */
async function isDuplicateMessage(messageId) {
  if (!messageId) return false;

  try {
    const key = `idempotency:${messageId}`;
    // Atomic check-and-set with 5 min (300s) expiration
    // Returns 'OK' if set, null if it already existed
    const result = await redisClient.set(key, '1', {
      NX: true,
      EX: 300
    });
    
    if (result === 'OK') {
      return false; // Not a duplicate
    }
    
    logger.warn({ messageId }, 'Duplicate message detected. Ignoring.');
    return true; // Duplicate
  } catch (err) {
    logger.error({ err, messageId }, 'Redis error during idempotency check');
    // If cache fails, we fallback to processing it anyway (graceful degradation)
    return false;
  }
}

module.exports = {
  isDuplicateMessage
};
