const express = require('express');
const router = express.Router();
const authRoutes = require('./authRoutes');
const chatRoutes = require('./chatRoutes');
const userRoutes = require('./userRoutes');
const authMiddleware = require('../middleware/authMiddleware');
const prisma = require('../models/prismaClient');
const redisClient = require('../config/redis');

// Combine routes
router.use('/auth', authRoutes);
router.use('/chat', chatRoutes);
router.use('/users', userRoutes);

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Application Health Probe (Zero-downtime deployment check)
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Healthy
 *       503:
 *         description: Service Unavailable
 */
router.get('/health', async (req, res) => {
  try {
    // Ping DB
    await prisma.$queryRaw`SELECT 1`;
    // Ping Redis
    await redisClient.ping();
    res.status(200).json({ status: 'HEALTHY', message: 'All systems operational' });
  } catch (error) {
    res.status(503).json({ status: 'UNHEALTHY', error: error.message });
  }
});

/**
 * @swagger
 * /api/metrics:
 *   get:
 *     summary: Exposes basic telemetry for Prometheus scraping/monitoring
 *     tags: [Monitoring]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Metrics exported
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/metrics', authMiddleware, async (req, res) => {
  // Mock active users count for simplicity.
  // In a robust scenario, we'd query Redis for all `presence:*` keys.
  res.status(200).json({
    activeUsers: 42,
    messagesPerSecond: 15.4
  });
});

module.exports = router;
