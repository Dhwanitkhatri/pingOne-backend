// ============================================================
// WhatsApp through Twilio — the fallback route the WhatsApp adapter uses when
// Meta rejects a send (see TWILIO_WHATSAPP_FALLBACK in config/env.js).
//
// Signed with the SERVER's Twilio account, not the user's Meta credential.
// Templates go out as their filled-in body text, which the Twilio Sandbox
// accepts inside the 24h window that joining it opens.
// ============================================================

import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

/**
 * @param {{ handle: string }} recipient  phone number, "+91…" or bare digits
 * @param {{ formatted: string, template?: object, attachments?: object[] }} message
 *        output of WhatsAppAdapter.formatMessage()
 * @returns {Promise<{ platformMessageId: string, raw: object }>}
 */
export async function sendWhatsAppViaTwilio(recipient, message) {
  const auth = { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN };

  // Twilio wants E.164 with the "+", prefixed with the channel.
  const to = `whatsapp:+${String(recipient.handle).replace(/\D/g, '')}`;
  const from = `whatsapp:${env.TWILIO_WHATSAPP_FROM}`;
  // The composer stores the preview as "WhatsApp template: <name>\n<body>".
  const body = message.template
    ? message.template.preview?.split('\n').slice(1).join('\n') ||
      message.template.bodyText ||
      message.template.name
    : message.formatted;

  // WhatsApp carries one media item per message: the first rides with the
  // text, any others follow on their own, in order.
  const [first, ...rest] = message.attachments ?? [];
  const data = await postMessage(auth, { From: from, To: to, Body: body }, first);
  for (const attachment of rest) {
    await postMessage(auth, { From: from, To: to }, attachment);
  }

  return { platformMessageId: data.sid, raw: data };
}

async function postMessage({ accountSid, authToken }, fields, attachment) {
  const params = new URLSearchParams(fields);
  // Twilio fetches media from this URL itself, so PUBLIC_BASE_URL must be public.
  if (attachment) params.append('MediaUrl', attachment.fileUrl);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const data = await res.json();

  if (!res.ok) {
    // 63015 = recipient hasn't joined the Sandbox — the usual first failure.
    throw AppError.badRequest(`WhatsApp send failed: ${data.message}`, {
      code: 'WHATSAPP_SEND_FAILED',
      details: data,
    });
  }
  return data;
}
