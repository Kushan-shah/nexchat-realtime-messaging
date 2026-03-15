const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'NexChat API',
      version: '1.0.0',
      description: 'REST API for Real-Time Chat System',
    },
    // Removed arbitrary 'servers' array so Swagger UI uses the current hosted URL relatively, 
    // ensuring it works on both localhost and deployed servers like Render or AWS.
    tags: [
      { name: 'Auth', description: 'Authentication & Registration' },
      { name: 'Users', description: 'User Management & Profile' },
      { name: 'Chat', description: 'Messaging & Conversation History' },
      { name: 'Monitoring', description: 'Health Probes & Telemetry' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter JWT token obtained from /api/auth/login'
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', example: '8d144657-1096-4e6e-89f9-d21a382b958b' },
            username: { type: 'string', example: 'john_doe' },
            createdAt: { type: 'string', format: 'date-time' }
          }
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            senderId: { type: 'string', format: 'uuid' },
            receiverId: { type: 'string', format: 'uuid' },
            content: { type: 'string', example: 'Hello there!' },
            status: { type: 'string', enum: ['SENT', 'DELIVERED', 'READ'] },
            createdAt: { type: 'string', format: 'date-time' }
          }
        },
        ApiResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object' }
          }
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            code: { type: 'integer', example: 400 },
            message: { type: 'string', example: 'Validation error' }
          }
        }
      }
    },
    security: [{
      bearerAuth: []
    }],
  },
  apis: ['./src/routes/*.js'],
};

const specs = swaggerJsdoc(options);

module.exports = specs;
