// ============================================================
// Gmail adapter — refreshes a short-lived access token from the stored
// OAuth2 refresh token, then sends via the Gmail REST API (raw base64url
// MIME message). No `googleapis` package needed — plain fetch.
//
// Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars (the OAuth
// app used when the user connected Gmail in credentials.service.js).
// ============================================================

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

function buildMimeMessage({ to, from, subject, html }) {
  const message = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\r\n');

  return Buffer.from(message).toString('base64url'); // base64url required by Gmail API
}

export class GmailAdapter extends BaseAdapter {
  static code = 'gmail';

  async validate({ secret: refreshToken }) {
    await getAccessToken(refreshToken); // throws if invalid
    return true;
  }

  formatMessage(content, attachments = []) {
    // Wrap as minimal HTML. Attachments need multipart/mixed MIME —
    // left as a TODO since none of your 32 features strictly require
    // it on day one; extend buildMimeMessage() when you get there.
    const html = `<div>${content.replace(/\n/g, '<br>')}</div>`;
    return { formatted: html, hasAttachments: attachments.length > 0, attachments };
  }

  async send({ secret: refreshToken, extraInfo }, recipient, message, subject = 'Message from PingOne') {
    const accessToken = await getAccessToken(refreshToken);
    const raw = buildMimeMessage({
      to: recipient.handle,
      from: extraInfo?.gmail_address,
      subject,
      html: message.formatted,
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
