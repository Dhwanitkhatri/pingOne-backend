// ============================================================
// AES-256-GCM encryption for platform tokens.
// Used when persisting OAuth/bot tokens in user_platform_credentials:
// the ciphertext goes in `encrypted_token` and the IV in `token_iv`
// (kept in a separate column so `encrypted_token` stays atomic — 1NF).
//
// GCM also produces an auth tag which detects tampering; we append it
// to the ciphertext as `ciphertextHex:authTagHex`.
// ============================================================

import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex'); // 32 bytes
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

/**
 * Encrypt a plaintext token.
 * @param {string} plaintext
 * @returns {{ encryptedToken: string, iv: string }} hex-encoded values
 */
export function encryptToken(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedToken: `${ciphertext.toString('hex')}:${authTag.toString('hex')}`,
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypt a token produced by encryptToken().
 * @param {string} encryptedToken  `ciphertextHex:authTagHex`
 * @param {string} ivHex
 * @returns {string} plaintext
 */
export function decryptToken(encryptedToken, ivHex) {
  const [ciphertextHex, authTagHex] = encryptedToken.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/**
 * Generate a cryptographically-random URL-safe token (hex).
 * Used for one-time secrets like password-reset links.
 * @param {number} [bytes=32]
 * @returns {string} hex string (2 * bytes chars)
 */
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * SHA-256 hash of a string, hex-encoded (64 chars). Used to store a
 * one-way hash of reset tokens so the raw token never touches the DB.
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
