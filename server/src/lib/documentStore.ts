// Copyright 2025-2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Use is limited to qualifying small businesses. See LICENSE for terms.

/**
 * Storing and reading `client_documents` rows through the storage driver.
 *
 * One place so the Documents page, lead sheet attachments and "save the binder
 * to files" all produce identically-shaped rows and identically-laid-out keys.
 *
 * Backward compatibility rule: a row with `object_key IS NULL` is a LEGACY row
 * written before the driver existed. It is read straight from its absolute
 * `file_path` on local disk. Never rewrite those rows implicitly — the admin
 * migrate action is the only thing that moves them.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import type { Knex } from 'knex';
import { db } from '../db';
import { requireLink } from './clientFolders';
import {
  buildUniqueDocumentKeyUnder,
  getStorageConfig,
  getStorageDriver,
  getStorageDriverFor,
  fiscalYearFolder,
  StorageError,
  type StorageBackend,
} from './storage';

export interface FolderSection {
  id: number;
  name: string;
  sort_order: number;
  is_workpaper_target: boolean;
  is_default_upload: boolean;
}

async function sections(q: Knex | Knex.Transaction = db): Promise<FolderSection[]> {
  return q('storage_folder_template').orderBy('sort_order', 'asc') as Promise<FolderSection[]>;
}

/** The section flagged as the workpaper destination, or a sane fallback. */
export async function workpaperSection(q: Knex | Knex.Transaction = db): Promise<string> {
  const all = await sections(q);
  return (all.find((s) => s.is_workpaper_target) ?? all[0])?.name ?? 'Workpapers';
}

/** The section a manual upload lands in by default. */
export async function defaultUploadSection(q: Knex | Knex.Transaction = db): Promise<string> {
  const all = await sections(q);
  return (all.find((s) => s.is_default_upload) ?? all[0])?.name ?? 'Support';
}

export interface StoreDocumentInput {
  clientId: number;
  /** Null for a client-scoped document with no period. */
  periodId?: number | null;
  section?: string;
  /** Extra tier inside the year, e.g. 'Lead Sheets'. */
  subfolder?: string | null;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy?: number | null;
  linkedAccountId?: number | null;
  linkedJournalEntryId?: number | null;
}

export interface StoredDocument {
  id: number;
  object_key: string | null;
  storage_backend: StorageBackend;
  [k: string]: unknown;
}

/**
 * Write bytes to the store and insert the row.
 *
 * Storage first, then the DB — if the object write fails there is no row
 * pointing at nothing. If the DB insert fails afterwards the object is deleted
 * again, so a failed upload leaves nothing behind.
 */
export async function storeDocument(input: StoreDocumentInput): Promise<StoredDocument> {
  // An unlinked client is refused rather than having a folder invented for it.
  // The link's storage_path is then USED, not merely checked: re-deriving the
  // folder from the client's name would put files somewhere the link doesn't
  // point — which is what happens for a legacy backfilled link (`<id>/`), after
  // an admin picks a custom folder name, after a rename that verify re-bound,
  // or after the client is renamed in-app.
  const link = await requireLink(input.clientId);

  const client = await db('clients').where({ id: input.clientId }).first('id', 'name', 'tax_year_end', 'client_code');
  if (!client) throw new StorageError('Client not found', 'NOT_FOUND', 404);

  const cfg = await getStorageConfig();

  let fy = 'unknown-year';
  if (input.periodId) {
    const period = await db('periods')
      .where({ id: input.periodId })
      .first('start_date', 'end_date', 'period_name', 'folder_year');
    if (period) {
      fy = fiscalYearFolder({
        // An explicit label on the period wins over derivation.
        folderYear: period.folder_year as string | null,
        endDate: period.end_date as string | null,
        startDate: period.start_date as string | null,
        periodName: period.period_name as string | null,
        taxYearEnd: client.tax_year_end as string | null,
      }, cfg.yearFormat);
    }
  }

  const driver = await getStorageDriver();
  const section = input.section ?? (await defaultUploadSection());

  // A legacy row's folder is the bare uploads/<clientId>/ directory and has no
  // section/FY tiers; anything else gets the full layout under the bound path.
  const key = await buildUniqueDocumentKeyUnder(
    link.storage_path,
    {
      section: link.is_legacy_layout ? null : section,
      fiscalYear: link.is_legacy_layout ? null : fy,
      subfolder: input.subfolder ?? null,
      filename: input.filename,
    },
    async (k) => (await driver.head(k)) !== null,
  );

  const sha256 = crypto.createHash('sha256').update(input.buffer).digest('hex');
  const meta = await driver.put(key, input.buffer, { contentType: input.mimeType });

  try {
    const [row] = await db('client_documents').insert({
      client_id: input.clientId,
      period_id: input.periodId ?? null,
      filename: input.filename,
      file_path: null,
      file_size: input.buffer.length,
      file_type: input.mimeType,
      storage_backend: driver.kind,
      object_key: key,
      bucket: driver.kind === 'b2' ? cfg.b2?.bucket ?? null : null,
      sha256,
      etag: meta.etag,
      section,
      uploaded_by: input.uploadedBy ?? null,
      linked_account_id: input.linkedAccountId ?? null,
      linked_journal_entry_id: input.linkedJournalEntryId ?? null,
    }).returning('*');
    return row as StoredDocument;
  } catch (err) {
    // Compensating delete: never leave an object with no row pointing at it.
    await driver.delete(key).catch(() => undefined);
    throw err;
  }
}

export interface DocumentRow {
  id: number;
  client_id: number;
  filename: string;
  file_path: string | null;
  file_type: string | null;
  file_size: number | null;
  storage_backend: StorageBackend | null;
  object_key: string | null;
  [k: string]: unknown;
}

/** Legacy rows have no object_key and are read from their absolute disk path. */
export function isLegacyRow(doc: DocumentRow): boolean {
  return !doc.object_key;
}

const legacyUploadsRoot = (): string => process.env.UPLOADS_DIR || path.resolve(__dirname, '../../uploads');

/**
 * Open a document for reading, whichever backend and era it belongs to.
 * Streams — a 25 MB file buffered per concurrent download would bleed the Pi's
 * heap under load.
 */
export async function openDocument(doc: DocumentRow): Promise<{ body: Readable; sizeBytes: number }> {
  if (isLegacyRow(doc)) {
    // file_path is historical data — treat it as untrusted and re-check that it
    // sits under the uploads root, exactly as the original handler did.
    const root = legacyUploadsRoot();
    const resolved = path.resolve(doc.file_path ?? '');
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new StorageError('Path outside uploads root', 'FORBIDDEN', 403);
    }
    if (!fs.existsSync(resolved)) {
      throw new StorageError(
        'The file is missing from storage. It may not have been included in a backup this instance was restored from.',
        'FILE_MISSING',
        404,
      );
    }
    return { body: fs.createReadStream(resolved), sizeBytes: fs.statSync(resolved).size };
  }

  const driver = await getStorageDriverFor(doc.storage_backend);
  const got = await driver.get(doc.object_key!);
  return { body: got.body, sizeBytes: got.meta.sizeBytes };
}

/** Read a document fully into memory. Only for things that must be (PDF work). */
export async function readDocumentBuffer(doc: DocumentRow): Promise<Buffer> {
  const { body } = await openDocument(doc);
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

/** Overwrite an existing object in place, refreshing the row's size/hash/etag. */
export async function replaceDocumentBytes(doc: DocumentRow, buffer: Buffer): Promise<void> {
  if (isLegacyRow(doc)) {
    const root = legacyUploadsRoot();
    const resolved = path.resolve(doc.file_path ?? '');
    if (!resolved.startsWith(root + path.sep)) {
      throw new StorageError('Path outside uploads root', 'FORBIDDEN', 403);
    }
    await fs.promises.writeFile(resolved, buffer);
  } else {
    const driver = await getStorageDriverFor(doc.storage_backend);
    await driver.put(doc.object_key!, buffer, { contentType: doc.file_type ?? undefined });
  }
  await db('client_documents').where({ id: doc.id }).update({
    file_size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  });
}

/**
 * Remove the object, then the row.
 *
 * Storage first: if the object cannot be removed, the row must not be hidden —
 * an admin would otherwise believe the file is gone while it still exists and
 * still bills.
 */
export async function deleteDocument(doc: DocumentRow): Promise<void> {
  if (isLegacyRow(doc)) {
    const root = legacyUploadsRoot();
    const resolved = path.resolve(doc.file_path ?? '');
    if ((resolved.startsWith(root + path.sep) || resolved === root) && fs.existsSync(resolved)) {
      await fs.promises.rm(resolved, { force: true });
    }
  } else {
    const driver = await getStorageDriverFor(doc.storage_backend);
    await driver.delete(doc.object_key!);
  }
  await db('client_documents').where({ id: doc.id }).delete();
}
