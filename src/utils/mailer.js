// ============================================================
// Mailer — transactional email the SERVER sends as itself.
//
// Three messages go through here: the email-verification link, the
// password-reset link, and the alert for a delivery that exhausted every
// retry. None of them has anything to do with the
// Gmail platform adapter — that sends as a CONNECTED USER over OAuth, on
// behalf of someone who authorised it. This sends as PingOne.
//
// Transport is SMTP via nodemailer, configured with SMTP_HOST/USER/PASS. Any
// provider works: a Gmail app password, Brevo, Mailtrap, SES, Postmark.
//
// With no SMTP configured, mail is PRINTED to the console rather than sent.
// That keeps the reset flow demoable without an email account — but it is
// exactly why a reset link can look like it "wasn't sent" when the backend
// did everything right, so the console output says so in as many words, and
// production warns on every send instead of failing quietly.
// ============================================================

import nodemailer from 'nodemailer';
import { env, isProd, isSmtpConfigured } from '../config/env.js';

/**
 * Built once and reused — nodemailer pools connections, and rebuilding the
 * transport per message would open a new TCP+TLS handshake every time.
 * Null until the first send so an app with no SMTP never touches nodemailer.
 */
let transport = null;

function getTransport() {
  if (transport) return transport;

  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Implicit TLS on 465; 587 negotiates STARTTLS after connecting, and
    // setting `secure` there makes the connection hang rather than fail.
    secure: env.SMTP_SECURE === undefined ? env.SMTP_PORT === 465 : env.SMTP_SECURE === 'true',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    // Fail fast instead of nodemailer's default two-minute wait. Some hosts
    // silently drop SMTP traffic (Render's free tier blocks ports 25, 465 and
    // 587), and a send that hangs leaves the request that triggered it hanging
    // past the frontend's 15s timeout with no error anyone can read.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transport;
}

/**
 * Verify the SMTP credentials by opening a connection and authenticating.
 * Called at boot so a typo'd password surfaces in the startup log rather than
 * the first time a user asks for a reset link.
 *
 * Never throws — bad mail config must not stop the API from serving requests.
 * @returns {Promise<boolean>}
 */
export async function verifyMailer() {
  if (!isSmtpConfigured) {
    console.warn(
      '[mailer] SMTP is not configured — password-reset emails will be PRINTED TO THIS CONSOLE, not delivered.\n' +
        '         Set SMTP_HOST, SMTP_USER and SMTP_PASS in .env to send real mail.'
    );
    return false;
  }

  try {
    await getTransport().verify();
    console.log(`[mailer] SMTP ready — sending as ${mailFrom()} via ${env.SMTP_HOST}:${env.SMTP_PORT}`);
    return true;
  } catch (err) {
    console.error(`[mailer] SMTP credentials rejected by ${env.SMTP_HOST}: ${err.message}`);
    return false;
  }
}

/** From: header. Falls back to the SMTP username, which providers accept. */
function mailFrom() {
  return env.MAIL_FROM || env.SMTP_USER || 'no-reply@pingone.local';
}

/**
 * Low-level delivery.
 *
 * Throws on a genuine send failure so the caller can decide what that means —
 * see the note in requestPasswordReset about why it deliberately doesn't turn
 * into a 500.
 *
 * @param {{ to: string, subject: string, text: string }} message
 */
async function deliver(message) {
  if (!isSmtpConfigured) {
    // Loud in production: shipping without a mail provider means every
    // password reset silently fails, and a warning per send is the only
    // signal anyone gets.
    if (isProd) {
      console.warn(`[mailer] No SMTP configured — email NOT sent: "${message.subject}" to ${message.to}`);
      return;
    }

    console.log('\n📧 [dev mailer] --------------------------------------------');
    console.log('   NOT ACTUALLY SENT — no SMTP configured. Set SMTP_* in .env.');
    console.log(`   to:      ${message.to}`);
    console.log(`   subject: ${message.subject}`);
    console.log(`   ${message.text.replace(/\n/g, '\n   ')}`);
    console.log('   -----------------------------------------------------------\n');
    return;
  }

  const info = await getTransport().sendMail({
    from: mailFrom(),
    to: message.to,
    subject: message.subject,
    text: message.text,
  });

  console.log(`[mailer] sent "${message.subject}" to ${message.to} (id ${info.messageId})`);
}

/**
 * Send the link that confirms a user owns the address they signed up with.
 * @param {string} to         recipient email
 * @param {{ firstName: string, verifyUrl: string, ttlHours: number }} details
 */
export function sendVerificationEmail(to, { firstName, verifyUrl, ttlHours }) {
  return deliver({
    to,
    subject: 'Verify your PingOne email address',
    text:
      `Hi ${firstName},\n\n` +
      `Please confirm this is your email address to start using PingOne.\n` +
      `Click the link below to verify it. It expires in ${ttlHours} hours.\n\n` +
      `${verifyUrl}\n\n` +
      `Until you verify, you can look around PingOne but can't send messages or connect platforms.\n` +
      `If you didn't create a PingOne account, you can safely ignore this email.`,
  });
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

const DIGEST_LABELS = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

/**
 * The summary email ("Weekly summary" in Settings).
 * @param {string} to
 * @param {{ firstName: string, frequency: string, since: Date, until: Date,
 *   stats: { messages: number, total: number, delivered: number, sent: number,
 *            failed: number, inProgress: number, byPlatform: Record<string, number> } }} details
 */
export function sendDigestEmail(to, { firstName, frequency, since, until, stats }) {
  const day = (date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const label = DIGEST_LABELS[frequency] ?? frequency;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const platforms = Object.entries(stats.byPlatform)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `  - ${name}: ${count}`)
    .join('\n');

  const lines = [
    `Hi ${firstName},`,
    '',
    `Here's your ${label} PingOne summary for ${day(since)} – ${day(until)}.`,
    '',
    `You sent ${plural(stats.messages, 'message')} to ${plural(stats.total, 'recipient')}:`,
    `  - Delivered or read: ${stats.delivered}`,
    `  - Sent (no delivery confirmation yet): ${stats.sent}`,
    `  - Failed: ${stats.failed}`,
    ...(stats.inProgress ? [`  - Still in progress: ${stats.inProgress}`] : []),
    '',
    'By platform:',
    platforms,
    '',
    ...(stats.failed
      ? ['Open Message History in PingOne to see why the failed ones didn\'t go through.', '']
      : []),
    'You can change or turn off this summary in Settings → Notifications.',
  ];

  return deliver({
    to,
    subject: `Your ${label} PingOne summary`,
    text: lines.join('\n'),
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
