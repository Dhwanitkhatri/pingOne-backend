// ============================================================
// The catalogue of Contact fields a template variable can read.
//
// This is the only place that knows how a CONTACT_FIELD code maps onto a
// loaded Contact row. Adding a field means adding a resolver here, a code to
// CONTACT_FIELD in constants/codes.js, and a label to the frontend's
// constants/templates.js — nothing else needs to change, because both the
// Zod schema and the delivery worker read the registry rather than a list of
// their own.
// ============================================================

import { CONTACT_FIELD } from '../../constants/codes.js';

/**
 * Prisma `include` that loads everything the resolvers below need.
 *
 * Primary-first with `take: 1` mirrors recipient-resolver.js: a contact can
 * hold several addresses, and the primary one is what we'd send to, so it is
 * also the one worth putting in the message body.
 */
export const CONTACT_VARIABLE_INCLUDE = Object.freeze({
  emails: { orderBy: { isPrimary: 'desc' }, take: 1 },
  phones: { orderBy: { isPrimary: 'desc' }, take: 1 },
});

/** field code -> (contact loaded with CONTACT_VARIABLE_INCLUDE) => string | null */
const RESOLVERS = Object.freeze({
  [CONTACT_FIELD.FIRST_NAME]: (contact) => contact.firstName,
  [CONTACT_FIELD.LAST_NAME]: (contact) => contact.lastName,
  // lastName is optional on Contact, so a first-name-only contact must not
  // come out as "Aarav " with a trailing space.
  [CONTACT_FIELD.FULL_NAME]: (contact) =>
    [contact.firstName, contact.lastName].filter(Boolean).join(' '),
  [CONTACT_FIELD.EMAIL]: (contact) => contact.emails?.[0]?.email,
  [CONTACT_FIELD.PHONE]: (contact) => contact.phones?.[0]?.phone,
});

/** Every field code a `source: 'contact'` variable may name. */
export const CONTACT_FIELDS = Object.freeze(Object.keys(RESOLVERS));

/**
 * Read one field off a contact.
 *
 * @returns {string | null} null when the contact has nothing on file (no
 *   last name, no email) or the field code is unknown — callers decide
 *   whether that's a default-value case or a hard failure.
 */
export function resolveContactField(contact, field) {
  const resolver = RESOLVERS[field];
  if (!resolver) return null;

  const value = resolver(contact);
  // Normalise "" and whitespace to null: an empty string is not a usable
  // name, and treating it as one produces "Hi ,".
  return value != null && String(value).trim() !== '' ? String(value) : null;
}
