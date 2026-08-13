// ============================================================
// Mailer — pluggable email sender.
//
// In development it just prints the message (and any action link) to the
// console, so flows like password reset are fully demoable without an
// email provider. To go to production, implement `deliver()` with a real
// transport (nodemailer + SMTP, SendGrid, SES, Resend, …) — nothing else
// in the app needs to change.
// ============================================================

import { isProd } from '../config/env.js';

/**
 * Low-level delivery. Replace the body of this function with a real
 * transport for production.
 * @param {{ to: string, subject: string, text: string }} message
 */
async function deliver(message) {
  if (isProd) {
    // TODO: integrate a real email provider before shipping.
    console.warn('[mailer] No email provider configured — email NOT sent:', message.subject);
    return;
  }

  console.log('\n📧 [dev mailer] --------------------------------------------');
  console.log(`   to:      ${message.to}`);
  console.log(`   subject: ${message.subject}`);
  console.log(`   ${message.text.replace(/\n/g, '\n   ')}`);
  console.log('   -----------------------------------------------------------\n');
}

/**
 * Send a password-reset email containing the reset link.
 * @param {string} to        recipient email
 * @param {string} resetUrl  the full frontend reset URL (contains the raw token)
 * @param {number} ttlMin    how long the link is valid, in minutes
 */
export function sendPasswordResetEmail(to, resetUrl, ttlMin) {
  return deliver({
    to,
    subject: 'Reset your PingOne password',
    text:
      `You (or someone) requested a password reset for your PingOne account.\n` +
      `Click the link below to choose a new password. It expires in ${ttlMin} minutes.\n\n` +
      `${resetUrl}\n\n` +
      `If you didn't request this, you can safely ignore this email — your password won't change.`,
  });
}

/** Send an operational alert for a delivery that exhausted every retry. */
export function sendPermanentFailureEmail(to, { contactName, platform, attempts, reason }) {
  return deliver({
    to,
    subject: `PingOne delivery failed permanently (${platform})`,
    text:
      `A message to ${contactName} on ${platform} could not be sent after ${attempts} attempt(s).\n\n` +
      `Reason: ${reason}\n\n` +
      'The recipient was not sent another copy. Review the contact address and platform connection before scheduling again.',
  });
}
