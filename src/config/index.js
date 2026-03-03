const { z } = require('zod');
const dotenv = require('dotenv');

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('file:./dev.db'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(10),
  JWT_EXPIRES_IN: z.string().default('1d'),
  OPENAI_API_KEY: z.string().min(30).optional(),
  GEMINI_API_KEYS: z.string().optional(),
  AI_TIMEOUT_MS: z.string().transform(Number).default('2500'),
  FEATURE_AI_ENABLED: z.string().transform(val => val === 'true').default('true'),
  FEATURE_RATE_LIMIT: z.string().transform(val => val === 'true').default('true'),
  RATE_LIMIT_MSGS_PER_SEC: z.string().transform(Number).default('5'),
  RATE_LIMIT_BURST: z.string().transform(Number).default('20'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("❌ Invalid environment variables:", _env.error.format());
  process.exit(1);
}

module.exports = {
  env: _env.data,
};
