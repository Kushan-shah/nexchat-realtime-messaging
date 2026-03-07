const redisClient = require('../config/redis');
const logger = require('../utils/logger');

const PRESENCE_TTL = 30; // Seconds

/**
 * Mark a user as online in Redis. 
 * Overwrites their existing status to prevent stale socket IDs.
 */
async function setUserOnline(userId, socketId) {
  const key = `presence:${userId}`;
  try {
    await redisClient.set(key, socketId, { EX: PRESENCE_TTL });
    logger.info({ userId, socketId }, 'User marked online');
  } catch (err) {
    logger.error({ err, userId }, 'Failed to set presence');
  }
}

/**
 * Remove user presence when disconnecting, 
 * but verify socketId to prevent race conditions from concurrent sessions.
 */
async function setUserOffline(userId, socketId) {
  const key = `presence:${userId}`;
  try {
    // Only delete if the disconnected socket is the active one
    const activeSocket = await redisClient.get(key);
    if (activeSocket === socketId) {
      await redisClient.del(key);
      logger.info({ userId, socketId }, 'User marked offline');
    }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to remove presence');
  }
}

/**
 * Check if a user is online and return their socketId.
 */
async function getActiveSocket(userId) {
  const key = `presence:${userId}`;
  try {
    return await redisClient.get(key);
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get presence');
    return null;
  }
}

module.exports = {
  setUserOnline,
  setUserOffline,
  getActiveSocket
};
