// ============================================================
// Where Twilio reports back about messages we sent through it.
//
// Every send (WhatsApp-via-Twilio and SMS) carries a StatusCallback URL, and
// Twilio POSTs each change — sent, delivered, read (WhatsApp only),
// undelivered, failed — to it. Without one Twilio has nowhere to report and a
// delivery sits at "sent" forever, however long ago it was read.
//
// Handled by POST /webhooks/twilio/status (modules/webhooks). The URL is built
// from PUBLIC_BASE_URL because Twilio signs exactly the URL it calls, and the
// webhook re-derives the same string to check the signature.
// ============================================================

import { env } from '../config/env.js';

const base = () => `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}${env.API_PREFIX}`;

/**
 * The status-callback URL to hand Twilio, or null when the API isn't
 * publicly reachable (localhost) — Twilio would only log errors calling it.
 */
export function twilioStatusCallbackUrl() {
  return base().startsWith('https://') ? `${base()}/webhooks/twilio/status` : null;
}

/** The inbound-message URL to paste into Twilio's number / sender settings. */
export function twilioInboundUrl() {
  return `${base()}/webhooks/twilio/inbound`;
}
