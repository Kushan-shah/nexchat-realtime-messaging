const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

// Prevent multiple instances of Prisma Client in development
const globalForPrisma = global;
const prisma = globalForPrisma.prisma || new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'info' },
    { emit: 'event', level: 'warn' },
  ],
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

prisma.$on('error', (e) => {
  logger.error({ err: e }, 'Prisma Error');
});

module.exports = prisma;
