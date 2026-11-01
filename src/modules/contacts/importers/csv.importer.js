// ============================================================
// CSV contact import.
//
// The file MUST have a header row, but the column names are flexible —
// headers are normalised (lowercased, punctuation stripped) and matched
// by alias, so exports from Google, Outlook and hand-made sheets all work:
//
//   First Name,Last Name,Email,Phone,Telegram
//   Ada,Lovelace,ada@example.com,+14155550100,@ada
//
// Any column containing "email" / "phone" is picked up, so E-mail 1,
// E-mail 2, Mobile Phone … all land on the same contact. Multiple values
// in one cell can be separated by ";" or "|".
//
// The column separator is detected from the header row: Excel in many
// locales (most of Europe) saves "CSV" with ";", and tab-separated exports
// are common too. In a ";"-separated file, use "|" for multiple values.
// ============================================================

import { parse } from 'csv-parse/sync';
import { AppError } from '../../../utils/AppError.js';
import { normalizePhone } from '../../../utils/validators.js';
import { PLATFORM_CODES } from '../../../utils/platforms.js';

const MAX_ROWS = 2000;
const MULTI_VALUE_SEPARATOR = /[;|]/;

const FIRST_NAME_KEYS = ['firstname', 'first', 'givenname', 'forename'];
const LAST_NAME_KEYS = ['lastname', 'last', 'surname', 'familyname'];
const FULL_NAME_KEYS = ['name', 'fullname', 'displayname', 'contactname'];

/** Lowercase and strip everything that isn't a letter or digit. */
const normalizeHeader = (header) => String(header).toLowerCase().replace(/[^a-z0-9]/g, '');

const DELIMITERS = [',', ';', '\t'];

/**
 * Pick the separator that splits the header row into the most columns,
 * ignoring anything inside quotes. Ties and a one-column header stay ",".
 * Without this, "Name;Email" parses as one column whose cells hold the
 * whole line — the email ends up as part of the contact's name.
 */
function detectDelimiter(buffer) {
  const headerLine = buffer.toString('utf8', 0, Math.min(buffer.length, 4096)).split(/\r?\n/, 1)[0];
  const counts = Object.fromEntries(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (const char of headerLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char in counts) counts[char] += 1;
  }
  return DELIMITERS.reduce((best, d) => (counts[d] > counts[best] ? d : best), ',');
}

/**
 * Parse an uploaded CSV buffer into import rows.
 *
 * @param {Buffer} buffer
 * @returns {{ rows: Array<object>, totalRows: number, skippedRows: number, headers: string[] }}
 */
export function parseContactsCsv(buffer) {
  let records;
  try {
    records = parse(buffer, {
      delimiter: detectDelimiter(buffer),
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true, // ragged rows shouldn't kill the whole import
      columns: (header) => header.map(normalizeHeader),
      columns_duplicates_to_array: true, // "Email" twice -> array, nothing lost
    });
  } catch (err) {
    throw AppError.badRequest(`Could not parse the CSV file: ${err.message}`, {
      code: 'CSV_PARSE_ERROR',
    });
  }

  if (!records.length) {
    throw AppError.badRequest('The CSV file has a header but no data rows', {
      code: 'CSV_EMPTY',
    });
  }

  const headers = Object.keys(records[0]);
  if (!headers.some(isRecognisedHeader)) {
    throw AppError.badRequest(
      'No recognised columns found. Expected a header row with at least a name, email or phone column.',
      { code: 'CSV_NO_KNOWN_COLUMNS', details: { detectedColumns: headers } }
    );
  }

  if (records.length > MAX_ROWS) {
    throw AppError.badRequest(
      `That file has ${records.length} rows — the limit is ${MAX_ROWS} per import. Split it and upload again.`,
      { code: 'CSV_TOO_MANY_ROWS' }
    );
  }

  const rows = [];
  let skippedRows = 0;

  for (const record of records) {
    const row = toContactRow(record);
    if (row) rows.push(row);
    else skippedRows += 1;
  }

  return { rows, totalRows: records.length, skippedRows, headers };
}

function isRecognisedHeader(header) {
  return (
    FIRST_NAME_KEYS.includes(header) ||
    LAST_NAME_KEYS.includes(header) ||
    FULL_NAME_KEYS.includes(header) ||
    header.includes('email') ||
    header.includes('phone') ||
    header.includes('mobile') ||
    header.includes('cell') ||
    PLATFORM_CODES.includes(header)
  );
}

/** Turn one parsed CSV record into an import row, or null if unusable. */
function toContactRow(record) {
  const emails = collect(record, (h) => h.includes('email'))
    .map((v) => v.toLowerCase())
    .filter((v) => v.includes('@') && v.length <= 255);

  const phones = collect(
    record,
    (h) => h.includes('phone') || h.includes('mobile') || h.includes('cell')
  )
    .map(normalizePhone)
    .filter((v) => /^\+[1-9]\d{6,14}$/.test(v));

  const handles = PLATFORM_CODES.flatMap((platform) => {
    const [handle] = collect(record, (h) => h === platform);
    return handle ? [{ platform, handle: handle.slice(0, 255) }] : [];
  });

  let firstName = first(collect(record, (h) => FIRST_NAME_KEYS.includes(h)));
  let lastName = first(collect(record, (h) => LAST_NAME_KEYS.includes(h)));

  // Only a single "Name" column? Split it on the first space.
  if (!firstName) {
    const fullName = first(collect(record, (h) => FULL_NAME_KEYS.includes(h)));
    if (fullName) {
      const spaceAt = fullName.indexOf(' ');
      firstName = spaceAt === -1 ? fullName : fullName.slice(0, spaceAt);
      lastName = lastName ?? (spaceAt === -1 ? null : fullName.slice(spaceAt + 1).trim());
    }
  }

  // Nameless rows still import if they carry a way to reach the person.
  firstName = firstName ?? emails[0] ?? phones[0] ?? handles[0]?.handle;
  if (!firstName) return null;

  // A row with a name but no way to contact them is not worth importing.
  if (!emails.length && !phones.length && !handles.length) return null;

  return {
    firstName: firstName.slice(0, 100),
    lastName: lastName ? lastName.slice(0, 100) : null,
    emails: [...new Set(emails)],
    phones: [...new Set(phones)],
    handles,
  };
}

/**
 * Gather every value whose (normalised) header matches, flattening the
 * arrays produced by duplicate headers and splitting multi-value cells.
 */
function collect(record, matches) {
  const values = [];

  for (const [header, cell] of Object.entries(record)) {
    if (!matches(header)) continue;

    for (const value of Array.isArray(cell) ? cell : [cell]) {
      if (typeof value !== 'string') continue;
      for (const part of value.split(MULTI_VALUE_SEPARATOR)) {
        const trimmed = part.trim();
        if (trimmed) values.push(trimmed);
      }
    }
  }

  return values;
}

const first = (values) => values[0] ?? null;
