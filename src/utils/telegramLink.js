// ============================================================
// Telegram deep-link payloads.
//
// A bot can only message someone who messaged it first, and the Bot API
// gives no way to turn an @username into the numeric chat_id a send needs.
// So the id has to be CAPTURED rather than looked up: the contact opens
//
//     https://t.me/<bot>?start=<payload>
//
// presses Start, and Telegram delivers "/start <payload>" as an ordinary
// message. The webhook reads the payload, and now knows which contact that
// chat_id belongs to.
//
// The payload is signed. Without a signature it would just be a contact id,
// and anyone who guessed one could bind THEIR chat to another user's contact
// — quietly redirecting every future message meant for that person to
// themselves. The HMAC makes a payload unforgeable without the server secret.
//
// Telegram's constraints on the payload: 1–64 characters, and only
// A-Z a-z 0-9 _ and -. That rules out a JWT (too long), which is why this is
// a compact "c<id>_<mac>" instead.
// ============================================================

import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** Truncated to keep the payload short; 40 bits is ample against guessing. */
const MAC_LENGTH = 10;

const PAYLOAD_PATTERN = /^c(\d+)_([0-9a-f]+)$/;

/**
 * HMAC over the contact id, keyed with the server's signing secret.
 * @param {number|string} contactId
 * @returns {string} hex, truncated to MAC_LENGTH
 */
function sign(contactId) {
  return crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`telegram-link:${contactId}`)
    .digest('hex')
    .slice(0, MAC_LENGTH);
}

/**
 * Build the `?start=` payload for a contact.
 *
 * Deliberately has no expiry: an invite link is something a user sends over
 * WhatsApp or email and the contact may open days later. Revocation isn't
 * needed either — the worst a leaked payload allows is binding a chat to a
 * contact, which the owner sees immediately as a changed link status and can
 * undo by clearing the contact's Telegram handle.
 *
 * @param {number} contactId
 * @returns {string} e.g. "c73_9f2ab41c0d"
 */
export function buildStartPayload(contactId) {
  return `c${contactId}_${sign(contactId)}`;
}

/**
 * Full deep link for a bot.
 * @param {string} botUsername with or without the leading "@"
 * @param {number} contactId
 */
export function buildInviteUrl(botUsername, contactId) {
  const name = String(botUsername ?? '').replace(/^@/, '');
  return `https://t.me/${name}?start=${buildStartPayload(contactId)}`;
}

/**
 * Verify a payload that came back through the webhook.
 *
 * Compared in constant time — a plain `===` on a MAC leaks timing, and the
 * cost of doing it properly is nil.
 *
 * @param {string} payload
 * @returns {number|null} the contact id, or null if absent/malformed/forged
 */
export function parseStartPayload(payload) {
  const match = PAYLOAD_PATTERN.exec(String(payload ?? '').trim());
  if (!match) return null;

  const [, contactId, mac] = match;
  const expected = sign(contactId);

  // timingSafeEqual throws on a length mismatch, so guard first.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  return Number(contactId);
}

/**
 * Pull the payload out of a Telegram message body.
 * Returns null for anything that isn't a "/start <payload>" command.
 *
 * @param {string} text the message's `text` field
 */
export function extractStartPayload(text) {
  const match = /^\/start(?:@\w+)?\s+(\S+)$/.exec(String(text ?? '').trim());
  return match ? match[1] : null;
}
