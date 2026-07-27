// ============================================================
// Contacts controllers — HTTP <-> service translation. Thin by design.
// req.user is guaranteed by the `authenticate` middleware on these routes.
// ============================================================

import * as contactsService from './contacts.service.js';
import { fetchGoogleContacts } from './importers/google.importer.js';
import { parseContactsCsv } from './importers/csv.importer.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  const { data, pagination } = await contactsService.listContacts(req.user.id, req.query);
  res.status(200).json({ data, pagination });
});

export const getOne = asyncHandler(async (req, res) => {
  const contact = await contactsService.getContact(req.user.id, req.params.id);
  res.status(200).json({ data: contact });
});

export const create = asyncHandler(async (req, res) => {
  const contact = await contactsService.createContact(req.user.id, req.body);
  res.status(201).json({ message: 'Contact created', data: contact });
});

export const update = asyncHandler(async (req, res) => {
  const contact = await contactsService.updateContact(req.user.id, req.params.id, req.body);
  res.status(200).json({ message: 'Contact updated', data: contact });
});

export const remove = asyncHandler(async (req, res) => {
  const result = await contactsService.deleteContact(req.user.id, req.params.id);
  res.status(200).json({ message: 'Contact deleted', ...result });
});

/** GET /contacts/import/google — pulls from the connected Gmail account. */
export const importFromGoogle = asyncHandler(async (req, res) => {
  const { rows, account, fetched } = await fetchGoogleContacts(req.user.id);
  const summary = await contactsService.mergeImportedContacts(req.user.id, rows);

  res.status(200).json({
    message: `Imported from Google (${fetched} contacts read, ${rows.length} usable)`,
    source: 'google',
    account,
    ...summary,
  });
});

/** POST /contacts/import/csv — multipart upload, field name "file". */
export const importFromCsv = asyncHandler(async (req, res) => {
  const { rows, totalRows, skippedRows, headers } = parseContactsCsv(req.file.buffer);

  const summary = await contactsService.mergeImportedContacts(req.user.id, rows, {
    onDuplicate: req.body.onDuplicate,
  });

  res.status(200).json({
    message: `Imported ${req.file.originalname} (${totalRows} rows read)`,
    source: 'csv',
    file: req.file.originalname,
    detectedColumns: headers,
    rowsRead: totalRows,
    // Rows with no name AND no email/phone/handle — nothing to store.
    rowsUnusable: skippedRows,
    ...summary,
  });
});
