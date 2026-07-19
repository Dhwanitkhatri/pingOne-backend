// ============================================================
// Password hashing helpers (bcrypt).
// bcryptjs is a pure-JS implementation — no native build step,
// which keeps setup painless on Windows.
// ============================================================

import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

/**
 * Hash a plaintext password.
 * @param {string} plain
 * @returns {Promise<string>} bcrypt hash
 */
export function hashPassword(plain) {
  return bcrypt.hash(plain, env.BCRYPT_SALT_ROUNDS);
}

/**
 * Compare a plaintext password against a stored hash.
 * @param {string} plain
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
