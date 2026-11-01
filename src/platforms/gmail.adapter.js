// ============================================================
// Gmail adapter — refreshes a short-lived access token from the stored
// OAuth2 refresh token, then sends via the Gmail REST API (raw base64url
// MIME message). No `googleapis` package needed — plain fetch.
//
// Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars (the OAuth
// app used when the user connected Gmail in credentials.service.js).
//
// Attachments are assembled into a real multipart/mixed MIME document, so a
// single API call carries the body and every file.
// ============================================================

import { randomUUID } from 'node:crypto';
import { BaseAdapter } from './base.adapter.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

async function getAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw AppError.badRequest('Could not refresh Gmail access token — user may need to reconnect', {
      code: 'GMAIL_REFRESH_FAILED',
      details: data.error_description,
    });
  }
  return data.access_token;
}

/**
 * Strip CR/LF from anything interpolated into a header. Without this, a
 * contact named "x\r\nBcc: someone@else" would inject headers into the message
 * — a real vulnerability, since these values come from user-supplied contact
 * data and uploaded filenames.
 */
function sanitizeHeader(value = '') {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * RFC 2047 encoding, so non-ASCII subjects and filenames survive transit
 * instead of arriving as mojibake. Plain ASCII is left alone for readability.
 */
function encodeHeaderValue(value) {
  const clean = sanitizeHeader(value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/**
 * Message text placed inside the HTML body must not be read as markup — a
 * "<" or "&" would otherwise break the email or let a message inject HTML.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Base64 in a MIME body has to be wrapped — RFC 2045 caps lines at 76 chars. */
function wrapBase64(base64) {
  return base64.replace(/(.{76})/g, '$1\r\n');
}

function buildMimeMessage({ to, from, subject, html, attachments = [] }) {
  const headers = [
    `To: ${sanitizeHeader(to)}`,
    `From: ${sanitizeHeader(from)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
  ];

  // No files — a simple single-part message keeps the payload small.
  if (attachments.length === 0) {
    const message = [...headers, 'Content-Type: text/html; charset=utf-8', '', html].join('\r\n');
    return Buffer.from(message).toString('base64url');
  }

  const boundary = `pingone_${randomUUID()}`;
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
  ];

  for (const attachment of attachments) {
    const name = encodeHeaderValue(attachment.fileName);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${sanitizeHeader(attachment.mimeType)}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(attachment.buffer.toString('base64'))
    );
  }

  parts.push(`--${boundary}--`, '');

  // base64url, not base64 — required by the Gmail API's `raw` field.
  return Buffer.from(parts.join('\r\n')).toString('base64url');
}

export class GmailAdapter extends BaseAdapter {
  static code = 'gmail';

  async validate({ secret: refreshToken }) {
    await getAccessToken(refreshToken); // throws if invalid
    return true;
  }

  formatMessage(content, attachments = []) {
    const html = `<div>${escapeHtml(content).replace(/\n/g, '<br>')}</div>`;
    return { formatted: html, hasAttachments: attachments.length > 0, attachments };
  }

  async send({ secret: refreshToken, extraInfo }, recipient, message, subject = 'Message from PingOne') {
    const accessToken = await getAccessToken(refreshToken);
    const raw = buildMimeMessage({
      to: recipient.handle,
      from: extraInfo?.gmail_address,
      subject,
      html: message.formatted,
      attachments: message.attachments ?? [],
    });

    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      }
    );
    const data = await res.json();

    if (!res.ok) {
      throw AppError.badRequest(`Gmail send failed: ${data.error?.message}`, {
        code: 'GMAIL_SEND_FAILED',
        details: data.error,
      });
    }

    return { platformMessageId: data.id, raw: data };
  }
}
