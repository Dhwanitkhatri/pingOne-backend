// ============================================================
// Twilio Connect — Twilio's authorization flow for acting on someone
// else's Twilio account.
//
// It is NOT OAuth2: there is no code-for-token exchange. The user
// approves our Connect App at twilio.com/authorize/{ConnectAppSid} and
// Twilio redirects back with the *AccountSid* they authorized. From then
// on every REST call for that user is signed with
//
//     Basic base64(<their AccountSid>:<OUR auth token>)
//
// — their sid as the username, this server's auth token as the password.
// That means the "secret" we store per user is our own auth token, which
// is exactly what SmsAdapter already expects alongside
// extra_info.account_sid, so sending needs no adapter changes.
//
// The redirect URL is configured on the Connect App itself in the Twilio
// console; we cannot pass it in the authorize request, we can only pass
// `state`.
// ============================================================

import { env, isTwilioConnectConfigured } from '../../../config/env.js';
import { fetchJson } from '../../../utils/httpClient.js';
import { AppError } from '../../../utils/AppError.js';

const API_ROOT = 'https://api.twilio.com/2010-04-01';

/** Throw an actionable 503 when the app was started without Connect config. */
export function assertConfigured() {
  if (!isTwilioConnectConfigured) {
    throw new AppError(
      503,
      'Twilio Connect is not configured on this server. Set TWILIO_CONNECT_APP_SID, ' +
        'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
      { code: 'TWILIO_CONNECT_NOT_CONFIGURED' }
    );
  }
}

/**
 * Basic-auth header for a call made on behalf of `accountSid`. Falls back
 * to our own sid, which is how we authenticate as ourselves.
 * @param {string} [accountSid]
 */
export function authHeader(accountSid = env.TWILIO_ACCOUNT_SID) {
  const basic = Buffer.from(`${accountSid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${basic}` };
}

/**
 * Build the Twilio authorization URL the user is sent to.
 * @param {string} state signed, short-lived state value
 * @returns {string}
 */
export function buildAuthorizationUrl(state) {
  assertConfigured();

  const params = new URLSearchParams({ state });
  return `https://www.twilio.com/authorize/${env.TWILIO_CONNECT_APP_SID}?${params.toString()}`;
}

/**
 * Read the authorized account back. This is the closest thing Connect has
 * to a token exchange: it proves the grant is live and that our auth token
 * really can sign calls for that sid, before we store anything.
 *
 * @param {string} accountSid the sid Twilio handed back on the redirect
 * @returns {Promise<{ accountSid: string, friendlyName?: string, status?: string }>}
 */
export async function fetchAuthorizedAccount(accountSid) {
  assertConfigured();

  const account = await fetchJson(`${API_ROOT}/Accounts/${accountSid}.json`, {
    provider: 'Twilio',
    headers: authHeader(accountSid),
  }).catch((err) => {
    // 401/403 means the grant isn't usable (revoked, or the Connect App was
    // authorized without full API permission); 404 means the sid is bogus.
    const status = err.details?.status;
    if (status === 401 || status === 403 || status === 404) {
      throw AppError.badRequest(
        'Twilio would not accept the authorization for that account. Re-authorize the ' +
          'Connect App and make sure it is granted access to the Twilio APIs.',
        { code: 'TWILIO_CONNECT_NOT_AUTHORIZED', details: err.details?.body?.message }
      );
    }
    throw err;
  });

  return {
    accountSid: account?.sid ?? accountSid,
    friendlyName: account?.friendly_name ?? undefined,
    status: account?.status ?? undefined,
  };
}

/**
 * Find an SMS-capable number on the authorized account to send from.
 * Never throws — a connected account with no number yet is a legitimate
 * pending state, the user just has to buy or assign one.
 *
 * @param {string} accountSid
 * @returns {Promise<{ phoneNumber?: string }>}
 */
export async function discoverSendingNumber(accountSid) {
  try {
    const list = await fetchJson(
      `${API_ROOT}/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=50`,
      { provider: 'Twilio', headers: authHeader(accountSid) }
    );

    const numbers = list?.incoming_phone_numbers ?? [];
    const smsCapable = numbers.find((n) => n?.capabilities?.sms) ?? numbers[0];

    return smsCapable?.phone_number ? { phoneNumber: smsCapable.phone_number } : {};
  } catch {
    // Narrower grant or a Twilio hiccup — the connection is still valid, we
    // just couldn't auto-fill the sending number.
    return {};
  }
}
