const http = require('http');
const app = require('./app');
const { initSocket } = require('./socket');
const { env } = require('./config');
const logger = require('./utils/logger');
const redisClient = require('./config/redis');
const prisma = require('./models/prismaClient');

// Create HTTP server wrapping Express
const server = http.createServer(app);

// Initialize WebSockets
initSocket(server);

// Bind to 0.0.0.0 for Render cluster support.
const PORT = env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
    logger.info(`Server running in ${env.NODE_ENV} mode on port ${PORT}`);
    
    // Warm-up connections
    try {
        await redisClient.connect(); // Actually establish connection here
        await prisma.$connect();
        logger.info('Database & Cache engines warmed up.');
    } catch (error) {
        logger.error({ err: error }, 'Failed to warm up connection pools');
    }
});

// --- Graceful Shutdown Handler ---
// Triggered by Docker or Render during deployments
const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Starting Graceful Shutdown...`);
    
    server.close(async () => {
        logger.info('HTTP server closed.');
        try {
            await redisClient.quit();
            logger.info('Redis connection gracefully closed.');
            
            await prisma.$disconnect();
            logger.info('Prisma connections gracefully closed.');
            
            process.exit(0);
        } catch (err) {
            logger.error({ err }, 'Error during shutdown');
            process.exit(1);
        }
    });

    // Force close if it takes too long
    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled exceptions to prevent silent crashes and DB exhaustion
process.on('uncaughtException', (err) => {
    logger.error({ err }, 'UNCAUGHT EXCEPTION! Shutting down...');
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'UNHANDLED REJECTION! Shutting down...');
    shutdown('unhandledRejection');
});
