const { createClient } = require('redis');
const { env } = require('./index');
const logger = require('../utils/logger');

/**
 * Redis Client Factory.
 * 
 * - Default: Connects to a real Redis instance via REDIS_URL (e.g. redis://localhost:6379).
 * - Fallback: If REDIS_URL is set to 'memory', uses an in-memory mock for zero-dependency local dev.
 * 
 * Real Redis provides true atomic Lua script execution, Sorted Set O(log N) operations,
 * and production-identical behavior for rate limiting, idempotency, and presence tracking.
 */

// ─── In-Memory Mock (opt-in via REDIS_URL=memory) ───────────────────────────
const mockStore = new Map();
const mockTimeouts = new Map();
const mockSortedSets = new Map();

const mockRedisClient = {
  connect: async () => { logger.info('Mock Redis (In-Memory) Connected'); },
  quit: async () => {
    for (const timer of mockTimeouts.values()) clearTimeout(timer);
    mockStore.clear(); mockTimeouts.clear(); mockSortedSets.clear();
    logger.info('Mock Redis gracefully closed');
  },
  ping: async () => 'PONG',
  get: async (key) => mockStore.get(key) || null,
  set: async (key, value, options) => {
    if (options && options.NX && mockStore.has(key)) return null;
    mockStore.set(key, value);
    if (options && options.EX) mockRedisClient.expire(key, options.EX);
    return 'OK';
  },
  del: async (key) => { mockStore.delete(key); mockSortedSets.delete(key); },
  setNX: async (key, value) => {
    if (mockStore.has(key)) return false;
    mockStore.set(key, value);
    return true;
  },
  incr: async (key) => {
    const val = parseInt(mockStore.get(key) || '0', 10) + 1;
    mockStore.set(key, val.toString());
    return val;
  },
  expire: async (key, seconds) => {
    if (mockTimeouts.has(key)) clearTimeout(mockTimeouts.get(key));
    const timer = setTimeout(() => { mockStore.delete(key); mockSortedSets.delete(key); }, seconds * 1000);
    mockTimeouts.set(key, timer);
  },
  pExpire: async (key, ms) => {
    if (mockTimeouts.has(key)) clearTimeout(mockTimeouts.get(key));
    const timer = setTimeout(() => { mockStore.delete(key); mockSortedSets.delete(key); }, ms);
    mockTimeouts.set(key, timer);
  },
  zAdd: async (key, score, member) => {
    if (!mockSortedSets.has(key)) mockSortedSets.set(key, []);
    const set = mockSortedSets.get(key);
    set.push({ score, member });
    set.sort((a, b) => a.score - b.score);
    return 1;
  },
  zRemRangeByScore: async (key, min, max) => {
    if (!mockSortedSets.has(key)) return 0;
    const set = mockSortedSets.get(key);
    const before = set.length;
    const filtered = set.filter(e => !(e.score >= min && e.score <= max));
    mockSortedSets.set(key, filtered);
    return before - filtered.length;
  },
  zCard: async (key) => {
    if (!mockSortedSets.has(key)) return 0;
    return mockSortedSets.get(key).length;
  },
  eval: async (script, options) => {
    const key = options.keys[0];
    if (script.includes('ZADD')) {
      const now = parseFloat(options.arguments[0]);
      const windowMs = parseFloat(options.arguments[1]);
      const uniqueId = options.arguments[2];
      await mockRedisClient.zRemRangeByScore(key, -Infinity, now - windowMs);
      await mockRedisClient.zAdd(key, now, uniqueId);
      const count = await mockRedisClient.zCard(key);
      await mockRedisClient.pExpire(key, windowMs);
      return count;
    }
    const ttl = options.arguments[0];
    const val = await mockRedisClient.incr(key);
    if (val === 1) {
      if (script.includes("PEXPIRE")) mockRedisClient.pExpire(key, parseInt(ttl, 10));
      else mockRedisClient.expire(key, parseInt(ttl, 10));
    }
    return val;
  },
  on: (event, cb) => {},
  duplicate: () => mockRedisClient
};

// ─── Real Redis Client ──────────────────────────────────────────────────────

function createRealRedisClient() {
  const client = createClient({ url: env.REDIS_URL });

  client.on('error', (err) => {
    logger.error({ err }, 'Redis Client Error');
  });

  client.on('connect', () => {
    logger.info({ url: env.REDIS_URL }, 'Redis connected');
  });

  client.on('reconnecting', () => {
    logger.warn('Redis reconnecting...');
  });

  return client;
}

// ─── Export: Real Redis by default, Mock if REDIS_URL=memory ─────────────────

const redisClient = env.REDIS_URL === 'memory'
  ? mockRedisClient
  : createRealRedisClient();

module.exports = redisClient;
