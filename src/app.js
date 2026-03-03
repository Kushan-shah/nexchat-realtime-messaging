const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');

const swaggerSpecs = require('./utils/swagger');
const routes = require('./routes');
const errorHandler = require('./middleware/errorHandler');
const { xssSanitizerREST } = require('./middleware/xssSanitizer');
const { rateLimiterMiddleware } = require('./middleware/rateLimiter');

const app = express();

// Set Security HTTP Headers (Helmet)
app.use(helmet());

// CORS Config (Prepared for Render / AWS)
app.use(cors({
  origin: '*', // For production, replace with specific origins
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10kb' })); // Body parser
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Apply XSS Sanitization globally
app.use(xssSanitizerREST);

// Apply REST Sliding-Window Rate Limiting globally
app.use(rateLimiterMiddleware);

// API Documentation Endpoint
app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerSpecs, {
  customSiteTitle: 'NexChat API',
  explorer: true,
  customJsStr: `
    // Spoof default OS dark mode so light mode is default
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = function(query) {
      if (query === '(prefers-color-scheme: dark)') {
        return { matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} };
      }
      return originalMatchMedia(query);
    };
  `
}));

// Mount master routes
app.use('/api', routes);

// 404 Catcher
app.all('*', (req, res, next) => {
  res.status(404).json({
    status: 'ERROR',
    message: `Can't find ${req.originalUrl} on this server!`
  });
});

// Global Error Handler
app.use(errorHandler);

module.exports = app;
