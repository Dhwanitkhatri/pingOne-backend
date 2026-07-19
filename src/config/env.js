// ============================================================
// Environment loading + validation.
// Loads `.env` (via dotenv) and validates every variable the app
// depends on. Fails fast with a clear message if something is missing
// or malformed, so we never boot in a half-configured state.
// ============================================================

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),

  // Public URL of the frontend — used to build links in emails
  // (e.g. the password-reset link).
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  // Comma-separated origins -> string[]
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((val) =>
      val
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    ),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // 32-byte key, hex-encoded (64 hex chars) for AES-256.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  // How long a password-reset link stays valid, in minutes.
  PASSWORD_RESET_TTL_MIN: z.coerce.number().int().positive().default(60),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
