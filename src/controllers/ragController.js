const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');
const redisClient = require('../config/redis');

const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || 'http://localhost:8001';
// Per-user RAG rate limit: 30 queries / hour
const RAG_RATE_LIMIT = 30;
const RAG_RATE_WINDOW = 3600; // seconds

/**
 * Per-user RAG rate limiter backed by Redis.
 * Interview flex: "I added a dedicated Redis counter for RAG queries — separate from
 * the global rate limiter — to control LLM API costs per user."
 */
async function checkRagRateLimit(userId) {
  try {
    const key = `rag_ratelimit:${userId}`;
    const count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, RAG_RATE_WINDOW);
    }
    return count <= RAG_RATE_LIMIT;
  } catch {
    return true; // Fail open if Redis is down
  }
}

const FormData = require('form-data');
const axios = require('axios');

/**
 * Upload document → Python RAG microservice (user-namespaced)
 */
exports.uploadDocument = async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'No file uploaded.');

    const userId = req.user.id.toString();
    logger.info({ userId, file: req.file.originalname }, 'Forwarding PDF to RAG microservice');

    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    try {
      const response = await axios.post(`${RAG_SERVICE_URL}/upload`, formData, {
        headers: {
          ...formData.getHeaders(),
          'X-User-Id': userId
        }
      });

      res.status(200).json({
        status: 'success',
        message: 'Document ingested into your private knowledge base.',
        details: response.data
      });
    } catch (err) {
      const errText = err.response?.data || err.message;
      logger.error({ errText }, 'RAG upload failed');
      throw new ApiError(err.response?.status || 500, 'RAG engine failed to process document.');
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Query the RAG engine — with per-user rate limiting and Redis cache passthrough
 */
exports.queryDocument = async (req, res, next) => {
  try {
    const { query } = req.body;
    if (!query) throw new ApiError(400, 'Query is required.');

    const userId = req.user.id.toString();

    // Per-user RAG rate limit
    const allowed = await checkRagRateLimit(userId);
    if (!allowed) {
      throw new ApiError(429, `RAG query limit reached (${RAG_RATE_LIMIT}/hour). Try again later.`);
    }

    logger.info({ userId, query: query.substring(0, 60) }, 'RAG query dispatched');

    const response = await fetch(`${RAG_SERVICE_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, user_id: userId }),
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error({ err }, 'RAG query failed');
      throw new ApiError(response.status, 'RAG engine query failed.');
    }

    const data = await response.json();

    if (data.cache_hit) {
      logger.info({ userId }, 'RAG cache HIT — zero LLM cost');
    }

    res.status(200).json({
      status: 'success',
      data: {
        context: data.context_retrieved,
        citations: data.citations,
        llm_prompt: data.llm_prompt,
        cache_hit: data.cache_hit || false,
        search_type: data.search_type || 'semantic',
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List documents in the user's knowledge base
 */
exports.listDocuments = async (req, res, next) => {
  try {
    const userId = req.user.id.toString();
    const response = await fetch(`${RAG_SERVICE_URL}/documents/${userId}`);
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a document from the user's knowledge base
 */
exports.deleteDocument = async (req, res, next) => {
  try {
    const userId = req.user.id.toString();
    const { filename } = req.params;
    const response = await fetch(
      `${RAG_SERVICE_URL}/documents/${userId}/${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    );
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, data.detail || 'Delete failed.');
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
