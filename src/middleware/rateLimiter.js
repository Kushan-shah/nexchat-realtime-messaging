const redisClient = require('../config/redis');
const { env } = require('../config');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

/**
 * Sliding Window Rate Limiter using Redis Sorted Sets (ZADD + ZREMRANGEBYSCORE).
 *
 * Unlike fixed-window counters (INCR + EXPIRE), which reset all-at-once
 * and allow boundary bursts (2x the limit at window edges), a sliding window
 * tracks each individual request timestamp in a Sorted Set. The window moves
 * forward continuously — no burst loophole exists.
 *
 * Time Complexity:  O(log N) per request  (Sorted Set operations)
 * Space Complexity: O(N) per user          (N = max requests in window)
 *
 * Lua Script Atomicity: All 4 Redis commands (ZREMRANGEBYSCORE, ZADD, ZCARD,
 * PEXPIRE) execute in a single atomic `EVAL` — no interleaving, no partial
 * state, crash-safe.
 */

const SLIDING_WINDOW_SCRIPT = `
  local key       = KEYS[1]
  local now       = tonumber(ARGV[1])
  local windowMs  = tonumber(ARGV[2])
  local uniqueId  = ARGV[3]

  -- 1. Purge all entries older than (now - windowMs)
  redis.call("ZREMRANGEBYSCORE", key, "-inf", now - windowMs)

  -- 2. Insert current request: score = timestamp, member = unique ID
  redis.call("ZADD", key, now, uniqueId)

  -- 3. Count surviving entries = total requests within the sliding window
  local count = redis.call("ZCARD", key)

  -- 4. Auto-expire the entire key to prevent memory leaks for idle users
  redis.call("PEXPIRE", key, windowMs)

  return count
`;

/**
 * Express REST rate limiting middleware.
 * Limits to env.RATE_LIMIT_BURST requests per 10-second sliding window.
 */
const rateLimiterMiddleware = async (req, res, next) => {
  if (!env.FEATURE_RATE_LIMIT) return next();

  const identifier = req.user ? req.user.id : req.ip;
  const key = `ratelimit:${identifier}`;
  const limit = env.RATE_LIMIT_BURST || 20;
  const windowMs = 10000; // 10-second sliding window
  const now = Date.now();
  const uniqueId = `${now}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const requests = await redisClient.eval(SLIDING_WINDOW_SCRIPT, {
      keys: [key],
      arguments: [now.toString(), windowMs.toString(), uniqueId]
    });

    if (requests > limit) {
      logger.warn({ identifier, requests }, 'Rate limit exceeded (sliding window)');
      return next(new ApiError(429, 'Too many requests, please try again later.'));
    }

    next();
  } catch (error) {
    logger.error({ err: error }, 'Rate limiter Redis error');
    next(); // Fail open if Redis is down
  }
};

/**
 * Socket.IO per-user rate limiter.
 * Limits to env.RATE_LIMIT_MSGS_PER_SEC messages per 1-second sliding window.
 */
const checkSocketRateLimit = async (userId) => {
  if (!env.FEATURE_RATE_LIMIT) return true;

  const key = `ratelimit:socket:${userId}`;
  const limit = env.RATE_LIMIT_MSGS_PER_SEC;
  const windowMs = 1000; // 1-second sliding window
  const now = Date.now();
  const uniqueId = `${now}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const requests = await redisClient.eval(SLIDING_WINDOW_SCRIPT, {
      keys: [key],
      arguments: [now.toString(), windowMs.toString(), uniqueId]
    });

    if (requests > limit) {
      return false; // Limit exceeded
    }
    return true;
  } catch (error) {
    return true; // Fail open
  }
};

module.exports = {
  rateLimiterMiddleware,
  checkSocketRateLimit,
};
