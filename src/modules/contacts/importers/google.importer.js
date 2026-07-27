// ============================================================
// Google Contacts import (People API).
//
// Uses the Gmail credential the user already connected: the stored
// secret is their OAuth refresh token, which is exchanged for a
// short-lived access token per import. The `contacts.readonly` scope is
// requested during /auth/google, so no extra consent is needed.
// ============================================================

import { fetchJson } from '../../../utils/httpClient.js';
import { AppError } from '../../../utils/AppError.js';
import { normalizePhone } from '../../../utils/validators.js';
import * as google from '../../platforms/providers/google.provider.js';
import * as platformsService from '../../platforms/platforms.service.js';

const CONNECTIONS_URL = 'https://people.googleapis.com/v1/people/me/connections';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers';
const PAGE_SIZE = 500;
const MAX_PAGES = 20; // 10k contacts is a generous ceiling for one import

/**
 * Fetch the user's Google contacts and normalise them into the shape
 * mergeImportedContacts() expects.
 *
 * @param {number} userId
 * @returns {Promise<{ rows: Array<object>, account: string | undefined, fetched: number }>}
 */
export async function fetchGoogleContacts(userId) {
  const credential = await platformsService.getDecryptedCredential(userId, 'gmail');

  let accessToken;
  try {
    ({ accessToken } = await google.getAccessToken(credential.secret));
  } catch (err) {
    // A revoked / expired grant is the common case — tell the user how to fix it.
    throw new AppError(
      err.statusCode === 502 ? 502 : 400,
      'Could not refresh your Google authorization. Reconnect Gmail at GET /auth/google.',
      { code: 'GOOGLE_REAUTH_REQUIRED', details: err.details }
    );
  }

  const people = [];
  let pageToken;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      personFields: PERSON_FIELDS,
      pageSize: String(PAGE_SIZE),
      sortOrder: 'LAST_MODIFIED_DESCENDING',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const payload = await fetchJson(`${CONNECTIONS_URL}?${params}`, {
      provider: 'Google People API',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    people.push(...(payload.connections ?? []));

    pageToken = payload.nextPageToken;
    if (!pageToken) break;
  }

  return {
    rows: people.map(toContactRow).filter(Boolean),
    account: credential.extraInfo?.gmail_address,
    fetched: people.length,
  };
}

/**
 * Map one People API `person` to an import row. Returns null for entries
 * with no usable name AND no contact detail — Google returns a fair
 * number of those from synced devices.
 */
function toContactRow(person) {
  const name = person.names?.[0] ?? {};

  const emails = (person.emailAddresses ?? [])
    .map((e) => e.value?.trim().toLowerCase())
    .filter((e) => e && e.length <= 255 && e.includes('@'));

  const phones = (person.phoneNumbers ?? [])
    .map((p) => normalizePhone(p.canonicalForm ?? p.value ?? ''))
    .filter((p) => /^\+[1-9]\d{6,14}$/.test(p));

  // Fall back to whatever identifies the person when there's no given name.
  const firstName =
    name.givenName?.trim() ||
    name.displayName?.trim() ||
    emails[0] ||
    phones[0] ||
    null;

  if (!firstName) return null;

  return {
    firstName: firstName.slice(0, 100),
    lastName: name.familyName?.trim()?.slice(0, 100) || null,
    emails,
    phones,
  };
}
